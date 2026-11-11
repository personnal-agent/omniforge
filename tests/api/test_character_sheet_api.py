from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from httpx import ASGITransport, AsyncClient

from app.api.routes_characters import _get_task_orchestrator
from app.api.routes_crud import get_json_store
from app.config import CHARACTERS_FILE
from app.main import app
from app.models.domain import Character, GenerationParameters
from app.storage.json_store import JSONDocumentStore


@pytest.fixture
async def client_with_store_and_orchestrator(tmp_path):
    store = JSONDocumentStore(tmp_path)
    astrid = Character(
        id="char_test_astrid",
        name="Astrid",
        triggerToken="@Astrid",
        physicalPrompt="Nordic valkyrie warrior with platinum braided hair and glowing cyan runes",
        archetype="The Fantastical",
        visualAnchors=["platinum braid", "cyan glowing runes", "silver winged armor"],
    )
    await store.write_list(CHARACTERS_FILE.name, [astrid.model_dump()])

    mock_gen = AsyncMock()
    mock_gen.id = "gen_sheet_12345"
    mock_gen.parameters = GenerationParameters(seed=777000)

    mock_orchestrator = AsyncMock()
    mock_orchestrator.submit_generation = AsyncMock(return_value=mock_gen)

    app.dependency_overrides[get_json_store] = lambda: store
    app.dependency_overrides[_get_task_orchestrator] = lambda: mock_orchestrator

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://testserver",
        headers={"Origin": "http://localhost:5173"},
    ) as c:
        yield c, store, mock_orchestrator

    app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_generate_character_sheet_endpoint(client_with_store_and_orchestrator) -> None:
    client, store, mock_orchestrator = client_with_store_and_orchestrator

    resp = await client.post("/api/characters/char_test_astrid/generate-sheet")
    assert resp.status_code == 202
    data = resp.json()

    assert data["taskId"] == "gen_sheet_12345"
    assert data["characterId"] == "char_test_astrid"
    assert "Astrid" in data["prompt"]
    assert "cyan glowing runes" in data["prompt"]
    assert "silver winged armor" in data["prompt"]
    assert data["seed"] > 0

    mock_orchestrator.submit_generation.assert_called_once()
    call_args = mock_orchestrator.submit_generation.call_args[0][0]
    assert call_args.modelId == "noctq-v4"
    assert call_args.type == "image"
    assert "char_test_astrid" in call_args.tags
    assert "character_sheet" in call_args.tags
