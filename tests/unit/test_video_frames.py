from __future__ import annotations

import asyncio
import shutil
from pathlib import Path

import pytest

from app.services.video_frames import extract_last_frame

FFMPEG = (
    "/home/instructeur/.local/bin/ffmpeg"
    if Path("/home/instructeur/.local/bin/ffmpeg").exists()
    else shutil.which("ffmpeg")
)

pytestmark = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg indisponible")


async def _make_clip(path: Path, seconds: float) -> None:
    proc = await asyncio.create_subprocess_exec(
        str(FFMPEG), "-v", "error", "-y",
        "-f", "lavfi", "-i", f"testsrc=duration={seconds}:size=128x72:rate=24",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()
    assert proc.returncode == 0, stderr.decode(errors="replace")


@pytest.mark.parametrize("seconds", [5.0, 0.5])
async def test_extract_last_frame_produces_png(tmp_path: Path, seconds: float) -> None:
    clip = tmp_path / "clip.mp4"
    out = tmp_path / "last.png"
    await _make_clip(clip, seconds)

    await extract_last_frame(clip, out)

    assert out.is_file()
    assert out.read_bytes().startswith(b"\x89PNG")



async def test_extract_last_frame_raises_on_invalid_input(tmp_path: Path) -> None:
    bad = tmp_path / "not_a_video.mp4"
    bad.write_bytes(b"garbage")
    with pytest.raises(RuntimeError):
        await extract_last_frame(bad, tmp_path / "out.png")
