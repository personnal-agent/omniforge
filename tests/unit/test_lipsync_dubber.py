from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest

from app.services.audio_weaver import synthesize_ambient_and_voice_wav
from app.services.lipsync_dubber import (
    dub_video_with_audio_or_speech,
    extract_lipsync_dialogues,
    render_portrait_lipsync_video,
)

FFMPEG = (
    "/home/instructeur/.local/bin/ffmpeg"
    if Path("/home/instructeur/.local/bin/ffmpeg").exists()
    else shutil.which("ffmpeg")
)

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg indisponible")


async def _make_silent_video(path: Path, seconds: float = 2.0) -> None:
    proc = await asyncio.create_subprocess_exec(
        str(FFMPEG), "-v", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=160x90:rate=24",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    assert proc.returncode == 0, stderr.decode(errors="replace")


async def _make_portrait_png(path: Path) -> None:
    proc = await asyncio.create_subprocess_exec(
        str(FFMPEG), "-v", "error", "-y",
        "-f", "lavfi", "-i", "color=c=navy:s=160x90:d=0.1",
        "-frames:v", "1", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    assert proc.returncode == 0, stderr.decode(errors="replace")


def test_extract_lipsync_dialogues_falls_back_to_plain_prompt() -> None:
    res = extract_lipsync_dialogues(
        "@Voice(whisper_intimate) Nous devons sceller le portail avant la tempête.",
        talking_style="Stable",
    )
    assert len(res) == 1
    assert "Nous devons sceller le portail" in res[0]["text"]
    assert res[0]["voiceStyle"] == "whisper_intimate"


async def test_dub_video_with_uploaded_audio(tmp_path: Path) -> None:
    src_vid = tmp_path / "input.mp4"
    src_wav = tmp_path / "voice.wav"
    out_vid = tmp_path / "dubbed.mp4"

    await _make_silent_video(src_vid, 2.0)
    synthesize_ambient_and_voice_wav(
        src_wav,
        duration_sec=2.0,
        dialogues=[{"text": "Bonjour Astrid", "voiceStyle": "feminine_soft"}],
    )

    meta = await dub_video_with_audio_or_speech(
        source_video=src_vid,
        output_video=out_vid,
        prompt_text="Synchronisation labiale",
        audio_source=src_wav,
        talking_style="Expressive",
    )
    assert meta["dubbed"] is True
    assert meta["audioSource"] == "uploaded"
    assert out_vid.is_file()
    assert out_vid.stat().st_size > 1000


async def test_dub_video_with_prompt_speech(tmp_path: Path) -> None:
    src_vid = tmp_path / "input_silent.mp4"
    out_vid = tmp_path / "dubbed_tts.mp4"

    await _make_silent_video(src_vid, 2.0)

    meta = await dub_video_with_audio_or_speech(
        source_video=src_vid,
        output_video=out_vid,
        prompt_text="Le signal d'Elena est verrouillé sur le secteur nord.",
        audio_source=None,
        talking_style="Stable",
    )
    assert meta["dubbed"] is True
    assert meta["audioSource"] == "synthesized"
    assert out_vid.is_file()
    assert out_vid.stat().st_size > 1000


async def test_render_portrait_lipsync_video(tmp_path: Path) -> None:
    portrait = tmp_path / "portrait.png"
    out_vid = tmp_path / "portrait_talking.mp4"
    await _make_portrait_png(portrait)

    meta = await render_portrait_lipsync_video(
        source_image=portrait,
        output_video=out_vid,
        prompt_text="Je vous écoute.",
        audio_source=None,
        talking_style="Whisper",
        duration_sec=2.0,
    )
    assert meta["dubbed"] is True
    assert out_vid.is_file()
    assert out_vid.stat().st_size > 1000
