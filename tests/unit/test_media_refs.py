from __future__ import annotations

from app.services.media_refs import (
    extract_ingredient_refs,
    is_image_path,
    resolve_generation_ref,
    resolve_media_ref,
)

GENS = [
    {"id": "gen_aaa", "filePath": "/data/outputs/gen_aaa.mp4"},
    {"id": "gen_img", "filePath": "/data/outputs/gen_img.png"},
    {"id": "gen_bbb", "filePath": None},
]


def test_is_image_path_checks_real_signature(tmp_path) -> None:
    png = tmp_path / "ok.png"
    png.write_bytes(b"\x89PNG\r\n\x1a\n" + b"0" * 16)
    fake_png = tmp_path / "video_disguised.png"
    fake_png.write_bytes(b"\x00\x00\x00\x18ftypisom" + b"0" * 16)
    missing = tmp_path / "missing.png"

    assert is_image_path(str(png)) is True
    assert is_image_path(str(fake_png)) is False  # MP4 déguisé en .png
    assert is_image_path(str(missing)) is False


def test_resolve_generation_ref_by_id_and_url() -> None:
    assert resolve_generation_ref("gen_aaa", GENS) == "/data/outputs/gen_aaa.mp4"
    assert (
        resolve_generation_ref("/api/generations/gen_aaa/file", GENS)
        == "/data/outputs/gen_aaa.mp4"
    )


def test_resolve_generation_ref_unknown_or_without_file() -> None:
    assert resolve_generation_ref("gen_bbb", GENS) is None
    assert resolve_generation_ref("gen_zzz", GENS) is None
    assert resolve_generation_ref("/some/local/image.png", GENS) is None


def test_resolve_media_ref_handles_uploads_and_generations(tmp_path) -> None:
    uploads = tmp_path / "uploads"
    uploads.mkdir()
    sample = uploads / "voice_01.wav"
    sample.write_bytes(b"RIFF")

    assert resolve_media_ref("gen_aaa", GENS, uploads) == "/data/outputs/gen_aaa.mp4"
    assert (
        resolve_media_ref("/api/uploads/voice_01.wav", GENS, uploads)
        == str(sample.resolve())
    )
    assert resolve_media_ref("/raw/path.mp4", GENS, uploads) == "/raw/path.mp4"


def test_extract_ingredient_refs_parses_video_and_image_tokens() -> None:
    cleaned, imgs, vids = extract_ingredient_refs(
        "Double cette scène [Video:gen_aaa] avec le portrait [Image:gen_img] maintenant",
        GENS,
    )
    assert cleaned == "Double cette scène avec le portrait maintenant"
    assert imgs == ["/data/outputs/gen_img.png"]
    assert vids == ["/data/outputs/gen_aaa.mp4"]

