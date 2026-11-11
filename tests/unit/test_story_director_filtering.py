from __future__ import annotations

from app.services.story_director import (
    build_chained_segment_prompt,
    filter_active_character_profiles,
)

PROFILES = [
    {
        "id": "char_a54bffeb",
        "label": "Astrid",
        "name": "Astrid",
        "triggerToken": "@Astrid",
        "description": "Nordic valkyrie warrior with platinum braided hair and glowing cyan runes",
        "visualAnchors": ["platinum braid", "cyan glowing runes", "silver winged armor"],
    },
    {
        "id": "char_c6a4fc32",
        "label": "Elena",
        "name": "Elena",
        "triggerToken": "@Elena",
        "description": "Cyberpunk netrunner with silver cropped hair",
        "visualAnchors": ["silver cropped hair", "ocular implant"],
    },
]


def test_filter_active_character_profiles_isolates_mentioned_character() -> None:
    only_astrid = filter_active_character_profiles(
        "@Astrid avance seule dans les ruines gelées.", PROFILES
    )
    assert [c["id"] for c in only_astrid] == ["char_a54bffeb"]

    only_elena = filter_active_character_profiles(
        "Elena scanne l'horizon avec son implant oculaire.", PROFILES
    )
    assert [c["id"] for c in only_elena] == ["char_c6a4fc32"]

    both = filter_active_character_profiles(
        "@Elena rejoint @Astrid devant le portail.", PROFILES
    )
    assert [c["id"] for c in both] == ["char_a54bffeb", "char_c6a4fc32"]


def test_filter_active_character_profiles_falls_back_to_all_when_none_named() -> None:
    fallback = filter_active_character_profiles(
        "Les deux guerrières franchissent le portail illuminé.", PROFILES
    )
    assert len(fallback) == 2


def test_build_chained_segment_prompt_excludes_absent_characters() -> None:
    prompt_seg1 = build_chained_segment_prompt(
        seg_idx=1,
        total_segs=4,
        action_prompt="@Astrid avance seule dans les ruines gelées.",
        scene_overview="Ruines nordiques sous la neige",
        char_profiles=PROFILES,
    )
    assert "Astrid" in prompt_seg1
    assert "platinum braid" in prompt_seg1
    assert "Elena" not in prompt_seg1
    assert "ocular implant" not in prompt_seg1
