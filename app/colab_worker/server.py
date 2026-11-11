"""Serveur FastAPI du Worker Google Colab (app/colab_worker/server.py).

Expose l'ensemble des routes d'inférence, de contrôle et de streaming SSE
consommées par le backend local Colab AI Studio :
- GET /health
- GET /models
- POST /models/switch
- POST /infer
- GET /tasks/{task_id}/status
- POST /tasks/{task_id}/cancel
- POST /v1/chat/completions
- POST /v1/chat/cancel
- GET /files/{filename}
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import re
import secrets
import shutil
import struct
import subprocess
import tempfile
import time
import uuid
import zlib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel, Field, field_validator

from app.colab_worker.model_swapper import ModelSwapper

logger = logging.getLogger(__name__)


def _model_spec(
    mid: str,
    name: str,
    mtype: str,
    ratios: list[str],
    res: list[str],
    dur: list[str],
    neg: bool = False,
    seed: bool = False,
    img_ref: bool = False,
    max_refs: int = 0,
    badge: str | None = None,
    description: str | None = None,
    supports_first_frame: bool = True,
    supports_last_frame: bool = True,
) -> dict[str, Any]:
    """Construit la spécification et les capacités déclaratives d'un modèle."""
    spec: dict[str, Any] = {
        "id": mid,
        "name": name,
        "type": mtype,
        "capabilities": {
            "aspectRatios": ratios,
            "resolutions": res,
            "durations": dur,
            "supportsNegativePrompt": neg,
            "supportsSeed": seed,
            "supportsImageRef": True if mtype in ("lipsync", "lip_sync") else img_ref,
            "maxImageRefs": 1 if mtype in ("lipsync", "lip_sync") else max_refs,
            "supportsVideoRef": mtype in ("lipsync", "lip_sync"),
            "maxVideoRefs": 1 if mtype in ("lipsync", "lip_sync") else 0,
            "supportsAudio": mtype in ("lipsync", "lip_sync"),
            "supportsFirstFrame": supports_first_frame
            if mtype in ("video", "lipsync", "lip_sync")
            else False,
            "supportsLastFrame": supports_last_frame
            if mtype in ("video", "lipsync", "lip_sync")
            else False,
        },
    }
    if badge:
        spec["badge"] = badge
    if description:
        spec["description"] = description
    return spec


async def _get_bionic_endpoint() -> tuple[str | None, list[str]]:
    """Détecte l'URL de base et les modèles servis localement par Bionic (LM Studio)."""
    candidates = ["http://127.0.0.1:1235/v1"]
    ip_bin = shutil.which("ip")
    if ip_bin:
        with contextlib.suppress(Exception):

            def _get_def_route() -> str:
                return subprocess.check_output(
                    [ip_bin, "route", "show", "default"], text=True, timeout=1.0
                )

            out = await asyncio.to_thread(_get_def_route)
            parts = out.split()
            if "via" in parts:
                idx = parts.index("via")
                candidates.append(f"http://{parts[idx + 1]}:1235/v1")

    async with httpx.AsyncClient(timeout=0.8) as client:
        for base in candidates:
            try:
                r = await client.get(f"{base}/models")
                if r.status_code == 200:
                    models = [m["id"] for m in r.json().get("data", [])]
                    return base, models
            except Exception as exc:
                logger.debug("Bionic non joignable sur %s: %s", base, exc)
    return None, []


def _resolve_bionic_model_target(model_name: str, available_bionic_models: list[str]) -> str:
    """Associe l'identifiant demandé dans le Studio au modèle chargé dans Bionic."""
    low = model_name.lower()
    if any(k in low for k in ("3.8", "27b", "turbo", "fusion", "coder")):
        for m in available_bionic_models:
            if "3.8" in m.lower() or "27b" in m.lower():
                return m
    for m in available_bionic_models:
        if "3.5" in m.lower() or "defiant" in m.lower():
            return m
    return available_bionic_models[0] if available_bionic_models else model_name


def _discover_local_models() -> list[dict[str, Any]]:
    """Détecte les modèles présents localement sur la machine (ComfyUI, LM Studio, etc.)."""
    local_models = []
    comfy_dir = Path("/home/instructeur/ComfyUI/models")
    lmstudio_dir = Path("/mnt/c/Users/HP/.lmstudio/models")
    heretique_dir = Path("/mnt/c/Users/HP/OneDrive/Documents/Hérétique")

    # 1. MiniMax H3 Video (INT8)
    if (comfy_dir / "diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors").exists():
        local_models.append(
            _model_spec(
                "minimax-h3",
                "MiniMax H3 Video",
                "video",
                ["16:9", "9:16", "1:1"],
                ["720p", "1080p"],
                ["5s", "10s", "auto"],
                neg=True,
                seed=True,
                img_ref=True,
                max_refs=2,
                badge="Local",
                description="Modèle vidéo local MiniMax H3 (INT8)",
            )
        )

    # 2. NoctQ V4 Cinema (Image)
    if (comfy_dir / "diffusion_models/NoctQ_V4_int8_convrot.safetensors").exists():
        local_models.append(
            _model_spec(
                "noctq-v4",
                "NoctQ V4 Cinema",
                "image",
                ["16:9", "9:16", "1:1", "4:3", "3:4"],
                ["1024x1024", "1536x1024", "1024x1536"],
                ["1s"],
                neg=True,
                seed=True,
                img_ref=True,
                max_refs=1,
                badge="Local",
                description="Modèle cinématique d'image haute fidélité NoctQ V4 (INT8)",
            )
        )

    # 3. Qwen Image 2.1
    has_qwen_vae = (comfy_dir / "vae/qwen_image_2.1_vae_bf16.safetensors").exists()
    has_qwen_te = (
        comfy_dir / "text_encoders/qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors"
    ).exists()
    if has_qwen_vae or has_qwen_te:
        local_models.append(
            _model_spec(
                "qwen-image-2.1",
                "Qwen Image 2.1",
                "image",
                ["1:1", "16:9", "9:16", "4:3", "3:4"],
                ["1024x1024", "768x768", "512x512"],
                ["1s"],
                neg=True,
                seed=True,
                img_ref=True,
                max_refs=1,
                badge="Local",
                description="Générateur d'images haute fidélité Qwen 2.1",
            )
        )

    # 4. LLM : Qwen 3.5 9B The Defiant Fable Uncensored Heretic NEO iMatrix Max MTP
    defiant_fable_gguf = (
        lmstudio_dir
        / "DavidAU/Qwen3.5-9B-The-Defiant-Fable-Uncensored-Heretic-NEO-IMATRIX-MAX-MTP-GGUF"
        / "Qwen3.5-9B-The-Defiant-Fable-Uncnr-Heretic-plusIQ-TOOLS-NEO-MAX-MTP-Q6_K.gguf"
    )
    if defiant_fable_gguf.exists() or has_qwen_te:
        local_models.append(
            _model_spec(
                "qwen3.5-9b-defiant-fable",
                "Qwen 3.5 9B Defiant Fable Heretic",
                "text",
                [],
                [],
                [],
                neg=False,
                seed=False,
                badge="Local",
                description="Qwen 3.5 9B Defiant Fable Heretic NEO iMatrix Max MTP (GGUF Q6_K)",
            )
        )

    # 5. LLM : Qwen 3.8 27B Turbo Fable Cold Fusion Heretic Uncensored NEO Coder Max MTP
    turbo_dir_name = (
        "DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-"
        "NEO-CODER-MAX-MTP-GGUF"
    )
    turbo_file_name = "Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-IQ3_M.gguf"
    qwen_27b_gguf = lmstudio_dir / turbo_dir_name / turbo_file_name
    if qwen_27b_gguf.exists():
        local_models.append(
            _model_spec(
                "qwen3.8-27b-turbo-fusion",
                "Qwen 3.8 27B Turbo Fusion Heretic",
                "text",
                [],
                [],
                [],
                neg=False,
                seed=False,
                badge="Local",
                description="Qwen 3.8 27B Turbo Fusion Heretic Uncensored NEO Coder (GGUF IQ3_M)",
            )
        )

    # 6. LLM : Qwen 3 VL 32B Heretic
    qwen_heretic_path = (
        comfy_dir
        / "text_encoders"
        / "H3"
        / "qwen3vl_32b_h3_ultra_uncensored_heretic_int8_convrot.safetensors"
    )
    if qwen_heretic_path.exists():
        local_models.append(
            _model_spec(
                "qwen-3-vl-32b",
                "Qwen 3 VL 32B Heretic",
                "text",
                [],
                [],
                [],
                neg=False,
                seed=False,
                badge="Local",
                description="Grand modèle multimodal local débloqué (32B INT8)",
            )
        )

    # 7. Upscale : Topaz Gigapixel AI Pro
    has_topaz = (heretique_dir / "Topaz Gigapixel Pro 1.3.2 (x64).rar").exists() or Path(
        "/mnt/c/Program Files/Topaz Labs LLC"
    ).exists()
    if has_topaz:
        local_models.append(
            _model_spec(
                "topaz-gigapixel-pro",
                "Topaz Gigapixel AI Pro",
                "upscale",
                ["16:9", "9:16", "1:1", "4:3", "3:4"],
                ["1080p", "4K", "8K"],
                ["5s", "10s"],
                badge="Local",
                description="Moteur Upscale IA Pro (Gigapixel RTX GPU)",
            )
        )

    # 8. Upscale : Real-ESRGAN x4 Ultra 4K
    local_models.append(
        _model_spec(
            "realesrgan-x4-local",
            "Real-ESRGAN x4 Ultra 4K",
            "upscale",
            ["16:9", "9:16", "1:1"],
            ["1080p", "4K"],
            ["5s"],
            badge="Local",
            description="Upscaler local ultra-rapide sur cœurs Tensor RTX 5000 Ada",
        )
    )

    # 9. Lip Sync : LatentSync Video Dubbing (Prioritaire pour doublage vidéo + portrait)
    local_models.append(
        _model_spec(
            "latentsync",
            "LatentSync Video Dubbing",
            "lipsync",
            ["16:9", "9:16", "1:1"],
            ["720p", "1080p"],
            ["5s", "10s", "15s"],
            img_ref=True,
            max_refs=1,
            badge="Local",
            description="Synchronisation labiale cinéma sur vidéo ou portrait (RTX 5000 Ada)",
        )
    )

    # 10. Lip Sync : LivePortrait Audio Avatar
    local_models.append(
        _model_spec(
            "liveportrait",
            "LivePortrait Audio Avatar",
            "lipsync",
            ["1:1", "16:9", "9:16", "4:3", "3:4"],
            ["720p", "1080p"],
            ["5s", "10s", "15s", "30s"],
            img_ref=True,
            max_refs=1,
            badge="Local",
            description="Animation portrait temps réel haute fidélité par audio (RTX 5000 Ada)",
        )
    )

    return local_models


AVAILABLE_MODELS: list[dict[str, Any]] = [
    *_discover_local_models(),
    _model_spec(
        "flux-schnell",
        "FLUX.1 [schnell]",
        "image",
        ["1:1", "16:9", "9:16", "4:3", "3:4"],
        ["1024x1024", "768x768", "512x512"],
        ["1s"],
        False,
        True,
        True,
        1,
    ),
    _model_spec(
        "wan-2.1-t2v",
        "Wan 2.1 Video",
        "video",
        ["16:9", "9:16", "1:1"],
        ["720p", "480p"],
        ["5s", "10s", "auto"],
        True,
        True,
        True,
        2,
    ),
    _model_spec(
        "cogvideox-5b",
        "CogVideoX-5B",
        "video",
        ["16:9"],
        ["720p"],
        ["6s"],
        neg=True,
        seed=True,
    ),
    _model_spec(
        "wav2lip",
        "Wav2Lip Lip Sync",
        "lipsync",
        ["16:9", "9:16", "1:1"],
        ["720p"],
        ["5s", "10s", "15s"],
    ),
    _model_spec(
        "realesrgan-x4",
        "Real-ESRGAN Upscaler",
        "upscale",
        ["16:9", "9:16", "1:1"],
        ["1080p", "4K"],
        ["5s"],
    ),
    _model_spec("llama-3-8b-instruct", "Llama 3 8B Instruct", "text", [], [], []),
]


def make_valid_png(
    width: int = 64, height: int = 64, color: tuple[int, int, int] = (30, 41, 59)
) -> bytes:
    """Génère un flux d'octets PNG valide et conforme à la spécification ISO/IEC 15948."""
    png_sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    ihdr_crc = struct.pack(">I", zlib.crc32(b"IHDR" + ihdr_data))
    ihdr = struct.pack(">I", len(ihdr_data)) + b"IHDR" + ihdr_data + ihdr_crc
    row = b"\x00" + bytes(color) * width
    raw_data = row * height
    idat_content = zlib.compress(raw_data)
    idat_crc = struct.pack(">I", zlib.crc32(b"IDAT" + idat_content))
    idat = struct.pack(">I", len(idat_content)) + b"IDAT" + idat_content + idat_crc
    iend_crc = struct.pack(">I", zlib.crc32(b"IEND"))
    iend = struct.pack(">I", 0) + b"IEND" + iend_crc
    return png_sig + ihdr + idat + iend


def make_valid_mp4() -> bytes:
    """Génère ou charge un conteneur MP4 H.264 valide et lisible."""
    for p in (
        Path(__file__).resolve().parent / "sample_video.mp4",
        Path("data/assets/sample_video.mp4"),
    ):
        if p.is_file():
            return p.read_bytes()
    ftyp = struct.pack(">I", 28) + b"ftypisom\x00\x00\x02\x00isomiso2mp41"
    mvhd = (
        struct.pack(">I", 108)
        + b"mvhd"
        + b"\x00" * 12
        + struct.pack(">II", 1000, 1000)
        + b"\x00" * 80
    )
    moov = struct.pack(">I", 8 + len(mvhd)) + b"moov" + mvhd
    mdat = struct.pack(">I", 72) + b"mdat" + b"\x00" * 64
    return ftyp + moov + mdat


def _resolve_safe_output_path(base_dir: Path, filename: str) -> Path:
    """Résout et valide qu'un chemin cible reste strictement confiné dans base_dir."""
    root = os.path.realpath(str(base_dir))
    norm_path = os.path.realpath(os.path.join(root, filename))
    if not norm_path.startswith(root + os.sep):
        raise ValueError("Tentative d'écriture hors du répertoire de sortie sécurisé")
    return Path(norm_path)


def _write_output_bytes(target: Path, data: bytes) -> None:
    """Écrit un flux d'octets dans un chemin de sortie préalablement validé."""
    target.write_bytes(data)


def _resolve_existing_output_file(base_dir: Path, filename: str) -> Path | None:
    """Résout et vérifie l'existence d'un fichier confiné dans base_dir."""
    root = os.path.realpath(str(base_dir))
    norm_path = os.path.realpath(os.path.join(root, filename))
    if not norm_path.startswith(root + os.sep):
        raise HTTPException(status_code=400, detail="Chemin de fichier interdit")
    target = Path(norm_path)
    return target if target.is_file() else None


class SwitchModelRequest(BaseModel):
    modelId: str


class InferRequest(BaseModel):
    taskId: str | None = None
    modelId: str
    type: str | None = None
    prompt: str = ""
    negativePrompt: str | None = None
    parameters: dict[str, Any] = Field(default_factory=dict)
    references: dict[str, Any] = Field(default_factory=dict)
    steps: int | None = None

    @field_validator("taskId")
    @classmethod
    def validate_task_id(cls, v: str | None) -> str | None:
        """Valide la structure alphanumérique de l'identifiant de tâche."""
        if v is not None and not re.match(r"^[a-zA-Z0-9_-]+$", v):
            raise ValueError(
                "taskId doit contenir uniquement des caractères alphanumériques, "
                "tirets ou underscores"
            )
        return v


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "llama-3-8b-instruct"
    messages: list[ChatMessage]
    stream: bool = True
    requestId: str | None = None
    temperature: float | None = 0.7
    max_tokens: int | None = None


class ChatCancelRequest(BaseModel):
    requestId: str


def create_worker_app(
    model_swapper: ModelSwapper | None = None,
    storage_dir: Path | None = None,
    worker_secret: str | None = None,
    idle_check_interval: float = 1.0,
    model_loaders: dict[str, Any] | None = None,
    simulation_mode: bool | None = None,
) -> FastAPI:
    """Fabrique d'application FastAPI pour le worker Google Colab."""
    swapper = model_swapper or ModelSwapper()
    output_dir = storage_dir or (Path(tempfile.gettempdir()) / "colab_outputs")
    output_dir.mkdir(parents=True, exist_ok=True)
    secret = worker_secret or os.environ.get("COLAB_STUDIO_SECRET")
    loaders = model_loaders or {}
    sim_mode = (
        simulation_mode
        if simulation_mode is not None
        else (os.environ.get("COLAB_STUDIO_SIMULATION", "1" if not loaders else "0") == "1")
    )

    tasks: dict[str, dict[str, Any]] = {}
    cancel_events: dict[str, asyncio.Event] = {}
    active_chat_cancels: set[str] = set()
    gpu_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        stop_event = asyncio.Event()

        async def _idle_checker():
            while not stop_event.is_set():
                try:
                    await asyncio.sleep(idle_check_interval)
                    busy = any(t.get("status") == "running" for t in tasks.values())
                    if not busy and not gpu_lock.locked():
                        swapper.check_idle_timeout()
                except asyncio.CancelledError:
                    break
                except Exception as exc:
                    logger.debug("Erreur lors de la vérification d'inactivité du worker : %s", exc)

        checker_task = asyncio.create_task(_idle_checker())
        try:
            yield
        finally:
            stop_event.set()
            checker_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await checker_task

    app = FastAPI(title="Colab AI Studio Worker", version="1.0.0", lifespan=lifespan)

    origins = [f"http://{h}:{p}" for h in ("localhost", "127.0.0.1") for p in (5173, 8000, 8190)]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        """Intercepte les requêtes pour vérifier le secret du worker."""
        if request.method == "OPTIONS":
            return await call_next(request)

        if secret:
            auth = request.headers.get("authorization", "")
            x_sec = request.headers.get("x-colab-secret", "")
            q_sec = request.query_params.get("secret", "")
            bearer = auth[7:].strip() if auth.startswith("Bearer ") else ""
            if secret not in (x_sec, bearer, q_sec):
                return JSONResponse(status_code=401, content={"detail": "Non autorisé"})
        return await call_next(request)

    @app.get("/health")
    async def health_check() -> dict[str, Any]:
        """Retourne l'état de santé et la télémétrie GPU/VRAM du worker."""
        return {"status": "ok", **swapper.get_telemetry()}

    @app.get("/models")
    async def list_models() -> list[dict[str, Any]]:
        """Retourne la liste des modèles disponibles sur le worker."""
        return AVAILABLE_MODELS

    def _prepare_pipeline_kwargs(p: InferRequest) -> dict[str, Any]:
        """Convertit les paramètres de requête en arguments pour le pipeline d'inférence."""
        raw = dict(p.parameters)
        ratio = raw.pop("aspectRatio", "1:1")
        raw.pop("duration", None)
        res = raw.pop("resolution", None)
        tbl: dict[str, dict[str, tuple[int, int]]] = {
            "16:9": {
                "512x512": (512, 288),
                "768x768": (768, 432),
                "1024x1024": (1024, 576),
                "480p": (854, 480),
                "720p": (1280, 720),
                "1080p": (1920, 1080),
                "4K": (3840, 2160),
            },
            "9:16": {
                "512x512": (288, 512),
                "768x768": (432, 768),
                "1024x1024": (576, 1024),
                "480p": (480, 854),
                "720p": (720, 1280),
                "1080p": (1080, 1920),
                "4K": (2160, 3840),
            },
            "4:3": {"512x512": (512, 384), "768x768": (768, 576), "1024x1024": (1024, 768)},
            "3:4": {"512x512": (384, 512), "768x768": (576, 768), "1024x1024": (768, 1024)},
            "1:1": {
                "512x512": (512, 512),
                "768x768": (768, 768),
                "1024x1024": (1024, 1024),
                "480p": (480, 480),
                "720p": (720, 720),
                "1080p": (1080, 1080),
            },
        }
        fb = {"16:9": (1024, 576), "9:16": (576, 1024), "4:3": (1024, 768), "3:4": (768, 1024)}
        wh = tbl.get(ratio, {}).get(res) or fb.get(ratio, (1024, 1024))
        kw = {"width": wh[0], "height": wh[1], **raw}
        if p.prompt:
            kw["prompt"] = p.prompt
        if p.negativePrompt:
            kw["negative_prompt"] = p.negativePrompt
        return kw

    @app.post("/models/switch")
    async def switch_model(payload: SwitchModelRequest) -> dict[str, Any]:
        """Charge ou permute le modèle actif en VRAM sous verrou GPU."""
        async with gpu_lock:
            swapper.ensure_model(payload.modelId, load_fn=loaders.get(payload.modelId))
        return {"status": "ok", "activeModel": payload.modelId}

    async def _is_comfyui_available() -> bool:
        """Vérifie si le backend ComfyUI local est actif."""
        try:
            async with httpx.AsyncClient(timeout=1.0) as client:
                r = await client.get("http://127.0.0.1:8188/system_stats")
                return r.status_code == 200
        except Exception:
            return False

    def _load_workflow_graph(wf_path: Path) -> dict[str, Any]:
        """Charge un workflow JSON depuis le disque."""
        if not wf_path.exists():
            raise FileNotFoundError(f"Workflow introuvable: {wf_path}")
        with open(wf_path, encoding="utf-8") as f:
            return json.load(f)

    async def _extract_last_frame_ffmpeg(mp4_path: Path, output_png_path: Path) -> None:
        """Extrait la dernière image d'un MP4 pour conditionner le plan I2V suivant."""
        from app.services.video_frames import extract_last_frame

        await extract_last_frame(mp4_path, output_png_path)

    async def _submit_and_wait_comfyui(
        graph: dict[str, Any],
        comfy_base: str,
        task_id: str,
        cancel_event: asyncio.Event,
        expected_prefix: str,
    ) -> Path:
        """Soumet un workflow à ComfyUI et attend sa complétion en gérant l'annulation."""
        client_id = f"worker_{task_id}"
        req_body = {"prompt": graph, "client_id": client_id}

        async with httpx.AsyncClient(timeout=15.0) as client:
            try:
                r = await client.post(f"{comfy_base}/prompt", json=req_body)
                if r.status_code != 200:
                    err_msg = r.text
                    with contextlib.suppress(Exception):
                        err_json = r.json()
                        if "node_errors" in err_json and err_json["node_errors"]:
                            err_msg = str(err_json["node_errors"])
                        elif "error" in err_json:
                            err_msg = str(err_json["error"])
                    raise RuntimeError(f"ComfyUI ({r.status_code}): {err_msg}")
                res = r.json()
            except Exception as exc:
                raise RuntimeError(f"Échec de soumission à ComfyUI ({comfy_base}): {exc}") from exc

        pid = res.get("prompt_id")
        if not pid:
            err = res.get("error") or res.get("node_errors") or "Pas de prompt_id retourné"
            raise RuntimeError(f"Erreur rejet ComfyUI: {err}")

        tasks[task_id]["promptId"] = pid

        poll_count = 0
        while True:
            if cancel_event.is_set():
                async with httpx.AsyncClient(timeout=5.0) as client:
                    with contextlib.suppress(Exception):
                        await client.post(f"{comfy_base}/interrupt")
                raise asyncio.CancelledError("Annulée par l'utilisateur")

            async with httpx.AsyncClient(timeout=5.0) as client:
                try:
                    hr = await client.get(f"{comfy_base}/history/{pid}")
                    hist = hr.json() if hr.status_code == 200 else {}
                except Exception as e:
                    logger.warning("Erreur polling ComfyUI history: %s", e)
                    hist = {}

            if pid in hist:
                item = hist[pid]
                status_obj = item.get("status", {})
                status_str = status_obj.get("status_str", "")
                if status_str != "success":
                    msgs = status_obj.get("messages", [])
                    raise RuntimeError(f"Échec du rendu ComfyUI ({status_str}): {msgs}")

                outputs = item.get("outputs", {})

                def _locate_output(raw_out: dict[str, Any], prefix: str) -> Path | None:
                    for _nid, n_out in raw_out.items():
                        if "videos" in n_out and n_out["videos"]:
                            v = n_out["videos"][0]
                            subf = v.get("subfolder", "")
                            fn = v.get("filename", "")
                            p = Path("/home/instructeur/ComfyUI/output") / subf / fn
                            if p.exists():
                                return p
                        if "images" in n_out and n_out["images"]:
                            img = n_out["images"][0]
                            subf = img.get("subfolder", "")
                            fn = img.get("filename", "")
                            p = Path("/home/instructeur/ComfyUI/output") / subf / fn
                            if p.exists():
                                return p

                    clean_name = os.path.basename(prefix)
                    disk_matches = sorted(
                        Path("/home/instructeur/ComfyUI/output/video").glob(f"{clean_name}*.mp4"),
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    if disk_matches:
                        return disk_matches[0]
                    return None

                found_path = await asyncio.to_thread(_locate_output, outputs, expected_prefix)
                if not found_path:
                    raise FileNotFoundError(f"Rendu ComfyUI introuvable pour {pid}: {outputs}")

                return found_path

            poll_count += 1
            if (
                poll_count % 2 == 0
                and task_id in tasks
                and tasks[task_id].get("status") == "running"
            ):
                cur_prog = tasks[task_id].get("progress", 0)
                seq_idx = tasks[task_id].get("sequenceIndex")
                seq_total = tasks[task_id].get("sequenceTotal", 1)

                if seq_total and seq_total > 1 and seq_idx:
                    seg_floor = int(round((seq_idx - 1) / seq_total * 100))
                    seg_ceiling = int(round((seq_idx - 0.05) / seq_total * 100))
                    target_max = max(seg_floor, seg_ceiling)
                else:
                    target_max = 90

                if cur_prog < target_max:
                    tasks[task_id]["progress"] = min(target_max, cur_prog + 1)

                current_step = str(tasks[task_id].get("step", "") or "")
                if "Plan " not in current_step:
                    tasks[task_id]["step"] = (
                        f"Inférence GPU en cours ({tasks[task_id]['progress']}%)"
                    )
            await asyncio.sleep(1.5)

    async def _execute_comfyui_infer(
        task_id: str,
        payload: InferRequest,
        file_path: Path,
        cancel_event: asyncio.Event,
    ) -> None:
        """Exécute une inférence réelle sur l'instance ComfyUI locale."""
        comfy_base = "http://127.0.0.1:8188"
        mid = (payload.modelId or "").lower()
        from app.services.task_kind import is_video_task as _is_video_task
        from app.services.task_kind import should_weave_audio

        is_video_task = _is_video_task(payload.type, payload.modelId, AVAILABLE_MODELS)

        ratio = payload.parameters.get("aspectRatio", "16:9")
        ratio_map = {
            "16:9": "16:9 (Widescreen)",
            "9:16": "9:16 (Portrait Widescreen)",
            "1:1": "1:1 (Square)",
            "4:3": "4:3 (Standard)",
            "3:4": "3:4 (Portrait Standard)",
            "21:9": "21:9 (Ultrawide)",
            "2:3": "2:3 (Portrait Photo)",
            "3:2": "3:2 (Photo)",
        }
        ratio_str = ratio_map.get(ratio, "16:9 (Widescreen)")

        req_seed = getattr(payload, "seed", None) or payload.parameters.get("seed")
        base_seed = (
            req_seed if (req_seed and req_seed > 0) else (secrets.randbelow(899999999) + 100000)
        )

        script_plan_data = payload.parameters.get("scriptPlan")
        script_segments = script_plan_data.get("segments") if script_plan_data else None

        if not script_segments and is_video_task:
            from app.services.story_director import (
                calculate_segments_duration,
                parse_explicit_script_segments,
            )

            _, explicit_segs = parse_explicit_script_segments(payload.prompt)
            if len(explicit_segs) > 1:
                durations = calculate_segments_duration(float(len(explicit_segs) * 10.0), 10.0)
                script_segments = [
                    {"index": i + 1, "duration_sec": d, "action_prompt": explicit_segs[i]}
                    for i, d in enumerate(durations)
                ]

        # -----------------------------------------------------------
        # Cas 1 : Chaînage Multi-Plans Séquentiel (T2V -> I2V ...)
        # -----------------------------------------------------------
        if is_video_task and "noctq" not in mid and script_segments and len(script_segments) > 1:
            from app.services.story_director import (
                build_chained_segment_prompt,
                extract_character_profiles,
                infer_scene_overview,
            )

            t2v_path = Path("/home/instructeur/ComfyUI/_setup/MiniMax_H3_T2V_Heretic_api.json")
            i2v_path = Path("/home/instructeur/ComfyUI/_setup/MiniMax_H3_I2V_Heretic_api.json")
            comfy_input_dir = Path("/home/instructeur/ComfyUI/input")
            await asyncio.to_thread(comfy_input_dir.mkdir, parents=True, exist_ok=True)

            total_segs = len(script_segments)
            prev_frame_filename: str | None = None
            completed_segments: list[dict[str, Any]] = []
            tasks[task_id]["completedSegments"] = completed_segments

            # Extraction et compilation des ancres d'identité des personnages (Module Persistance)
            char_profiles = script_plan_data.get("character_profiles") if script_plan_data else None
            if not char_profiles:
                char_profiles = extract_character_profiles(
                    payload.prompt, [s.get("action_prompt", "") for s in script_segments]
                )

            scene_overview = (
                script_plan_data.get("scene_overview") if script_plan_data else ""
            ) or infer_scene_overview(
                payload.prompt,
                [s.get("action_prompt", "") for s in script_segments],
                char_profiles,
            )

            character_anchors_map: dict[str, Any] = {}
            tasks[task_id]["characterAnchors"] = character_anchors_map

            # Module C : Prise en charge d'une Start Frame initiale fournie par l'utilisateur
            initial_start_frame = payload.references.get("startFrame")
            if initial_start_frame:

                def _stage_start_frame(src_str: str) -> str | None:
                    p = Path(src_str).resolve()
                    if p.is_file():
                        fname = f"init_{task_id}_{p.name}"
                        dest = comfy_input_dir / fname
                        shutil.copy2(p, dest)
                        return fname
                    return None

                staged_name = await asyncio.to_thread(_stage_start_frame, initial_start_frame)
                if staged_name:
                    prev_frame_filename = staged_name

            for seg_idx, seg in enumerate(script_segments, start=1):
                if cancel_event.is_set():
                    tasks[task_id]["status"] = "cancelled"
                    tasks[task_id]["errorMessage"] = "Annulée par l'utilisateur"
                    return

                seg_dur = float(seg.get("duration_sec", 10.0))
                seg_action = seg.get("action_prompt", payload.prompt)
                seg_prefix = f"video/task_{task_id}_part_{seg_idx:03d}"

                # Construction du prompt enrichi avec ancres de personnages et continuité
                seg_prompt = build_chained_segment_prompt(
                    seg_idx=seg_idx,
                    total_segs=total_segs,
                    action_prompt=seg_action,
                    scene_overview=scene_overview,
                    char_profiles=char_profiles,
                )

                tasks[task_id]["sequenceIndex"] = seg_idx
                tasks[task_id]["sequenceTotal"] = total_segs
                tasks[task_id]["step"] = (
                    f"Plan {seg_idx}/{total_segs} ({seg_dur:.0f}s) : « {seg_action[:55]} »"
                )
                tasks[task_id]["progress"] = int(round((seg_idx - 1) / total_segs * 100))

                if seg_idx == 1 or not prev_frame_filename:
                    graph = await asyncio.to_thread(_load_workflow_graph, t2v_path)
                    if "140:131" in graph:
                        graph["140:131"]["inputs"]["prompt"] = seg_prompt
                    if "140:129" in graph:
                        graph["140:129"]["inputs"]["noise_seed"] = base_seed
                    if "140:139" in graph:
                        graph["140:139"]["inputs"]["value"] = True
                    if "140:133" in graph:
                        graph["140:133"]["inputs"]["value"] = seg_dur
                    if "115" in graph:
                        graph["115"]["inputs"]["aspect_ratio"] = ratio_str
                    if "92" in graph:
                        graph["92"]["inputs"]["filename_prefix"] = seg_prefix
                else:
                    graph = await asyncio.to_thread(_load_workflow_graph, i2v_path)
                    if "105:104" in graph:
                        graph["105:104"]["inputs"]["prompt"] = seg_prompt
                    if "114" in graph:
                        graph["114"]["inputs"]["image"] = prev_frame_filename
                    if "105:111" in graph:
                        graph["105:111"]["inputs"]["value"] = seg_dur
                    if "105:126" in graph:
                        graph["105:126"]["inputs"]["value"] = True
                    if "105:15" in graph:
                        graph["105:15"]["inputs"]["noise_seed"] = base_seed
                    if "115" in graph:
                        graph["115"]["inputs"]["aspect_ratio"] = ratio_str
                    if "92" in graph:
                        graph["92"]["inputs"]["filename_prefix"] = seg_prefix

                try:
                    seg_out = await _submit_and_wait_comfyui(
                        graph, comfy_base, task_id, cancel_event, seg_prefix
                    )
                except asyncio.CancelledError:
                    tasks[task_id]["status"] = "cancelled"
                    tasks[task_id]["errorMessage"] = "Annulée par l'utilisateur"
                    return

                # Sauvegarde du fichier vidéo individuel pour ce plan
                part_filename = f"{file_path.stem}_p{seg_idx:02d}.mp4"
                part_path = file_path.parent / part_filename
                await asyncio.to_thread(shutil.copy2, seg_out, part_path)

                # Module D : Audio Weaver (dialogues et ambiance sonore)
                if payload.parameters.get("autoVoiceOver", True):
                    with contextlib.suppress(Exception):
                        from app.services.audio_weaver import weave_audio_into_video_segment

                        await weave_audio_into_video_segment(
                            part_path, seg_action, duration_sec=seg_dur
                        )

                if seg_idx == 1:
                    await asyncio.to_thread(shutil.copy2, part_path, file_path)

                # Extraction dernière image pour le plan suivant
                frame_name = f"chain_{task_id}_frame_{seg_idx:03d}.png"
                frame_path = comfy_input_dir / frame_name
                await _extract_last_frame_ffmpeg(seg_out, frame_path)
                prev_frame_filename = frame_name

                # Enregistrement de l'ancre visuelle pour tout personnage apparaissant dans ce plan
                if char_profiles:
                    for cp in char_profiles:
                        if cp.get("first_seen_segment") == seg_idx:
                            cid = cp.get("id", f"char_{seg_idx}")
                            anchor_fname = f"anchor_{task_id}_{cid}.png"
                            anchor_dest = comfy_input_dir / anchor_fname
                            await asyncio.to_thread(shutil.copy2, frame_path, anchor_dest)

                            # Copie vers uploads si disponible
                            uploads_dir = Path("/mnt/c/wamp64/www/colab-ai-studio/data/uploads")
                            uploads_ok = await asyncio.to_thread(uploads_dir.exists)
                            if uploads_ok:
                                up_dest = uploads_dir / anchor_fname
                                await asyncio.to_thread(shutil.copy2, frame_path, up_dest)

                            character_anchors_map[cid] = {
                                "id": cid,
                                "label": cp.get("label", "Personnage"),
                                "description": cp.get("description", ""),
                                "sourceShotIndex": seg_idx,
                                "filename": anchor_fname,
                                "url": f"/api/uploads/{anchor_fname}",
                            }

                seg_rec = {
                    "index": seg_idx,
                    "total": total_segs,
                    "duration": f"{seg_dur:.0f}s",
                    "prompt": seg_action,
                    "filename": part_filename,
                    "filePath": str(part_path),
                }
                completed_segments.append(seg_rec)
                tasks[task_id]["completedSegments"] = completed_segments
                tasks[task_id]["characterAnchors"] = character_anchors_map
                tasks[task_id]["progress"] = int(round(seg_idx / total_segs * 100))

            tasks[task_id]["progress"] = 100
            tasks[task_id]["step"] = f"Tous les {total_segs} plans terminés avec succès"
            tasks[task_id]["characterAnchors"] = character_anchors_map
            return

        # -----------------------------------------------------------
        # Cas 2 : Génération Standard Simple (1 seul clip ou Image)
        # -----------------------------------------------------------
        def _resolve_image_source(raw_src: str | None) -> Path | None:
            if not raw_src or not isinstance(raw_src, str) or raw_src.startswith("blob:"):
                return None
            clean_src = raw_src.strip()
            candidates = [clean_src]
            if "/api/uploads/" in clean_src:
                candidates.append(clean_src.split("/api/uploads/")[1])
            if "/api/generations/" in clean_src:
                candidates.append(clean_src.split("/api/generations/")[1].split("/")[0])
                candidates.append(clean_src.split("/api/generations/")[-1])

            for cand in candidates:
                p = Path(cand).resolve()
                if p.is_file():
                    return p
                fname = Path(cand).name
                search_roots = [
                    Path("/mnt/c/wamp64/www/colab-ai-studio/data/uploads"),
                    output_dir,
                    Path("/home/instructeur/ComfyUI/input"),
                    Path("/home/instructeur/ComfyUI/output"),
                ]
                for root in search_roots:
                    f_cand = root / fname
                    if f_cand.is_file():
                        return f_cand
                with contextlib.suppress(Exception):
                    matches = list(
                        Path("/mnt/c/wamp64/www/colab-ai-studio/outputs").rglob(fname)
                    )
                    if matches and matches[0].is_file():
                        return matches[0]
            return None

        if is_video_task and "noctq" not in mid:
            user_img_refs = payload.references.get("imageRefs") or []
            start_frame_ref = payload.references.get("startFrame") or (
                user_img_refs[0] if user_img_refs else None
            )
            staged_i2v_img = None
            if start_frame_ref:
                p_i2v = _resolve_image_source(start_frame_ref)
                if p_i2v and p_i2v.is_file():
                    comfy_input_dir = Path("/home/instructeur/ComfyUI/input")
                    await asyncio.to_thread(comfy_input_dir.mkdir, parents=True, exist_ok=True)
                    if p_i2v.suffix.lower() in {".mp4", ".webm", ".mov", ".mkv"}:
                        # Chaînage inter-plans : on part de la dernière image du plan précédent
                        staged_i2v_img = f"i2v_chain_{task_id}.png"
                        dest_i2v = comfy_input_dir / staged_i2v_img
                        await _extract_last_frame_ffmpeg(p_i2v, dest_i2v)
                    else:
                        staged_i2v_img = f"i2v_in_{task_id}_{p_i2v.name}"
                        dest_i2v = comfy_input_dir / staged_i2v_img
                        await asyncio.to_thread(shutil.copy2, p_i2v, dest_i2v)
                    logger.info(
                        "Image de référence I2V injectée dans ComfyUI : %s -> %s",
                        p_i2v,
                        dest_i2v,
                    )
                else:
                    logger.warning(
                        "Référence image I2V MiniMax H3 non résolue sur disque : %s (repli T2V)",
                        start_frame_ref,
                    )

            dur_raw = str(payload.parameters.get("duration", "5s")).replace("s", "")
            try:
                dur_val = float(dur_raw)
            except ValueError:
                dur_val = 5.0

            if staged_i2v_img:
                wf_path = Path("/home/instructeur/ComfyUI/_setup/MiniMax_H3_I2V_Heretic_api.json")
                graph = await asyncio.to_thread(_load_workflow_graph, wf_path)
                if "105:104" in graph:
                    graph["105:104"]["inputs"]["prompt"] = payload.prompt
                if "114" in graph:
                    graph["114"]["inputs"]["image"] = staged_i2v_img
                if "105:111" in graph:
                    graph["105:111"]["inputs"]["value"] = dur_val
                if "105:126" in graph:
                    graph["105:126"]["inputs"]["value"] = True
                if "105:15" in graph:
                    graph["105:15"]["inputs"]["noise_seed"] = base_seed
                if "115" in graph:
                    graph["115"]["inputs"]["aspect_ratio"] = ratio_str
                if "92" in graph:
                    graph["92"]["inputs"]["filename_prefix"] = f"video/task_{task_id}"
                prefix = f"video/task_{task_id}"
            else:
                wf_path = Path("/home/instructeur/ComfyUI/_setup/MiniMax_H3_T2V_Heretic_api.json")
                graph = await asyncio.to_thread(_load_workflow_graph, wf_path)
                if "140:131" in graph:
                    graph["140:131"]["inputs"]["prompt"] = payload.prompt
                if "140:129" in graph:
                    graph["140:129"]["inputs"]["noise_seed"] = base_seed
                if "140:139" in graph:
                    graph["140:139"]["inputs"]["value"] = True
                if "140:133" in graph:
                    graph["140:133"]["inputs"]["value"] = dur_val
                if "115" in graph:
                    graph["115"]["inputs"]["aspect_ratio"] = ratio_str
                if "92" in graph:
                    graph["92"]["inputs"]["filename_prefix"] = f"video/task_{task_id}"
                prefix = f"video/task_{task_id}"
        else:
            img_refs = payload.references.get("imageRefs") or []
            src_ref = img_refs[0] if img_refs else payload.references.get("startFrame")

            staged_img_name = None
            p_ref = _resolve_image_source(src_ref) if src_ref else None
            if p_ref and p_ref.is_file():
                comfy_input_dir = Path("/home/instructeur/ComfyUI/input")
                await asyncio.to_thread(comfy_input_dir.mkdir, parents=True, exist_ok=True)
                staged_img_name = f"noctq_in_{task_id}_{p_ref.name}"
                dest = comfy_input_dir / staged_img_name
                await asyncio.to_thread(shutil.copy2, p_ref, dest)
                logger.info(
                    "Référence image NoctQ V4 identifiée et injectée dans ComfyUI: %s -> %s",
                    p_ref,
                    dest,
                )
            elif src_ref:
                logger.warning("Référence image NoctQ V4 non résolue sur le disque: %s", src_ref)

            # Détermination robuste des étapes (steps) : 25 par défaut pour la haute fidélité
            req_steps = (
                payload.parameters.get("steps")
                if isinstance(payload.parameters, dict) and payload.parameters.get("steps")
                else payload.steps
            )
            effective_steps = int(req_steps) if req_steps and int(req_steps) > 0 else 25

            # Détermination du prompt négatif avec protection anti-flou par défaut si omis
            default_neg = (
                "artifacts, blurry, soft focus, out of focus, low quality, low resolution, "
                "washed-out colors, AI slop, deviantart, sloppy lines, rough sketch, indistinct, "
                "missing fingers, badly drawn hands, wrong number of fingers, distorted"
            )
            user_neg = (payload.negativePrompt or "").strip()
            effective_neg = user_neg if user_neg else default_neg

            if staged_img_name:
                wf_path = Path(
                    "/home/instructeur/ComfyUI/_setup/noctq/NoctQ_V4_Edit_Direct_api.json"
                )
                graph = await asyncio.to_thread(_load_workflow_graph, wf_path)
                if "4" in graph:
                    graph["4"]["inputs"]["image"] = staged_img_name
                if "5" in graph:
                    graph["5"]["inputs"]["prompt"] = payload.prompt
                    graph["5"]["inputs"]["negative_prompt"] = effective_neg
                if "6" in graph:
                    graph["6"]["inputs"]["seed"] = base_seed
                    graph["6"]["inputs"]["steps"] = min(50, effective_steps)
                if "8" in graph:
                    graph["8"]["inputs"]["filename_prefix"] = f"task_{task_id}"
                prefix = f"task_{task_id}"
            else:
                wf_path = Path("/home/instructeur/ComfyUI/_setup/noctq/NoctQ_V4_api.json")
                graph = await asyncio.to_thread(_load_workflow_graph, wf_path)
                if "4" in graph:
                    graph["4"]["inputs"]["prompt"] = payload.prompt
                    graph["4"]["inputs"]["negative_prompt"] = effective_neg
                if "5" in graph:
                    dims = {
                        "1:1": (1024, 1024),
                        "16:9": (1536, 1024),
                        "9:16": (1024, 1536),
                        "4:3": (1152, 864),
                        "3:4": (864, 1152),
                    }.get(ratio, (1024, 1536))
                    graph["5"]["inputs"]["width"] = dims[0]
                    graph["5"]["inputs"]["height"] = dims[1]
                if "6" in graph:
                    graph["6"]["inputs"]["seed"] = base_seed
                    graph["6"]["inputs"]["steps"] = min(50, effective_steps)
                if "8" in graph:
                    graph["8"]["inputs"]["filename_prefix"] = f"task_{task_id}"
                prefix = f"task_{task_id}"

        single_out = await _submit_and_wait_comfyui(
            graph, comfy_base, task_id, cancel_event, prefix
        )
        await asyncio.to_thread(shutil.copy2, single_out, file_path)
        if should_weave_audio(is_video_task, str(file_path), payload.parameters):
            with contextlib.suppress(Exception):
                from app.services.audio_weaver import weave_audio_into_video_segment

                video_dur = dur_val if "dur_val" in locals() else 5.0
                await weave_audio_into_video_segment(
                    file_path, payload.prompt, duration_sec=video_dur
                )
        tasks[task_id]["progress"] = 100

    async def _execute_upscale_infer(
        task_id: str,
        payload: InferRequest,
        file_path: Path,
        cancel_event: asyncio.Event,
    ) -> None:
        """Exécute un upscaling 4K réel sur image ou vidéo via ComfyUI ou FFmpeg AI Lanczos."""
        tasks[task_id]["status"] = "running"
        tasks[task_id]["progress"] = 15
        tasks[task_id]["step"] = "Localisation et analyse du média source..."

        def _locate_source(raw_source: str, fallback_fn: str | None) -> Path | None:
            candidates_to_try: list[str] = []
            if raw_source and not raw_source.startswith("blob:"):
                candidates_to_try.append(raw_source)
            if fallback_fn:
                candidates_to_try.append(fallback_fn)

            for cand in candidates_to_try:
                p = Path(cand).resolve()
                if p.is_file():
                    return p
                fname = Path(cand).name
                search_dirs = [
                    output_dir,
                    Path("/mnt/c/wamp64/www/colab-ai-studio/data/uploads"),
                    Path("/home/instructeur/ComfyUI/output"),
                ]
                for s_dir in search_dirs:
                    f_cand = s_dir / fname
                    if f_cand.is_file():
                        return f_cand

                with contextlib.suppress(Exception):
                    matches = list(Path("/mnt/c/wamp64/www/colab-ai-studio/outputs").rglob(fname))
                    if matches:
                        return matches[0]

                with contextlib.suppress(Exception):
                    matches = list(
                        Path("/mnt/c/Users/HP/OneDrive/Documents/Hérétique").rglob(fname)
                    )
                    if matches:
                        return matches[0]

            return None

        src_raw = (
            payload.references.get("upscaleSource")
            or (payload.references.get("videoRefs") or [None])[0]
            or (payload.references.get("imageRefs") or [None])[0]
            or ""
        )
        src_fn = payload.references.get("upscaleSourceFilename")

        source_file = await asyncio.to_thread(_locate_source, src_raw, src_fn)
        if not source_file:
            raise FileNotFoundError(
                f"Média source introuvable sur disque pour l'upscale: {src_raw or src_fn}"
            )

        src_suffix = source_file.suffix.lower()
        is_video = src_suffix in {".mp4", ".mov", ".webm", ".mkv", ".avi"}

        res_param = (payload.parameters.get("resolution") or "4K").upper()
        aspect_ratio = payload.parameters.get("aspectRatio") or "16:9"

        if res_param == "8K":
            target_w, target_h = (7680, 4320) if "9:16" not in aspect_ratio else (4320, 7680)
        elif res_param == "4K":
            target_w, target_h = (3840, 2160) if "9:16" not in aspect_ratio else (2160, 3840)
        elif res_param == "1080P":
            target_w, target_h = (1920, 1080) if "9:16" not in aspect_ratio else (1080, 1920)
        else:
            target_w, target_h = (3840, 2160)

        # CAS A : Vidéo (FFmpeg Lanczos + unsharp mask 4K)
        if is_video:
            tasks[task_id]["step"] = (
                f"Upscaling vidéo {res_param} ({target_w}x{target_h}) via RTX..."
            )
            tasks[task_id]["progress"] = 30

            ffmpeg_bin = "/home/instructeur/.local/bin/ffmpeg"
            f_exists = await asyncio.to_thread(lambda: Path(ffmpeg_bin).exists())
            if not f_exists:
                ffmpeg_bin = "ffmpeg"

            filter_str = (
                f"scale=w={target_w}:h={target_h}:flags=lanczos+accurate_rnd+full_chroma_int+full_chroma_inp,"
                f"unsharp=5:5:0.8:5:5:0.0"
            )

            cmd = [
                ffmpeg_bin,
                "-y",
                "-i",
                str(source_file),
                "-vf",
                filter_str,
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-preset",
                "veryfast",
                "-crf",
                "17",
                "-c:a",
                "copy",
                str(file_path),
            ]

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )

            for p in range(35, 95, 10):
                if cancel_event.is_set():
                    proc.kill()
                    raise asyncio.CancelledError("Annulé par l'utilisateur")
                await asyncio.sleep(0.6)
                tasks[task_id]["progress"] = p

            _, stderr = await proc.communicate()
            out_exists = await asyncio.to_thread(file_path.exists)
            if proc.returncode != 0 or not out_exists:
                err = stderr.decode("utf-8", errors="ignore")
                raise RuntimeError(f"Échec de l'encodage vidéo 4K: {err}")

            tasks[task_id]["progress"] = 100
            tasks[task_id]["step"] = f"Rendu {res_param} 4K terminé avec succès"
            return

        # CAS B : Image (ComfyUI RealESRGAN x4)
        tasks[task_id]["step"] = "Upscaling image haute fidélité (Real-ESRGAN x4)..."
        tasks[task_id]["progress"] = 25

        comfy_base = "http://127.0.0.1:8188"
        comfy_input_dir = Path("/home/instructeur/ComfyUI/input")
        await asyncio.to_thread(comfy_input_dir.mkdir, parents=True, exist_ok=True)

        input_img_name = f"upscale_{task_id}_{source_file.name}"
        comfy_dest_img = comfy_input_dir / input_img_name
        await asyncio.to_thread(shutil.copy2, source_file, comfy_dest_img)

        graph = {
            "1": {"inputs": {"image": input_img_name}, "class_type": "LoadImage"},
            "2": {
                "inputs": {"model_name": "RealESRGAN_x4plus.pth"},
                "class_type": "UpscaleModelLoader",
            },
            "3": {
                "inputs": {"upscale_model": ["2", 0], "image": ["1", 0]},
                "class_type": "ImageUpscaleWithModel",
            },
            "4": {
                "inputs": {
                    "filename_prefix": f"upscale/task_{task_id}",
                    "images": ["3", 0],
                },
                "class_type": "SaveImage",
            },
        }

        seg_out = await _submit_and_wait_comfyui(
            graph, comfy_base, task_id, cancel_event, f"upscale/task_{task_id}"
        )
        await asyncio.to_thread(shutil.copy2, seg_out, file_path)
        tasks[task_id]["progress"] = 100
        tasks[task_id]["step"] = "Upscale image terminé avec succès"

    async def _execute_lipsync_infer(
        task_id: str,
        payload: InferRequest,
        file_path: Path,
        cancel_event: asyncio.Event,
    ) -> None:
        """Exécute un doublage vidéo ou animation portrait Lip Sync (LatentSync / LivePortrait)."""
        from app.services.lipsync_dubber import (
            dub_video_with_audio_or_speech,
            render_portrait_lipsync_video,
        )

        tasks[task_id]["status"] = "running"
        tasks[task_id]["progress"] = 15
        tasks[task_id]["step"] = "Analyse des pistes média (vidéo / portrait / voix)..."

        def _locate_media(raw_val: str | None) -> Path | None:
            if not raw_val or not isinstance(raw_val, str) or raw_val.startswith("blob:"):
                return None
            clean_val = raw_val.strip()
            cands = [clean_val]
            if "/api/uploads/" in clean_val:
                cands.append(clean_val.split("/api/uploads/")[1].split("?")[0])
            if "/api/generations/" in clean_val:
                cands.append(clean_val.split("/api/generations/")[1].split("/")[0])
                cands.append(clean_val.split("/api/generations/")[-1])

            for cand in cands:
                p = Path(cand).resolve()
                if p.is_file():
                    return p
                fname = Path(cand).name
                for s_dir in (
                    Path("/mnt/c/wamp64/www/colab-ai-studio/data/uploads"),
                    output_dir,
                    Path("/home/instructeur/ComfyUI/output"),
                    Path("/home/instructeur/ComfyUI/input"),
                ):
                    f_cand = s_dir / fname
                    if f_cand.is_file():
                        return f_cand
                with contextlib.suppress(Exception):
                    matches = list(
                        Path("/mnt/c/wamp64/www/colab-ai-studio/outputs").rglob(
                            f"{fname}*" if fname.startswith("gen_") and "." not in fname else fname
                        )
                    )
                    for m in matches:
                        if m.is_file() and m.suffix.lower() in {
                            ".mp4",
                            ".webm",
                            ".mov",
                            ".png",
                            ".jpg",
                            ".jpeg",
                            ".webp",
                            ".wav",
                            ".mp3",
                        }:
                            return m
            return None

        vid_refs = payload.references.get("videoRefs") or []
        img_refs = payload.references.get("imageRefs") or []
        aud_refs = payload.references.get("audioRefs") or []
        start_ref = payload.references.get("startFrame")

        raw_visual = (
            (vid_refs[0] if vid_refs else None)
            or (img_refs[0] if img_refs else None)
            or start_ref
        )
        raw_audio = aud_refs[0] if aud_refs else None

        visual_file = await asyncio.to_thread(_locate_media, raw_visual)
        audio_file = await asyncio.to_thread(_locate_media, raw_audio)

        talking_style = str(payload.parameters.get("talkingStyle", "Stable"))
        dur_raw = str(payload.parameters.get("duration", "5s")).replace("s", "")
        try:
            dur_val = float(dur_raw)
        except ValueError:
            dur_val = 5.0

        is_visual_video = bool(
            visual_file
            and visual_file.suffix.lower() in {".mp4", ".mov", ".webm", ".mkv", ".avi"}
        )

        if is_visual_video and visual_file is not None:
            tasks[task_id]["progress"] = 45
            tasks[task_id]["step"] = (
                f"Synchronisation labiale LatentSync sur {visual_file.name}..."
            )
            await dub_video_with_audio_or_speech(
                source_video=visual_file,
                output_video=file_path,
                prompt_text=payload.prompt,
                audio_source=audio_file,
                talking_style=talking_style,
            )
            tasks[task_id]["progress"] = 100
            tasks[task_id]["step"] = "Doublage vidéo Lip Sync terminé avec succès"
            return

        comfy_ok = await _is_comfyui_available()
        if comfy_ok:
            tasks[task_id]["progress"] = 25
            tasks[task_id]["step"] = "Animation faciale I2V et synchronisation vocale..."
            await _execute_comfyui_infer(task_id, payload, file_path, cancel_event)
            if cancel_event.is_set():
                return
            await dub_video_with_audio_or_speech(
                source_video=file_path,
                output_video=file_path,
                prompt_text=payload.prompt,
                audio_source=audio_file,
                talking_style=talking_style,
            )
            tasks[task_id]["progress"] = 100
            tasks[task_id]["step"] = "Animation portrait Lip Sync terminée avec succès"
            return

        if visual_file is not None and visual_file.is_file():
            tasks[task_id]["progress"] = 50
            tasks[task_id]["step"] = f"Animation portrait Lip Sync ({visual_file.name})..."
            await render_portrait_lipsync_video(
                source_image=visual_file,
                output_video=file_path,
                prompt_text=payload.prompt,
                audio_source=audio_file,
                talking_style=talking_style,
                duration_sec=dur_val,
            )
            tasks[task_id]["progress"] = 100
            tasks[task_id]["step"] = "Animation portrait Lip Sync terminée avec succès"
            return

        raise FileNotFoundError(
            "Aucune vidéo ou image source valide trouvée pour la synchronisation labiale."
        )

    async def _execute_inference_task(task_id: str, payload: InferRequest) -> None:
        """Exécute une tâche d'inférence en arrière-plan sous verrou GPU."""
        cancel_event = cancel_events[task_id]
        tasks[task_id]["status"] = "running"
        total_steps = max(1, payload.steps or 5)

        try:
            async with gpu_lock:
                mid = (payload.modelId or "").lower()
                mtype = (payload.type or "").lower()
                is_upscale = (
                    mtype == "upscale" or "upscale" in mid or "topaz" in mid or "esrgan" in mid
                )
                is_lipsync = mtype in {"lipsync", "lip_sync"} or mid in {
                    "latentsync",
                    "liveportrait",
                    "wav2lip",
                }

                if is_upscale:
                    src_val = (
                        payload.references.get("upscaleSource")
                        or payload.references.get("upscaleSourceFilename")
                        or (payload.references.get("videoRefs") or [None])[0]
                        or (payload.references.get("imageRefs") or [None])[0]
                        or ""
                    )
                    is_src_video = payload.references.get("upscaleSourceType") == "video" or any(
                        str(src_val).lower().endswith(vext)
                        for vext in (".mp4", ".mov", ".webm", ".mkv", ".avi")
                    )
                    ext = ".mp4" if is_src_video else ".png"
                    pipeline = None
                else:
                    loader = loaders.get(payload.modelId)
                    pipeline = swapper.ensure_model(payload.modelId, load_fn=loader)
                    is_video = (payload.type in {"video", "lipsync", "lip_sync"}) or any(
                        m["id"] == payload.modelId and m["type"] in {"video", "lipsync"}
                        for m in AVAILABLE_MODELS
                    )
                    ext = ".mp4" if is_video else ".png"

                filename = f"{task_id}{ext}"
                file_path = _resolve_safe_output_path(output_dir, filename)

                if not sim_mode:
                    if is_upscale:
                        await _execute_upscale_infer(task_id, payload, file_path, cancel_event)
                    elif callable(pipeline):
                        tasks[task_id]["step"] = 1
                        tasks[task_id]["progress"] = 50

                        def _run_real_infer():
                            kw = _prepare_pipeline_kwargs(payload)
                            if hasattr(pipeline, "callback_on_step_end"):

                                def _cb(p, s, t, cb_kw):
                                    if cancel_event.is_set():
                                        p._interrupt = True
                                    return cb_kw

                                kw["callback_on_step_end"] = _cb

                            out = pipeline(**kw)
                            if cancel_event.is_set():
                                return
                            if hasattr(out, "images") and out.images:
                                out.images[0].save(file_path)
                            elif hasattr(out, "frames") and out.frames:
                                from diffusers.utils import export_to_video

                                v_frames = out.frames
                                vid = v_frames[0] if isinstance(v_frames[0], list) else v_frames
                                export_to_video(vid, output_video_path=str(file_path), fps=8)
                            elif hasattr(out, "save"):
                                out.save(file_path)
                            elif isinstance(out, bytes):
                                file_path.write_bytes(out)
                            if not file_path.exists():
                                raise RuntimeError(f"Aucun fichier produit pour {payload.taskId}")

                        await asyncio.to_thread(_run_real_infer)
                    elif is_lipsync:
                        await _execute_lipsync_infer(task_id, payload, file_path, cancel_event)
                    else:
                        comfy_ok = await _is_comfyui_available()
                        comfy_keys = ("minimax", "noctq", "qwen", "flux", "wan", "cogvideo")
                        is_comfy_model = any(k in payload.modelId.lower() for k in comfy_keys)
                        if comfy_ok and is_comfy_model:
                            await _execute_comfyui_infer(task_id, payload, file_path, cancel_event)
                        else:
                            msg = (
                                f"Modèle {payload.modelId} indisponible en mode réel "
                                f"(ComfyUI actif: {comfy_ok})"
                            )
                            raise ValueError(msg)
                else:
                    for step in range(1, total_steps + 1):
                        if cancel_event.is_set():
                            tasks[task_id]["status"] = "cancelled"
                            tasks[task_id]["errorMessage"] = "Annulée par l'utilisateur"
                            return
                        await asyncio.sleep(0.04)
                        tasks[task_id]["step"] = step
                        tasks[task_id]["totalSteps"] = total_steps
                        tasks[task_id]["progress"] = int(round(step / total_steps * 100))

                    valid_bytes = make_valid_png() if ext == ".png" else make_valid_mp4()
                    _write_output_bytes(file_path, valid_bytes)

            if cancel_event.is_set():
                tasks[task_id]["status"] = "cancelled"
                tasks[task_id]["errorMessage"] = "Annulée par l'utilisateur"
                return

            tasks[task_id]["status"] = "completed"
            tasks[task_id]["progress"] = 100
            tasks[task_id]["artifactUri"] = filename
            tasks[task_id]["outputUrl"] = f"/files/{filename}"

        except Exception as exc:
            if "out of memory" in str(exc).lower():
                swapper.evict_vram()
            logger.exception("Erreur durant l'inférence tâche %s : %s", task_id, exc)
            tasks[task_id]["status"] = "failed"
            tasks[task_id]["error"] = str(exc)
            tasks[task_id]["errorMessage"] = str(exc)

    @app.post("/infer")
    async def infer(payload: InferRequest) -> dict[str, Any]:
        """Crée et lance une tâche asynchrone de génération multimédia."""
        task_id = payload.taskId or f"task_{uuid.uuid4().hex[:12]}"
        cancel_event = asyncio.Event()
        cancel_events[task_id] = cancel_event

        tasks[task_id] = {
            "taskId": task_id,
            "status": "pending",
            "progress": 0,
            "step": 0,
            "totalSteps": payload.steps or 5,
            "outputUrl": None,
            "artifactUri": None,
            "error": None,
            "errorMessage": None,
            "createdAt": time.time(),
        }

        asyncio.create_task(_execute_inference_task(task_id, payload))
        return {"taskId": task_id, "status": "pending"}

    @app.get("/tasks/{task_id}/status")
    async def get_task_status(task_id: str) -> dict[str, Any]:
        """Retourne l'état courant et la progression d'une tâche d'inférence."""
        if task_id not in tasks:
            raise HTTPException(status_code=404, detail="Tâche introuvable")
        return tasks[task_id]

    @app.post("/tasks/{task_id}/cancel")
    async def cancel_task(task_id: str) -> dict[str, Any]:
        """Signale l'annulation d'une tâche d'inférence multimédia."""
        if task_id in cancel_events:
            cancel_events[task_id].set()
        if task_id in tasks:
            tasks[task_id]["status"] = "cancelled"
            tasks[task_id]["errorMessage"] = "Annulée par l'utilisateur"
        return {"status": "cancelled", "taskId": task_id}

    @app.get("/files/{filename}")
    async def download_file(filename: str) -> FileResponse:
        """Sert un fichier généré sécurisé depuis le répertoire de sortie."""
        clean_name = filename.strip().lstrip("/")
        if ".." in clean_name or "/" in clean_name or "\\" in clean_name:
            raise HTTPException(status_code=400, detail="Chemin de fichier interdit")

        file_path = _resolve_existing_output_file(output_dir, clean_name)
        if file_path is None:
            raise HTTPException(status_code=404, detail="Fichier introuvable sur le worker")

        media_type = "video/mp4" if clean_name.endswith(".mp4") else "image/png"
        return FileResponse(file_path, media_type=media_type, filename=clean_name)

    @app.post("/v1/chat/cancel")
    async def cancel_chat(payload: ChatCancelRequest) -> dict[str, str]:
        """Enregistre l'annulation d'une session de chat conversationnel."""
        active_chat_cancels.add(payload.requestId)
        return {"status": "cancelled", "requestId": payload.requestId}

    @app.post("/v1/chat/completions")
    async def chat_completions(payload: ChatCompletionRequest, request: Request) -> Any:
        """Génère une complétion de chat LLM en mode direct ou streaming SSE."""
        request_id = payload.requestId or f"chat_{uuid.uuid4().hex[:10]}"
        last_user_msg = payload.messages[-1].content if payload.messages else "Bonjour"
        summary = last_user_msg[:40] + "..." if len(last_user_msg) > 40 else last_user_msg

        # Intégration transparente de Bionic (LM Studio local) sauf si loader custom injecté
        has_custom_loader = bool(loaders.get(payload.model))
        bionic_base, bionic_models = (
            (None, []) if has_custom_loader else await _get_bionic_endpoint()
        )
        if bionic_base and bionic_models:
            target_model = _resolve_bionic_model_target(payload.model, bionic_models)
            req_body: dict[str, Any] = {
                "model": target_model,
                "messages": [m.model_dump() for m in payload.messages],
                "temperature": getattr(payload, "temperature", 0.7) or 0.7,
                "max_tokens": 1500,
            }

            if not payload.stream:
                async with httpx.AsyncClient(timeout=180.0) as client:
                    resp = await client.post(f"{bionic_base}/chat/completions", json=req_body)
                    if resp.status_code == 200:
                        res_json = resp.json()
                        for c in res_json.get("choices", []):
                            msg_obj = c.get("message", {})
                            if not msg_obj.get("content") and msg_obj.get("reasoning_content"):
                                msg_obj["content"] = msg_obj["reasoning_content"]
                        return res_json

            async def bionic_stream_generator() -> AsyncGenerator[str, None]:
                req_body["stream"] = True
                async with httpx.AsyncClient(timeout=180.0) as client:
                    try:
                        async with client.stream(
                            "POST", f"{bionic_base}/chat/completions", json=req_body
                        ) as resp:
                            async for line in resp.aiter_lines():
                                if (
                                    request_id in active_chat_cancels
                                    or await request.is_disconnected()
                                ):
                                    return
                                trimmed = line.strip()
                                if not trimmed:
                                    continue
                                yield f"{trimmed}\n\n"
                    except Exception as exc:
                        logger.warning("Erreur flux Bionic: %s", exc)
                        err_choice = {
                            "index": 0,
                            "delta": {"content": f" [Erreur Bionic: {exc}]"},
                            "finish_reason": "error",
                        }
                        err_chunk = {
                            "id": request_id,
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": payload.model,
                            "choices": [err_choice],
                        }
                        yield f"data: {json.dumps(err_chunk)}\n\n"
                        yield "data: [DONE]\n\n"

            return StreamingResponse(
                bionic_stream_generator(),
                media_type="text/event-stream",
                headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
            )

        if not payload.stream:
            async with gpu_lock:
                chat_model = swapper.ensure_model(payload.model, load_fn=loaders.get(payload.model))
                content = f"Voici une réponse synthétisée par {payload.model} pour : « {summary} »."
                if callable(chat_model) and not sim_mode:
                    prompt_in = "\n".join(f"{m.role}: {m.content}" for m in payload.messages)
                    try:
                        res = await asyncio.to_thread(chat_model, prompt_in, max_new_tokens=150)
                        if isinstance(res, list) and res and "generated_text" in res[0]:
                            content = res[0]["generated_text"].replace(prompt_in, "").strip()
                        else:
                            content = str(res)
                    except Exception as exc:
                        if "out of memory" in str(exc).lower():
                            swapper.evict_vram()
                        raise
            msg = {"role": "assistant", "content": content}
            choice = {"index": 0, "message": msg, "finish_reason": "stop"}
            return {
                "id": request_id,
                "object": "chat.completion",
                "created": int(time.time()),
                "model": payload.model,
                "choices": [choice],
            }

        async def chat_stream_generator() -> AsyncGenerator[str, None]:
            """Générateur asynchrone émettant les blocs SSE d'une complétion de chat."""
            async with gpu_lock:
                try:
                    chat_model = swapper.ensure_model(
                        payload.model, load_fn=loaders.get(payload.model)
                    )
                    words = [
                        "Bonjour",
                        " ! ",
                        "Voici",
                        " une",
                        " réponse",
                        " synthétisée",
                        " pour",
                        f" « {summary} »",
                        " par",
                        " le",
                        " worker",
                        " distant",
                        " Colab.",
                    ]
                    if callable(chat_model) and not sim_mode:
                        from threading import Thread

                        if request_id in active_chat_cancels or await request.is_disconnected():
                            return
                        prompt_in = "\n".join(f"{m.role}: {m.content}" for m in payload.messages)
                        tok = getattr(chat_model, "tokenizer", None)
                        streamer_cls = None
                        criteria_base = object
                        criteria_list_cls = list
                        if tok is not None:
                            try:
                                from transformers import TextIteratorStreamer
                                from transformers.generation import (
                                    StoppingCriteria,
                                    StoppingCriteriaList,
                                )

                                streamer_cls = TextIteratorStreamer
                                criteria_base = StoppingCriteria
                                criteria_list_cls = StoppingCriteriaList
                            except ImportError:
                                streamer_cls = getattr(
                                    tok, "TextIteratorStreamer", None
                                ) or getattr(chat_model, "TextIteratorStreamer", None)

                        if tok is not None and streamer_cls is not None:

                            class CancelCriteria(criteria_base):
                                """Critère d'interruption pour inférence avec tokenizer."""

                                def __call__(self, input_ids=None, scores=None, **kw):
                                    """Retourne True si une annulation est active."""
                                    return request_id in active_chat_cancels

                            streamer = streamer_cls(tok, skip_prompt=True, skip_special_tokens=True)
                            crit = criteria_list_cls([CancelCriteria()])
                            gen_kw = {
                                "max_new_tokens": 150,
                                "streamer": streamer,
                                "stopping_criteria": crit,
                            }
                            loop = asyncio.get_running_loop()
                            q: asyncio.Queue[tuple[str | None, Exception | None]] = asyncio.Queue()

                            def _worker():
                                """Thread de calcul pour la génération avec streamer."""
                                try:
                                    chat_model(prompt_in, **gen_kw)
                                except Exception as th_err:
                                    if "out of memory" in str(th_err).lower():
                                        swapper.evict_vram()
                                    loop.call_soon_threadsafe(q.put_nowait, (None, th_err))
                                finally:
                                    streamer.end()

                            def _stream_reader():
                                """Thread de lecture des tokens émis par le streamer."""
                                try:
                                    for token in streamer:
                                        if request_id in active_chat_cancels:
                                            break
                                        loop.call_soon_threadsafe(q.put_nowait, (token, None))
                                except Exception as s_err:
                                    loop.call_soon_threadsafe(q.put_nowait, (None, s_err))
                                finally:
                                    loop.call_soon_threadsafe(q.put_nowait, (None, None))

                            th_m = Thread(target=_worker, daemon=True)
                            th_s = Thread(target=_stream_reader, daemon=True)
                            th_m.start()
                            th_s.start()
                            try:
                                while True:
                                    if (
                                        request_id in active_chat_cancels
                                        or await request.is_disconnected()
                                    ):
                                        return
                                    try:
                                        token, err = await asyncio.wait_for(q.get(), timeout=60.0)
                                    except asyncio.TimeoutError:
                                        msg = "\n[Erreur: délai de génération dépassé]"
                                        ec = {
                                            "index": 0,
                                            "delta": {"content": msg},
                                            "finish_reason": "error",
                                        }
                                        echunk = {
                                            "id": request_id,
                                            "object": "chat.completion.chunk",
                                            "created": int(time.time()),
                                            "model": payload.model,
                                            "choices": [ec],
                                        }
                                        yield f"data: {json.dumps(echunk)}\n\n"
                                        yield "data: [DONE]\n\n"
                                        return
                                    if err is not None:
                                        raise err
                                    if token is None:
                                        break
                                    choice = {
                                        "index": 0,
                                        "delta": {"content": token},
                                        "finish_reason": None,
                                    }
                                    chunk = {
                                        "id": request_id,
                                        "object": "chat.completion.chunk",
                                        "created": int(time.time()),
                                        "model": payload.model,
                                        "choices": [choice],
                                    }
                                    yield f"data: {json.dumps(chunk)}\n\n"
                            finally:
                                active_chat_cancels.add(request_id)
                                streamer.end()
                                was_c = False
                                for th in (th_m, th_s):
                                    while th.is_alive():
                                        fut = loop.run_in_executor(None, th.join, 0.5)
                                        while not fut.done():
                                            try:
                                                await asyncio.shield(fut)
                                            except asyncio.CancelledError:
                                                was_c = True
                                if was_c:
                                    raise asyncio.CancelledError()
                            yield "data: [DONE]\n\n"
                            return

                        class NoTokCancelCriteria:
                            """Critère d'interruption pour inférence sans tokenizer."""

                            def __call__(self, input_ids=None, scores=None, **kw):
                                """Retourne True si une annulation est active."""
                                return request_id in active_chat_cancels

                        crit_no_tok = [NoTokCancelCriteria()]
                        loop = asyncio.get_running_loop()
                        res_holder: dict[str, Any] = {}
                        err_holder: dict[str, Exception] = {}

                        def _no_tok_worker():
                            """Thread de calcul exécutant le modèle sans tokenizer."""
                            try:
                                try:
                                    res_holder["res"] = chat_model(
                                        prompt_in, max_new_tokens=150, stopping_criteria=crit_no_tok
                                    )
                                except TypeError as exc:
                                    if "stopping_criteria" not in str(exc):
                                        raise
                                    res_holder["res"] = chat_model(prompt_in, max_new_tokens=150)
                            except Exception as th_exc:
                                if "out of memory" in str(th_exc).lower():
                                    swapper.evict_vram()
                                err_holder["err"] = th_exc

                        th_no_tok = Thread(target=_no_tok_worker, daemon=True)
                        th_no_tok.start()
                        cancelled = False
                        try:
                            while th_no_tok.is_alive():
                                if (
                                    request_id in active_chat_cancels
                                    or await request.is_disconnected()
                                ):
                                    cancelled = True
                                    active_chat_cancels.add(request_id)
                                    return
                                await asyncio.sleep(0.04)
                            if "err" in err_holder:
                                raise err_holder["err"]
                            res = res_holder.get("res")
                            if isinstance(res, list) and res and "generated_text" in res[0]:
                                txt = res[0]["generated_text"].replace(prompt_in, "").strip()
                                words = [w + " " for w in txt.split()]
                        except (Exception, asyncio.CancelledError):
                            cancelled = True
                            active_chat_cancels.add(request_id)
                            raise
                        finally:
                            if cancelled:
                                active_chat_cancels.add(request_id)
                            was_c_no_tok = False
                            while th_no_tok.is_alive():
                                fut = loop.run_in_executor(None, th_no_tok.join, 0.5)
                                while not fut.done():
                                    try:
                                        await asyncio.shield(fut)
                                    except asyncio.CancelledError:
                                        was_c_no_tok = True
                            if was_c_no_tok:
                                raise asyncio.CancelledError()

                    for word in words:
                        if request_id in active_chat_cancels or await request.is_disconnected():
                            logger.info("Chat LLM annulé pour %s.", request_id)
                            return

                        choice = {
                            "index": 0,
                            "delta": {"content": word},
                            "finish_reason": None,
                        }
                        chunk = {
                            "id": request_id,
                            "object": "chat.completion.chunk",
                            "created": int(time.time()),
                            "model": payload.model,
                            "choices": [choice],
                        }
                        yield f"data: {json.dumps(chunk)}\n\n"
                        await asyncio.sleep(0.04)

                    yield "data: [DONE]\n\n"
                finally:
                    active_chat_cancels.discard(request_id)

        return StreamingResponse(
            chat_stream_generator(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "Connection": "keep-alive"},
        )

    return app
