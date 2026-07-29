"""A demo transcript so the page runs stand-alone with no real project loaded.

Times are milliseconds. The gaps are deliberately varied — some natural, some
long dead air, a couple of fillers — so the live preview and statistics have
something interesting to show.
"""

from __future__ import annotations

from .models.word import Word

# (start_ms, end_ms, text) — a short spoken paragraph with realistic pauses.
_RAW: list[tuple[int, int, str]] = [
    (0, 320, "So"),
    (330, 700, "today"),
    (720, 1050, "I"),
    (1060, 1500, "want"),
    (1520, 1780, "to"),
    (1800, 2300, "talk"),
    (2320, 2600, "about"),
    (2620, 3200, "editing."),        # sentence end, then a long pause
    (4100, 4400, "Um,"),             # filler + long lead-in
    (5200, 5600, "the"),
    (5620, 6100, "the"),             # stutter / repeat
    (6120, 6800, "hardest"),
    (6820, 7200, "part"),
    (7220, 7600, "is"),
    (7620, 8300, "silence,"),        # clause end
    (8600, 9000, "you"),             # "you know" filler phrase
    (9010, 9400, "know,"),
    (10200, 10600, "removing"),
    (10620, 11100, "dead"),
    (11120, 11600, "air"),
    (11620, 12400, "without"),
    (12420, 13000, "making"),
    (13020, 13300, "it"),
    (13320, 13900, "feel"),
    (13920, 14600, "rushed."),       # sentence end
]

#: The demo media is a touch longer than the last word (trailing room tone).
SAMPLE_DURATION_MS: float = 15200.0


def sample_words() -> list[Word]:
    """A fresh list of demo :class:`Word` objects."""
    return [Word(start_ms=float(s), end_ms=float(e), text=t) for s, e, t in _RAW]
