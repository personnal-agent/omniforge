"""Routes du Story Director : découpage scénaristique intelligent et orchestration de plans."""

from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.api.routes_crud import get_json_store, verify_trusted_origin
from app.config import CHARACTERS_FILE
from app.models.domain import Character
from app.services.story_director import (
    StoryDirector,
    build_chained_segment_prompt,
)
from app.storage.json_store import JSONDocumentStore

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/story-director", tags=["StoryDirector"])


class StoryBreakdownRequest(BaseModel):
    prompt: str = Field(..., min_length=1, description="Prompt narratif ou scénario multi-plans")
    totalDurationSec: float | None = Field(default=None, description="Durée cible optionnelle")
    maxSegmentSec: float = Field(default=5.0, description="Durée maximum par plan")
    characterIds: list[str] = Field(
        default_factory=list, description="IDs explicites de personnages à inclure"
    )


class StorySegmentResponse(BaseModel):
    index: int = Field(..., description="Numéro du plan (1-basé)")
    durationSec: float = Field(..., description="Durée du plan en secondes")
    actionPrompt: str = Field(..., description="Description de l'action pour ce plan")
    shotType: str = Field(default="Cinematic live-action", description="Type de plan caméra")
    compiledPrompt: str = Field(..., description="Prompt compilé avec ancres visuelles")
    characterIds: list[str] = Field(
        default_factory=list, description="IDs des personnages dans ce plan"
    )
    characterAnchors: list[dict[str, Any]] = Field(
        default_factory=list, description="Ancres et identités des personnages"
    )


class StoryBreakdownResponse(BaseModel):
    totalDurationSec: float = Field(..., description="Durée totale de la séquence")
    numSegments: int = Field(..., description="Nombre total de plans")
    sceneOverview: str = Field(..., description="Description générale de la scène et décor")
    segments: list[StorySegmentResponse] = Field(..., description="Liste ordonnée des plans")
    characters: list[dict[str, Any]] = Field(
        default_factory=list, description="Personnages détectés ou résolus"
    )


@router.post(
    "/breakdown",
    response_model=StoryBreakdownResponse,
    dependencies=[Depends(verify_trusted_origin)],
)
async def breakdown_story(
    payload: StoryBreakdownRequest,
    store: JSONDocumentStore = Depends(get_json_store),
) -> StoryBreakdownResponse:
    """Analyse un scénario et découpe en séquence de plans cinématographiques."""
    director = StoryDirector()
    plan = await director.plan_timeline(
        prompt=payload.prompt,
        target_total_sec=payload.totalDurationSec,
        max_segment_sec=payload.maxSegmentSec,
    )

    # Récupérer les personnages enregistrés
    raw_characters = await store.read_list(CHARACTERS_FILE.name)
    all_characters: list[Character] = []
    for item in raw_characters:
        try:
            all_characters.append(Character.model_validate(item))
        except Exception as exc:
            logger.debug("Ignorer caractère invalide: %s", exc)
            continue

    # Détecter les tags @Nom dans le prompt global
    found_chars: list[Character] = []
    char_by_token: dict[str, Character] = {}
    char_by_name: dict[str, Character] = {}
    char_by_id: dict[str, Character] = {}

    for c in all_characters:
        char_by_id[c.id] = c
        if c.triggerToken:
            char_by_token[c.triggerToken.lower()] = c
        if c.name:
            char_by_name[c.name.lower()] = c

    # 1. Vérifier explicit characterIds
    for cid in payload.characterIds:
        if cid in char_by_id and char_by_id[cid] not in found_chars:
            found_chars.append(char_by_id[cid])

    # 2. Scanner les mentions @ dans le prompt global (support Unicode pour accents)
    mentioned_tokens = re.findall(r"@([\w-]+)", payload.prompt, flags=re.UNICODE)
    for tok in mentioned_tokens:
        with_at = f"@{tok.lower()}"
        bare = tok.lower()
        matched = char_by_token.get(with_at) or char_by_name.get(bare)
        if matched and matched not in found_chars:
            found_chars.append(matched)

    # Construire la liste des profils pour StoryDirector
    char_profiles: list[dict[str, Any]] = []
    if found_chars:
        for c in found_chars:
            arch_val = (
                c.archetype.value
                if hasattr(c.archetype, "value")
                else (str(c.archetype) if c.archetype is not None else None)
            )
            char_profiles.append(
                {
                    "id": c.id,
                    "label": c.name,
                    "name": c.name,
                    "description": c.physicalPrompt,
                    "physicalPrompt": c.physicalPrompt,
                    "archetype": arch_val,
                    "visualAnchors": c.visualAnchors,
                    "voiceProfileId": c.voiceProfileId,
                    "voiceStyle": c.voiceStyle,
                }
            )
    elif plan.character_profiles:
        for p in plan.character_profiles:
            char_profiles.append(
                {
                    "id": p.get("id") or p.get("name", "char-auto"),
                    "label": p.get("name") or p.get("label", "Personnage"),
                    "name": p.get("name") or p.get("label", "Personnage"),
                    "description": p.get("physical_description") or p.get("description", ""),
                    "physicalPrompt": p.get("physical_description") or p.get("description", ""),
                    "archetype": p.get("archetype") if p.get("archetype") != "None" else None,
                    "visualAnchors": p.get("visual_anchors", []),
                    "voiceProfileId": p.get("voice_profile_id"),
                    "voiceStyle": p.get("voice_style"),
                }
            )

    # Construire les réponses de segments
    segments_resp: list[StorySegmentResponse] = []
    total_segs = len(plan.segments)

    for seg in plan.segments:
        # Trouver les personnages spécifiques à ce segment
        seg_char_ids = [c["id"] for c in char_profiles]
        seg_compiled = build_chained_segment_prompt(
            seg_idx=seg.index,
            total_segs=total_segs,
            action_prompt=seg.action_prompt,
            scene_overview=plan.scene_overview,
            char_profiles=char_profiles,
        )

        segments_resp.append(
            StorySegmentResponse(
                index=seg.index,
                durationSec=seg.duration_sec,
                actionPrompt=seg.action_prompt,
                shotType=seg.shot_type,
                compiledPrompt=seg_compiled,
                characterIds=seg_char_ids,
                characterAnchors=char_profiles,
            )
        )

    return StoryBreakdownResponse(
        totalDurationSec=plan.total_duration_sec,
        numSegments=len(segments_resp),
        sceneOverview=plan.scene_overview,
        segments=segments_resp,
        characters=char_profiles,
    )
