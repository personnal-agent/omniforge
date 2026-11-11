"""Résolution et validation des références média (images d'ancrage, plans précédents)."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_IMAGE_MAGIC: tuple[bytes, ...] = (
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",  # JPEG
    b"RIFF",  # WebP (RIFF....WEBP)
    b"GIF8",
    b"BM",
)

_INGREDIENT_TOKEN_RE = re.compile(
    r"\[(?P<kind>Video|Image):(?P<gen_id>[a-zA-Z0-9_\-]+)\]",
    re.IGNORECASE,
)


def is_image_path(path_str: str | None) -> bool:
    """Vrai si le fichier existe ET que sa signature binaire est celle d'une image.

    L'extension seule ne suffit pas : une fiche personnage peut pointer vers un MP4
    nommé `.png`, ce qui ferait échouer (ou fausserait) le conditionnement I2V.
    """
    if not path_str:
        return False
    p = Path(path_str)
    if not p.is_file():
        return False
    try:
        with p.open("rb") as fh:
            head = fh.read(12)
    except OSError:
        return False
    return any(head.startswith(magic) for magic in _IMAGE_MAGIC)


def resolve_generation_ref(src: str | None, generations: list[dict[str, Any]]) -> str | None:
    """Convertit `gen_xxx` ou `/api/generations/gen_xxx/file` en chemin disque, sinon None."""
    if not src:
        return None
    candidate = src.strip()
    gen_id: str | None = None
    if "/api/generations/" in candidate:
        gen_id = candidate.split("/api/generations/")[1].split("/")[0]
    elif candidate.startswith("gen_") and len(candidate) <= 20 and "/" not in candidate:
        gen_id = candidate
    if not gen_id:
        return None
    found = next((g for g in generations if g.get("id") == gen_id), None)
    file_path = found.get("filePath") if found else None
    return str(file_path) if file_path else None


def resolve_media_ref(
    src: str | None,
    generations: list[dict[str, Any]],
    uploads_dir: Path | None = None,
) -> str:
    """Résout une référence (`gen_xxx`, `/api/generations/...`, `/api/uploads/...`) sur disque."""
    if not src:
        return ""
    candidate = src.strip()
    gen_path = resolve_generation_ref(candidate, generations)
    if gen_path:
        return gen_path
    if uploads_dir and "/api/uploads/" in candidate:
        fn = candidate.split("/api/uploads/")[1].split("?")[0]
        up_p = uploads_dir / fn
        if up_p.is_file():
            return str(up_p.resolve())
    return candidate


def extract_ingredient_refs(
    prompt: str,
    generations: list[dict[str, Any]],
) -> tuple[str, list[str], list[str]]:
    """Extrait `[Video:gen_xxx]` et `[Image:gen_xxx]` du prompt vers `(prompt, imgs, vids)`."""
    if not prompt:
        return "", [], []

    image_paths: list[str] = []
    video_paths: list[str] = []

    def _replace(match: re.Match[str]) -> str:
        kind = match.group("kind").lower()
        gen_id = match.group("gen_id")
        resolved = resolve_generation_ref(gen_id, generations)
        if resolved:
            if kind == "video" and resolved not in video_paths:
                video_paths.append(resolved)
            elif kind == "image" and resolved not in image_paths:
                image_paths.append(resolved)
        return ""

    cleaned = _INGREDIENT_TOKEN_RE.sub(_replace, prompt)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return cleaned, image_paths, video_paths

