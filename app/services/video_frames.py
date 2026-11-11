"""Extraction de la dernière image d'une vidéo (ancrage de continuité entre plans)."""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

_LOCAL_FFMPEG = Path("/home/instructeur/.local/bin/ffmpeg")
# Un décalage trop court (-0.1 s) ne produit parfois aucune image selon le GOP du clip :
# on élargit progressivement la fenêtre de recherche depuis la fin.
_SEEK_OFFSETS = ("-0.1", "-0.3", "-0.5", "-1")


def _ffmpeg_bin() -> str:
    if _LOCAL_FFMPEG.exists():
        return str(_LOCAL_FFMPEG)
    return shutil.which("ffmpeg") or "ffmpeg"


async def extract_last_frame(video_path: Path, output_png: Path) -> None:
    """Écrit la dernière image de `video_path` dans `output_png` (PNG).

    Lève RuntimeError si aucun décalage ne produit d'image.
    """
    last_err = ""
    for offset in _SEEK_OFFSETS:
        await asyncio.to_thread(output_png.unlink, missing_ok=True)
        proc = await asyncio.create_subprocess_exec(
            _ffmpeg_bin(), "-v", "error", "-sseof", offset, "-i", str(video_path),
            "-update", "1", "-q:v", "2", str(output_png), "-y",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        produced = await asyncio.to_thread(
            lambda: output_png.is_file() and output_png.stat().st_size > 0
        )
        if proc.returncode == 0 and produced:
            return
        last_err = stderr.decode("utf-8", errors="ignore")
    raise RuntimeError(f"Échec extraction dernière frame via ffmpeg: {last_err}")
