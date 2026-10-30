"""Point d'entrée de l'application FastAPI Colab AI Studio (app/main.py).

Serveur léger orchestrant l'API, les websockets/SSE, les contrôleurs REST
et la distribution des fichiers statiques de la SPA React.
"""

from __future__ import annotations

from contextlib import asynccontextmanager, suppress
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.routes_agent_instructions import router as agent_instructions_router
from app.api.routes_characters import router as characters_router
from app.api.routes_config import router as config_router
from app.api.routes_crud import router as crud_router
from app.api.routes_generation import get_task_orchestrator
from app.api.routes_generation import router as generation_router
from app.api.routes_llm_proxy import router as llm_proxy_router
from app.api.routes_mcp import router as mcp_router
from app.api.routes_models import get_worker_gateway
from app.api.routes_models import router as models_router
from app.api.routes_sqlite_resources import router as resources_router
from app.api.routes_story_director import router as story_director_router
from app.config import DATA_DIR, GENERATIONS_FILE, ensure_directories
from app.models.domain import TaskStatus
from app.services.system_info import get_host_system_metrics
from app.services.worker_gateway import WorkerGateway
from app.storage.json_store import CorruptedDocumentStoreError, JSONDocumentStore
from app.storage.sqlite_repository import get_hilo_sqlite_repo


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Démarrage
    ensure_directories()
    store = JSONDocumentStore(DATA_DIR)
    async with store.lock_for(GENERATIONS_FILE.name):
        gens = await store.read_list_unlocked(GENERATIONS_FILE.name)
        modified = False
        for g in gens:
            if g.get("status") in {TaskStatus.PENDING.value, TaskStatus.RUNNING.value}:
                g["status"] = TaskStatus.FAILED.value
                g["errorMessage"] = "Interrompue par redémarrage du serveur"
                modified = True
        if modified:
            await store.write_list_unlocked(GENERATIONS_FILE.name, gens)

    with suppress(Exception):
        await get_hilo_sqlite_repo().initialize()

    try:
        yield
    finally:
        with suppress(Exception):
            await get_hilo_sqlite_repo().close()
        with suppress(Exception):
            await get_task_orchestrator().aclose()
        with suppress(Exception):
            await get_worker_gateway().aclose()


app = FastAPI(
    title="Colab AI Studio",
    description="Backend local ultra-léger et tour de contrôle de génération multimédia hybride",
    version="1.0.0",
    lifespan=lifespan,
)

_ORIGINS = [f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (5173, 8000, 8190)]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(CorruptedDocumentStoreError)
async def corrupted_store_exception_handler(
    request: Request, exc: CorruptedDocumentStoreError
) -> JSONResponse:
    return JSONResponse(
        status_code=500,
        content={"detail": f"Stockage de données corrompu : {exc}"},
    )


app.include_router(crud_router)
app.include_router(characters_router)
app.include_router(agent_instructions_router)
app.include_router(models_router)
app.include_router(config_router)
app.include_router(generation_router)
app.include_router(llm_proxy_router)
app.include_router(mcp_router)
app.include_router(resources_router)
app.include_router(story_director_router)


@app.get("/api/health", tags=["Diagnostic"])
async def health_check(
    gateway: WorkerGateway = Depends(get_worker_gateway),
) -> dict[str, Any]:
    worker_health = await gateway.health()
    return {
        "status": "healthy",
        "service": "Colab AI Studio Local Backend",
        "version": "1.0.0",
        "host": get_host_system_metrics(),
        **worker_health,
    }
