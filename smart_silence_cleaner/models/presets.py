"""The editing modes (presets) and the manager that hands them out.

Each preset bundles creator-facing copy (icon / title / description) with the
raw :class:`SilenceSettings` it stands for. The exact numbers come straight from
the product spec so the modes behave predictably.
"""

from __future__ import annotations

from dataclasses import dataclass

from .settings import SilenceSettings


@dataclass(frozen=True, slots=True)
class Preset:
    """A named editing mode shown as a large card in the UI."""

    id: str
    icon: str
    title: str
    description: str
    settings: SilenceSettings
    #: Custom is the only mode whose sliders/advanced params are user-editable.
    editable: bool = False


# --------------------------------------------------------------------------- #
# The five modes                                                              #
# --------------------------------------------------------------------------- #

CONSERVATIVE = Preset(
    id="conservative",
    icon="🐢",
    title="Keep More Natural Pauses",
    description=(
        "Perfect for storytelling, interviews, podcasts, emotional videos and "
        "cinematic pacing. Very light trimming."
    ),
    settings=SilenceSettings(
        min_gap_ms=450,
        target_pause_ms=280,
        sentence_pause_ms=450,
        comma_pause_ms=300,
        merge_gap_ms=140,
        pad_before_ms=90,
        pad_after_ms=110,
        keep_sentence_flow=True,
        remove_fillers=False,
        smart_silence=True,
    ),
)

BALANCED = Preset(
    id="balanced",
    icon="⚖️",
    title="Recommended",
    description="Removes awkward dead air while keeping speech natural. This is the default.",
    settings=SilenceSettings(
        min_gap_ms=300,
        target_pause_ms=180,
        sentence_pause_ms=350,
        comma_pause_ms=250,
        merge_gap_ms=100,
        pad_before_ms=60,
        pad_after_ms=80,
        keep_sentence_flow=True,
        remove_fillers=False,
        smart_silence=True,
    ),
)

AGGRESSIVE = Preset(
    id="aggressive",
    icon="⚡",
    title="Fast Paced",
    description="Creates energetic YouTube Shorts, Reels and TikTok-style pacing.",
    settings=SilenceSettings(
        min_gap_ms=180,
        target_pause_ms=80,
        sentence_pause_ms=220,
        comma_pause_ms=150,
        merge_gap_ms=80,
        pad_before_ms=40,
        pad_after_ms=50,
        keep_sentence_flow=True,
        remove_fillers=False,
        smart_silence=True,
    ),
)

# Extra mode requested on top of the spec: strip *every* gap over 80 ms down to
# nothing — a true gapless cut. Smart Silence is off (uniform, no punctuation
# rules) and the pads are zero so words butt right together.
AGGRESSIVE_GAPLESS = Preset(
    id="aggressive_gapless",
    icon="✂️",
    title="Aggressive Gapless",
    description="Removes every silence gap longer than 80 ms. Tightest possible — no breathing room.",
    settings=SilenceSettings(
        min_gap_ms=80,
        target_pause_ms=0,
        sentence_pause_ms=0,
        comma_pause_ms=0,
        merge_gap_ms=60,
        pad_before_ms=0,
        pad_after_ms=0,
        keep_sentence_flow=False,
        remove_fillers=False,
        smart_silence=False,
    ),
)

# Custom starts as a copy of Balanced and is the one mode the user may tune.
CUSTOM = Preset(
    id="custom",
    icon="🎚️",
    title="Custom",
    description="Adjust everything manually with the sliders below, or open Advanced for exact values.",
    settings=BALANCED.settings.copy(),
    editable=True,
)


class PresetManager:
    """Ordered access to the editing modes."""

    #: Display order for the mode cards.
    ORDER: tuple[Preset, ...] = (CONSERVATIVE, BALANCED, AGGRESSIVE, AGGRESSIVE_GAPLESS, CUSTOM)

    #: The mode selected on first open.
    DEFAULT_ID = "balanced"

    _BY_ID = {p.id: p for p in ORDER}

    @classmethod
    def all(cls) -> tuple[Preset, ...]:
        """Every preset, in display order."""
        return cls.ORDER

    @classmethod
    def get(cls, preset_id: str) -> Preset:
        """Look up a preset by id (falls back to the default)."""
        return cls._BY_ID.get(preset_id, cls._BY_ID[cls.DEFAULT_ID])

    @classmethod
    def default(cls) -> Preset:
        """The Balanced/Recommended default."""
        return cls.get(cls.DEFAULT_ID)
