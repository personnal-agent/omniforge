"""Moteur de découpage scénaristique et calcul intelligent de durée."""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

import httpx
from pydantic import BaseModel, Field

logger = logging.getLogger("story_director")

SEGMENT_LINE_RE = re.compile(
    r"^\s*(?:"
    r"(?:segment|plan|shot|sc[eè]ne|part|partie|clip|étape|etape)\s*\d+"
    r"|(?:\d{1,2}:\d{2}\s*[-–—àto]+\s*\d{1,2}:\d{2})"
    r"|(?:\d+\s*[\.\)\-])"
    r")"
    r"\s*(?:\([^\)]*\))?\s*[:\-–—\.]?\s*(.+)$",
    re.IGNORECASE,
)


class SegmentPlan(BaseModel):
    index: int = Field(..., description="Index 1-basé du segment")
    duration_sec: float = Field(..., description="Durée de ce segment en secondes")
    action_prompt: str = Field(..., description="Action spécifique à ce segment")
    shot_type: str = Field(default="Cinematic live-action", description="Type de plan caméra")


class ScriptPlan(BaseModel):
    total_duration_sec: float = Field(..., description="Durée totale calculée en secondes")
    num_segments: int = Field(..., description="Nombre total de segments consécutifs")
    segments: list[SegmentPlan] = Field(
        default_factory=list, description="Liste ordonnée des segments"
    )
    scene_overview: str = Field(
        default="", description="Description globale des personnages et du décor"
    )
    character_profiles: list[dict[str, Any]] = Field(
        default_factory=list,
        description="Profils d'identité persistants des personnages détectés",
    )


CHARACTER_DESCRIPTOR_RE = re.compile(
    r"\b((?:(?:fit|muscular|tall|slim|lean|athletic|elderly|young|stout|stocky|slender|vieux|vieille|jeune|bel|belle)\s+)?(?:\d{1,2}[-\s]year[-\s]old|\d{1,2}\s+ans)?\s*(?:American\s+|French\s+|Asian\s+|Black\s+|Caucasian\s+|Latin\s+|European\s+)?(?:man|woman|guy|girl|boy|person|fisherman|warrior|doctor|nurse|soldier|cop|officer|detective|chef|driver|homme|femme|pecheur|pêcheur|enfant|garçon|fille)\b[^.\n;]{10,160})",
    re.IGNORECASE,
)


def extract_character_profiles(
    prompt_text: str, segments: list[str] | None = None
) -> list[dict[str, Any]]:
    """Extrait automatiquement les profils d'identité des personnages décrits dans un scénario."""
    all_texts: list[tuple[int, str]] = []
    if segments:
        for idx, seg in enumerate(segments, start=1):
            all_texts.append((idx, seg))
    else:
        all_texts.append((1, prompt_text))

    profiles: list[dict[str, Any]] = []
    seen_sigs: set[str] = set()

    male_keywords = (
        "man",
        "he",
        "him",
        "his",
        "homme",
        "lui",
        "il",
        "son",
        "sa",
        "garçon",
        "boy",
        "guy",
        "fisherman",
        "pêcheur",
    )
    female_keywords = ("woman", "she", "her", "femme", "elle", "sa", "fille", "girl")

    for seg_idx, text in all_texts:
        matches = CHARACTER_DESCRIPTOR_RE.findall(text)
        for raw_desc in matches:
            clean = raw_desc.strip(" \t\n\r,.-")
            if len(clean) < 15:
                continue
            lower = clean.lower()

            is_female = any(
                re.search(rf"\b{kw}\b", lower)
                for kw in ("woman", "girl", "femme", "fille", "actress", "she", "her", "elle")
            )
            is_male = any(
                re.search(rf"\b{kw}\b", lower)
                for kw in (
                    "man",
                    "boy",
                    "guy",
                    "homme",
                    "garçon",
                    "he",
                    "him",
                    "his",
                    "fisherman",
                    "pêcheur",
                )
            )

            if is_female and not is_male:
                gender = "female"
                label = "Female character"
            elif is_male and not is_female:
                gender = "male"
                label = "Male character"
            else:
                gender = "neutral"
                label = "Subject"

            sig = f"{gender}_{clean[:25].lower()}"
            if sig in seen_sigs:
                continue
            seen_sigs.add(sig)

            char_id = f"char_{len(profiles) + 1}_{gender}"
            profiles.append(
                {
                    "id": char_id,
                    "gender": gender,
                    "label": label,
                    "description": clean,
                    "first_seen_segment": seg_idx,
                    "keywords": list(female_keywords if gender == "female" else male_keywords),
                }
            )

    return profiles


def infer_scene_overview(
    global_context: str,
    script_segments: list[str],
    char_profiles: list[dict[str, Any]] | None = None,
) -> str:
    """Construit un résumé permanent du décor et des personnages présent dans tous les plans."""
    if global_context and len(global_context.strip()) > 15:
        return global_context.strip()

    chars = char_profiles or extract_character_profiles(
        " ".join(script_segments[:4]), script_segments
    )
    if chars:
        char_desc_list = [f"{c['label']}: {c['description']}" for c in chars]
        return " | ".join(char_desc_list)

    return (
        "Consistent live-action scene with stable environment, natural lighting, "
        "and continuous subjects across all shots."
    )


def filter_active_character_profiles(
    action_prompt: str,
    char_profiles: list[dict[str, Any]] | None,
) -> list[dict[str, Any]]:
    """Retourne les personnages mentionnés dans `action_prompt` (ou tous si aucun n'est nommé)."""
    if not char_profiles:
        return []
    if not action_prompt or not action_prompt.strip():
        return list(char_profiles)

    matched: list[dict[str, Any]] = []
    for c in char_profiles:
        candidates: list[str] = []
        for key in ("triggerToken", "name", "label"):
            val = c.get(key)
            if val and isinstance(val, str):
                clean_val = val.strip().lstrip("@").strip()
                if len(clean_val) >= 2 and clean_val.lower() not in {x.lower() for x in candidates}:
                    candidates.append(clean_val)

        if any(
            re.search(rf"(?:@|\b){re.escape(cand)}\b", action_prompt, flags=re.IGNORECASE)
            for cand in candidates
        ):
            matched.append(c)

    return matched if matched else list(char_profiles)


def build_chained_segment_prompt(
    seg_idx: int,
    total_segs: int,
    action_prompt: str,
    scene_overview: str = "",
    char_profiles: list[dict[str, Any]] | None = None,
) -> str:
    """Construit le prompt enrichi ComfyUI assurant la persistance des personnages."""
    quality_guard = (
        "Photorealistic live-action cinema, anatomically accurate human proportions, "
        "natural faces and hands, no deformations, no morphing, no extra limbs, "
        "natural real-time 1x human speed (deliberate unhurried movements), "
        "no text, subtitles, or watermarks."
    )
    audio_guard = (
        "Audio: Continuous realistic room acoustics, authentic natural human sounds "
        "matching physical action with consistent voice timbre, no abrupt audio cuts."
    )

    active_profiles = filter_active_character_profiles(action_prompt, char_profiles)
    char_blocks = ""
    if active_profiles:
        items = []
        for c in active_profiles:
            lbl = c.get("label") or c.get("name") or "Personnage"
            desc = c.get("description") or c.get("physicalPrompt") or ""
            arch = c.get("archetype")
            anchors = c.get("visualAnchors")
            line = f"- {lbl}"
            if arch and str(arch).strip() not in ("", "None", "null"):
                line += f" ({arch})"
            if desc:
                line += f": {desc}"
            if anchors and isinstance(anchors, list):
                line += f" [Anchors: {', '.join(anchors)}]"
            items.append(line)

        continuity_notice = (
            "Strictly maintain exact same faces, distinctive visual anchors, hairstyles, "
            "skin tones, body build, and equipment/attire across all shots."
        )
        char_blocks = (
            f"\n[Character Identity Continuity Anchors:\n{chr(10).join(items)}"
            f"\n{continuity_notice}]\n"
        )

    if seg_idx == 1:
        parts = []
        if scene_overview:
            parts.append(f"Scene & Setting Overview: {scene_overview}")
        if char_blocks:
            parts.append(char_blocks.strip())
        parts.append(f"Current shot action: {action_prompt}")
        parts.append(audio_guard)
        parts.append(quality_guard)
        return "\n".join(parts)

    parts = [
        "The scene opens directly on <Picture 1>.",
        (
            "Strictly preserve the exact same character identities, facial features, "
            "distinctive visual anchors, hairstyle, and equipment/attire from <Picture 1>, "
            "while staging the environment and action of the current shot."
        ),
    ]
    if char_blocks:
        parts.append(char_blocks.strip())
    elif scene_overview:
        parts.append(f"Scene Continuity: {scene_overview}")
    parts.append(f"Current shot action continuing smoothly from <Picture 1>: {action_prompt}")
    parts.append(audio_guard)
    parts.append(quality_guard)
    return "\n".join(parts)


def parse_explicit_script_segments(prompt_text: str) -> tuple[str, list[str]]:
    """Analyse si un prompt contient déjà des plans numérotés ou horodatés."""
    # Normaliser les plans en ligne unique en lignes distinctes
    norm_text = re.sub(
        r"(?i)(?<=[^\n])\s+(?=(?:plan|shot|segment|sc[eè]ne|clip|partie)\s*\d+\s*[:\-–—\.])",
        "\n",
        prompt_text.strip(),
    )
    lines = [line.strip() for line in norm_text.splitlines() if line.strip()]
    if len(lines) <= 1:
        return prompt_text.strip(), []

    global_lines: list[str] = []
    segments: list[str] = []

    for line in lines:
        m = SEGMENT_LINE_RE.match(line)
        if m:
            action = m.group(1).strip()
            if action:
                segments.append(action)
        else:
            if not segments:
                global_lines.append(line)
            else:
                segments[-1] = f"{segments[-1]} {line}"

    if len(segments) >= 2:
        return " ".join(global_lines).strip(), segments

    return prompt_text.strip(), []


def calculate_segments_duration(total_sec: float, max_segment_sec: float = 10.0) -> list[float]:
    """Découpe une durée totale en tranches de max 10.0s."""
    total = max(1.0, float(total_sec))
    max_seg = max(2.0, float(max_segment_sec))

    if total <= max_seg:
        return [round(total, 1)]

    full_count = int(total // max_seg)
    remainder = round(total % max_seg, 1)

    durations = [max_seg] * full_count
    if remainder > 0.4:
        durations.append(remainder)
    elif durations:
        durations[-1] = round(durations[-1] + remainder, 1)

    return durations


class StoryDirector:
    """Analyseur scénaristique intelligent connecté au LLM local (Qwen 3.5)."""

    def __init__(self, bionic_url: str | None = None) -> None:
        self.bionic_url = bionic_url or os.getenv("BIONIC_API_URL", "http://172.22.32.1:1235/v1")

    async def plan_timeline(
        self, prompt: str, target_total_sec: float | None = None, max_segment_sec: float = 10.0
    ) -> ScriptPlan:
        """Détermine la durée totale nécessaire et découpe en segments cohérents."""
        clean_prompt = prompt.strip()

        # 1. Vérifier si l'utilisateur a écrit des plans explicites
        global_ctx, explicit_segs = parse_explicit_script_segments(clean_prompt)
        if explicit_segs:
            total_sec = target_total_sec or float(len(explicit_segs) * max_segment_sec)
            durations = calculate_segments_duration(total_sec, max_segment_sec)

            # Aligner les segments
            plan_segments: list[SegmentPlan] = []
            for i, d in enumerate(durations):
                action = explicit_segs[i] if i < len(explicit_segs) else explicit_segs[-1]
                plan_segments.append(
                    SegmentPlan(
                        index=i + 1,
                        duration_sec=d,
                        action_prompt=action,
                    )
                )

            char_profiles = extract_character_profiles(clean_prompt, explicit_segs)
            overview = infer_scene_overview(global_ctx, explicit_segs, char_profiles)

            return ScriptPlan(
                total_duration_sec=sum(durations),
                num_segments=len(plan_segments),
                segments=plan_segments,
                scene_overview=overview,
                character_profiles=char_profiles,
            )

        # 2. Si durée imposée sans LLM
        if target_total_sec is not None and target_total_sec > 0:
            durations = calculate_segments_duration(target_total_sec, max_segment_sec)
            plan_segments = [
                SegmentPlan(
                    index=i + 1,
                    duration_sec=d,
                    action_prompt=f"{clean_prompt} (Partie {i + 1}/{len(durations)})",
                )
                for i, d in enumerate(durations)
            ]
            char_profiles = extract_character_profiles(clean_prompt)
            overview = infer_scene_overview(
                "", [s.action_prompt for s in plan_segments], char_profiles
            )
            return ScriptPlan(
                total_duration_sec=sum(durations),
                num_segments=len(plan_segments),
                segments=plan_segments,
                scene_overview=overview or clean_prompt[:200],
                character_profiles=char_profiles,
            )

        # 3. Interrogation du LLM local (Qwen 3.5 via Bionic) pour chiffrer la scène
        llm_plan = await self._query_llm_timeline(clean_prompt, max_segment_sec)
        if llm_plan:
            return llm_plan

        # 4. Repli déterministe basé sur les phrases du prompt
        return self._heuristic_plan(clean_prompt, max_segment_sec)

    async def _query_llm_timeline(self, prompt: str, max_segment_sec: float) -> ScriptPlan | None:
        """Appelle le LLM Qwen 3.5 pour analyser le rythme et chiffrer la durée."""
        system_instruction = (
            "Tu es un Réalisateur et Monteur Cinéma. Analyse le prompt soumis par l'utilisateur "
            "pour déterminer la durée totale réaliste en secondes nécessaire pour accomplir "
            "toutes les actions sans les précipiter. "
            f"Découpe ensuite cette durée en segments consécutifs de MAXIMUM {max_segment_sec}s. "
            "Exemple : si 467 secondes sont nécessaires, produis 46 plans de 10.0s et 1 de 7.0s. "
            "Pour chaque segment, fournis l'action spécifique en anglais cinématographique "
            "avec une continuité visuelle fluide. "
            "Réponds UNIQUEMENT avec un JSON strict selon ce modèle :\n"
            "{\n"
            '  "total_duration_sec": 467.0,\n'
            '  "scene_overview": "Description permanente du décor et des personnages",\n'
            '  "segments": [\n'
            '    {"index": 1, "duration_sec": 10.0, "action_prompt": "Action 1", '
            '"shot_type": "Medium"}\n'
            "  ]\n"
            "}"
        )

        user_content = (
            f"Analyse cette scène et découpe-la en plans de max {max_segment_sec}s :\n\n{prompt}"
        )

        endpoints = [
            self.bionic_url,
            "http://127.0.0.1:1235/v1",
            "http://localhost:1235/v1",
        ]

        for base_url in endpoints:
            try:
                async with httpx.AsyncClient(timeout=15.0) as client:
                    resp = await client.post(
                        f"{base_url.rstrip('/')}/chat/completions",
                        json={
                            "messages": [
                                {"role": "system", "content": system_instruction},
                                {"role": "user", "content": user_content},
                            ],
                            "temperature": 0.4,
                            "max_tokens": 3000,
                        },
                    )
                    if resp.status_code == 200:
                        data = resp.json()
                        raw_text = data["choices"][0]["message"]["content"].strip()

                        json_match = re.search(r"\{.*\}", raw_text, re.DOTALL)
                        if json_match:
                            parsed = json.loads(json_match.group(0))
                            tot_sec = float(parsed.get("total_duration_sec", 10.0))
                            overview = parsed.get("scene_overview", "")
                            raw_segs = parsed.get("segments", [])

                            durations = calculate_segments_duration(tot_sec, max_segment_sec)
                            final_segs: list[SegmentPlan] = []

                            for i, d in enumerate(durations):
                                act = (
                                    raw_segs[i].get("action_prompt")
                                    if i < len(raw_segs)
                                    else f"Continuation of the action: {prompt[:80]}"
                                )
                                s_type = (
                                    raw_segs[i].get("shot_type", "Cinematic")
                                    if i < len(raw_segs)
                                    else "Cinematic"
                                )
                                final_segs.append(
                                    SegmentPlan(
                                        index=i + 1,
                                        duration_sec=d,
                                        action_prompt=act,
                                        shot_type=s_type,
                                    )
                                )

                            return ScriptPlan(
                                total_duration_sec=sum(durations),
                                num_segments=len(final_segs),
                                segments=final_segs,
                                scene_overview=overview or prompt[:200],
                            )
            except Exception as e:
                logger.debug("Tentative LLM Bionic sur %s échouée: %s", base_url, e)

        return None

    def _heuristic_plan(self, prompt: str, max_segment_sec: float) -> ScriptPlan:
        """Découpage déterministe si le LLM n'est pas disponible."""
        clauses = [c.strip() for c in re.split(r"[\.\n;]+", prompt) if len(c.strip()) > 8]

        if not clauses:
            clauses = [prompt]

        estimated_sec = max(10.0, float(len(clauses) * 10.0))
        durations = calculate_segments_duration(estimated_sec, max_segment_sec)

        segments: list[SegmentPlan] = []
        for i, d in enumerate(durations):
            clause_idx = min(i, len(clauses) - 1)
            segments.append(
                SegmentPlan(
                    index=i + 1,
                    duration_sec=d,
                    action_prompt=f"{clauses[clause_idx]}, natural continuous motion",
                    shot_type="Cinematic",
                )
            )

        char_profiles = extract_character_profiles(prompt, [s.action_prompt for s in segments])
        overview = infer_scene_overview("", [s.action_prompt for s in segments], char_profiles)

        return ScriptPlan(
            total_duration_sec=sum(durations),
            num_segments=len(segments),
            segments=segments,
            scene_overview=overview or prompt[:200],
            character_profiles=char_profiles,
        )
