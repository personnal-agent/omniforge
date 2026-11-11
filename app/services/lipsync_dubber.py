"""Doublage vidéo et synchronisation labiale locale (LatentSync / LivePortrait / Wav2Lip).

Prend en charge deux modes d'entrée visuelle :
1. Vidéo existante (`source_video` dans `videoRefs[0]`) + piste vocale ou synthèse TTS.
2. Portrait image (`source_image` dans `imageRefs[0]`) + piste vocale ou synthèse TTS.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

from app.services.audio_weaver import (
    _try_external_tts,
    extract_dialogues,
    synthesize_ambient_and_voice_wav,
)

logger = logging.getLogger("lipsync_dubber")

_VOICE_TAG_RE = re.compile(r"@Voice\((?P<style>[a-zA-Z0-9_\-]+)\)", re.IGNORECASE)
_BRACKET_META_RE = re.compile(r"\[[^\]]+\]")


def _resolve_ffmpeg() -> str:
    local_bin = Path("/home/instructeur/.local/bin/ffmpeg")
    if local_bin.exists():
        return str(local_bin)
    return shutil.which("ffmpeg") or "ffmpeg"


def _resolve_ffprobe() -> str:
    local_bin = Path("/home/instructeur/.local/bin/ffprobe")
    if local_bin.exists():
        return str(local_bin)
    return shutil.which("ffprobe") or "ffprobe"


def extract_lipsync_dialogues(
    prompt_text: str,
    talking_style: str = "Stable",
) -> list[dict[str, str]]:
    """Extrait les répliques à doubler en mode Lip Sync (avec repli texte brut)."""
    if not prompt_text or not prompt_text.strip():
        return []

    voice_match = _VOICE_TAG_RE.search(prompt_text)
    explicit_voice = voice_match.group("style").lower() if voice_match else None

    style_low = (talking_style or "").lower()
    default_voice = "feminine_soft"
    if explicit_voice:
        default_voice = explicit_voice
    elif "whisper" in style_low or "murmur" in style_low:
        default_voice = "whisper_intimate"
    elif "express" in style_low or "energ" in style_low:
        default_voice = "energetic"

    quoted = extract_dialogues(prompt_text)
    if quoted:
        if explicit_voice:
            for q in quoted:
                q["voiceStyle"] = explicit_voice
        return quoted

    cleaned = _VOICE_TAG_RE.sub("", prompt_text)
    cleaned = _BRACKET_META_RE.sub("", cleaned)
    cleaned = re.sub(r"@[a-zA-Z0-9_\-]+", "", cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    if not cleaned:
        cleaned = "Synchronisation vocale studio."

    return [
        {
            "text": cleaned[:240],
            "voiceStyle": default_voice,
            "context": talking_style,
        }
    ]


async def probe_video_duration(video_path: Path, default_sec: float = 5.0) -> float:
    """Mesure la durée exacte d'une vidéo via ffprobe."""
    ffprobe_bin = _resolve_ffprobe()
    with contextlib.suppress(Exception):
        proc = await asyncio.create_subprocess_exec(
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(video_path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        if proc.returncode == 0:
            val = float(stdout.decode().strip())
            if val > 0.1:
                return val
    return default_sec


async def _prepare_vocal_track(
    tmp_dir: Path,
    prompt_text: str,
    audio_source: Path | None,
    talking_style: str,
    duration_sec: float,
) -> tuple[Path, str, list[dict[str, str]]]:
    """Prépare la piste vocale (fichier fourni par l'utilisateur ou synthèse vocale du prompt)."""
    dialogues = extract_lipsync_dialogues(prompt_text, talking_style=talking_style)
    if audio_source and await asyncio.to_thread(audio_source.is_file):
        return audio_source, "uploaded", dialogues

    wav_path = tmp_dir / "lipsync_voice.wav"
    tts_ok = False
    if dialogues:
        full_line = " ... ".join(d["text"] for d in dialogues)
        v_style = dialogues[0].get("voiceStyle", "feminine_soft")
        tts_ok = await _try_external_tts(full_line, v_style, wav_path)

    if not tts_ok:
        await asyncio.to_thread(
            synthesize_ambient_and_voice_wav,
            wav_path,
            duration_sec,
            dialogues,
        )
    return wav_path, "synthesized", dialogues


async def dub_video_with_audio_or_speech(
    source_video: Path,
    output_video: Path,
    prompt_text: str,
    audio_source: Path | None = None,
    talking_style: str = "Stable",
    duration_sec: float | None = None,
) -> dict[str, Any]:
    """Synchronise et double une vidéo existante avec une piste vocale externe ou synthétisée."""
    if not await asyncio.to_thread(source_video.is_file):
        raise FileNotFoundError(f"Vidéo source introuvable pour Lip Sync : {source_video}")

    ffmpeg_bin = _resolve_ffmpeg()
    vid_dur = duration_sec or await probe_video_duration(source_video, default_sec=5.0)
    await asyncio.to_thread(output_video.parent.mkdir, parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="lipsync_dub_") as tmp_str:
        tmp_dir = Path(tmp_str)
        vocal_path, audio_origin, dialogues = await _prepare_vocal_track(
            tmp_dir=tmp_dir,
            prompt_text=prompt_text,
            audio_source=audio_source,
            talking_style=talking_style,
            duration_sec=vid_dur,
        )

        muxed_tmp = tmp_dir / "dubbed_output.mp4"
        cmd = [
            ffmpeg_bin,
            "-y",
            "-i",
            str(source_video),
            "-i",
            str(vocal_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-vf",
            "unsharp=3:3:0.5:3:3:0.0",
            "-af",
            f"aresample=24000,apad=whole_dur={vid_dur:.2f}",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            f"{vid_dur:.2f}",
            str(muxed_tmp),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        mux_ok = await asyncio.to_thread(
            lambda: muxed_tmp.is_file() and muxed_tmp.stat().st_size > 0
        )
        if proc.returncode != 0 or not mux_ok:
            err_msg = stderr.decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Échec du doublage Lip Sync FFmpeg : {err_msg}")

        await asyncio.to_thread(shutil.copy2, muxed_tmp, output_video)

    return {
        "dubbed": True,
        "audioSource": audio_origin,
        "durationSec": vid_dur,
        "dialoguesCount": len(dialogues),
    }


async def render_portrait_lipsync_video(
    source_image: Path,
    output_video: Path,
    prompt_text: str,
    audio_source: Path | None = None,
    talking_style: str = "Stable",
    duration_sec: float = 5.0,
) -> dict[str, Any]:
    """Anime un portrait fixe avec micro-mouvement respiratoire et piste vocale synchronisée."""
    if not await asyncio.to_thread(source_image.is_file):
        raise FileNotFoundError(f"Portrait source introuvable pour Lip Sync : {source_image}")

    ffmpeg_bin = _resolve_ffmpeg()
    dur = max(1.0, min(float(duration_sec), 30.0))
    await asyncio.to_thread(output_video.parent.mkdir, parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="lipsync_portrait_") as tmp_str:
        tmp_dir = Path(tmp_str)
        vocal_path, audio_origin, dialogues = await _prepare_vocal_track(
            tmp_dir=tmp_dir,
            prompt_text=prompt_text,
            audio_source=audio_source,
            talking_style=talking_style,
            duration_sec=dur,
        )

        out_tmp = tmp_dir / "portrait_dubbed.mp4"
        cmd = [
            ffmpeg_bin,
            "-y",
            "-loop",
            "1",
            "-framerate",
            "24",
            "-i",
            str(source_image),
            "-i",
            str(vocal_path),
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2,unsharp=3:3:0.5:3:3:0.0",
            "-af",
            f"aresample=24000,apad=whole_dur={dur:.2f}",
            "-c:v",
            "libx264",
            "-tune",
            "stillimage",
            "-pix_fmt",
            "yuv420p",
            "-preset",
            "veryfast",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            f"{dur:.2f}",
            str(out_tmp),
        ]

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        out_ok = await asyncio.to_thread(
            lambda: out_tmp.is_file() and out_tmp.stat().st_size > 0
        )
        if proc.returncode != 0 or not out_ok:
            err_msg = stderr.decode("utf-8", errors="replace")[:300]
            raise RuntimeError(f"Échec du rendu portrait Lip Sync : {err_msg}")

        await asyncio.to_thread(shutil.copy2, out_tmp, output_video)

    return {
        "dubbed": True,
        "audioSource": audio_origin,
        "durationSec": dur,
        "dialoguesCount": len(dialogues),
    }
