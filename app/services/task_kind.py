"""Nature d'une tâche d'inférence (vidéo vs image) et règles d'ajout de bande sonore."""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Any

_VIDEO_TYPES = {"video", "lipsync", "lip_sync"}
_NON_VIDEO_TYPES = {"image", "upscale", "text", "3d", "mesh_3d"}
_VIDEO_SUFFIXES = {".mp4", ".webm", ".mov", ".mkv"}


def is_video_task(
    payload_type: str | None,
    model_id: str | None,
    catalog: Iterable[Mapping[str, Any]],
) -> bool:
    """Vrai si la tâche produit une vidéo.

    Le type explicite de la requête prime sur le nom du modèle : une image NoctQ ne doit
    jamais être traitée comme une vidéo (sinon le tisseur audio la réécrit en MP4).
    """
    ptype = (payload_type or "").strip().lower()
    if ptype in _VIDEO_TYPES:
        return True
    if ptype in _NON_VIDEO_TYPES:
        return False
    mid = (model_id or "").lower()
    if any(m.get("id") == model_id and m.get("type") in {"video", "lipsync"} for m in catalog):
        return True
    return "minimax" in mid


def should_weave_audio(is_video: bool, output_path: str, parameters: Mapping[str, Any]) -> bool:
    """Ajoute la bande sonore uniquement sur un vrai conteneur vidéo."""
    if not is_video:
        return False
    if Path(output_path).suffix.lower() not in _VIDEO_SUFFIXES:
        return False
    return bool(parameters.get("autoVoiceOver", True))
