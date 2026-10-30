import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app


@pytest.mark.asyncio
async def test_story_director_breakdown_explicit_plans():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        prompt_text = (
            "Plan 1: @Astrid scrute l'horizon gelé avec ses runes cyan.\n"
            "Plan 2: @Astrid dégaine son épée ailée face au blizzard."
        )
        payload = {
            "prompt": prompt_text,
            "maxSegmentSec": 5.0,
        }
        res = await client.post("/api/story-director/breakdown", json=payload)
        assert res.status_code == 200
        data = res.json()

        assert data["numSegments"] >= 2
        assert data["totalDurationSec"] >= 10.0
        assert len(data["segments"]) == 2

        seg1 = data["segments"][0]
        assert seg1["index"] == 1
        assert "@Astrid" in seg1["actionPrompt"]
        assert seg1["durationSec"] == 5.0
        assert "compiledPrompt" in seg1

        seg2 = data["segments"][1]
        assert seg2["index"] == 2
        assert "@Astrid" in seg2["actionPrompt"]
        assert seg2["durationSec"] == 5.0


@pytest.mark.asyncio
async def test_story_director_breakdown_heurstic_narrative():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        narrative = (
            "Une guerrière valkyrie marche sous la tempête. "
            "Soudain elle aperçoit une forteresse en ruines."
        )
        payload = {
            "prompt": narrative,
            "maxSegmentSec": 5.0,
        }
        res = await client.post("/api/story-director/breakdown", json=payload)
        assert res.status_code == 200
        data = res.json()

        assert data["numSegments"] >= 1
        assert "sceneOverview" in data
        assert len(data["segments"]) == data["numSegments"]


@pytest.mark.asyncio
async def test_story_director_unicode_and_no_none_archetype():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        text = "Plan 1: @Astrid observe le coucher de soleil. Plan 2: Un sage contemple la mer."
        payload = {
            "prompt": text,
            "maxSegmentSec": 5.0,
        }
        res = await client.post("/api/story-director/breakdown", json=payload)
        assert res.status_code == 200
        data = res.json()

        for seg in data["segments"]:
            assert "(None)" not in seg["compiledPrompt"]
            assert "None:" not in seg["compiledPrompt"]
