from __future__ import annotations

from app.services.task_kind import is_video_task, should_weave_audio

CATALOG = [
    {"id": "noctq-v4", "type": "image"},
    {"id": "minimax-h3", "type": "video"},
    {"id": "latentsync", "type": "lipsync"},
]


def test_noctq_image_is_never_a_video_task() -> None:
    assert is_video_task("image", "noctq-v4", CATALOG) is False
    assert is_video_task(None, "noctq-v4", CATALOG) is False


def test_video_and_lipsync_types_are_video_tasks() -> None:
    assert is_video_task("video", "minimax-h3", CATALOG) is True
    assert is_video_task("lip_sync", "latentsync", CATALOG) is True
    assert is_video_task("lipsync", "unknown-model", CATALOG) is True


def test_explicit_non_video_type_wins_over_model_name() -> None:
    assert is_video_task("image", "minimax-h3", CATALOG) is False
    assert is_video_task("upscale", "minimax-h3", CATALOG) is False


def test_catalog_and_name_fallback_when_type_missing() -> None:
    assert is_video_task(None, "minimax-h3", CATALOG) is True
    assert is_video_task(None, "minimax-custom", []) is True
    assert is_video_task(None, "something", []) is False


def test_weave_audio_only_for_video_containers() -> None:
    assert should_weave_audio(True, "out/a.mp4", {"autoVoiceOver": True}) is True
    assert should_weave_audio(True, "out/a.png", {"autoVoiceOver": True}) is False
    assert should_weave_audio(False, "out/a.mp4", {"autoVoiceOver": True}) is False
    assert should_weave_audio(True, "out/a.mp4", {"autoVoiceOver": False}) is False
    assert should_weave_audio(True, "out/a.mp4", {}) is True  # défaut historique
