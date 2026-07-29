"""Central configuration: tunables, bounds, filler words and punctuation sets.

Everything a human might want to tweak once lives here, so the engine and the UI
never hard-code magic numbers. All durations are in **milliseconds** unless a
name ends in ``_S`` (seconds).
"""

from __future__ import annotations

from typing import Final

# --------------------------------------------------------------------------- #
# Filler words                                                                 #
# --------------------------------------------------------------------------- #
# Words the "Remove Filler Words" toggle deletes. AssemblyAI already gives each
# of these a timestamp, so removing them is just another cut (plus a merge of
# the silence that surrounds them). Compared case-insensitively with surrounding
# punctuation stripped. Multi-word fillers ("you know") are matched as a phrase.

SINGLE_FILLERS: Final[frozenset[str]] = frozenset(
    {"uh", "um", "erm", "uhh", "umm", "hmm", "mm", "mhm", "eh", "ah", "er"}
)

# Ordered longest-first so the phrase matcher is greedy ("you know" before "like").
PHRASE_FILLERS: Final[tuple[tuple[str, ...], ...]] = (
    ("you", "know"),
    ("i", "mean"),
    ("sort", "of"),
    ("kind", "of"),
)

# "like" is a filler only in its discourse sense; it is common as a real verb,
# so it is opt-in via this set and still protected by the phrase logic above.
CONTEXTUAL_FILLERS: Final[frozenset[str]] = frozenset({"like", "basically", "literally"})

# --------------------------------------------------------------------------- #
# Punctuation                                                                  #
# --------------------------------------------------------------------------- #
SENTENCE_ENDERS: Final[frozenset[str]] = frozenset({".", "?", "!", "…"})
COMMA_ENDERS: Final[frozenset[str]] = frozenset({",", ";", ":", "—", "-"})

# --------------------------------------------------------------------------- #
# Engine guards                                                               #
# --------------------------------------------------------------------------- #
# A trim shorter than this is not worth a splice — skip it (avoids a seam that
# removes almost nothing).
MIN_MEANINGFUL_TRIM_MS: Final[float] = 40.0

# Absolute floor for any kept pause so two words never butt together with a
# hard click even in "gapless" mode. 0 is allowed for a true gapless cut.
MIN_KEPT_PAUSE_MS: Final[float] = 0.0

# --------------------------------------------------------------------------- #
# Custom-control bounds (creator sliders map into these ranges)               #
# --------------------------------------------------------------------------- #
# Each tuple is (min_ms, max_ms) for the raw parameter a creator slider drives.
BOUNDS_MIN_GAP_MS: Final[tuple[float, float]] = (80.0, 700.0)
BOUNDS_TARGET_PAUSE_MS: Final[tuple[float, float]] = (0.0, 400.0)
BOUNDS_SENTENCE_PAUSE_MS: Final[tuple[float, float]] = (120.0, 600.0)
BOUNDS_COMMA_PAUSE_MS: Final[tuple[float, float]] = (80.0, 450.0)
BOUNDS_MERGE_GAP_MS: Final[tuple[float, float]] = (0.0, 400.0)
BOUNDS_PAD_MS: Final[tuple[float, float]] = (0.0, 200.0)
