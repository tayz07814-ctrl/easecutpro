"""Statistics derived from the transcript + the computed cut list.

Pure functions — feed in words and cuts, get numbers back. The UI formats them;
this module only computes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

from ..models.word import Word


@dataclass(frozen=True, slots=True)
class Stats:
    """Everything the Statistics + Export-Preview panels display.

    All ``*_ms`` values are milliseconds; ``percent_removed`` is 0-100.
    """

    original_duration_ms: float
    output_duration_ms: float
    time_saved_ms: float
    percent_removed: float

    speech_duration_ms: float
    silence_duration_ms: float

    pauses_total: int
    pauses_removed: int
    fillers_removed: int

    average_pause_ms: float
    longest_pause_ms: float

    # -- human-friendly strings (handy for labels) --------------------------
    @staticmethod
    def fmt_duration(ms: float) -> str:
        """``83500`` -> ``"1:23"``; sub-minute -> ``"12.4s"``."""
        ms = max(0.0, ms)
        secs = ms / 1000.0
        if secs < 60:
            return f"{secs:.1f}s"
        m, s = divmod(int(round(secs)), 60)
        return f"{m}:{s:02d}"

    @property
    def time_saved_str(self) -> str:
        return self.fmt_duration(self.time_saved_ms)

    @property
    def percent_removed_str(self) -> str:
        return f"{self.percent_removed:.0f}%"


def _gaps(words: Sequence[Word]) -> list[float]:
    """Inter-word gaps (ms) across the transcript, negatives clamped to 0."""
    return [max(0.0, words[i + 1].start_ms - words[i].end_ms) for i in range(len(words) - 1)]


def compute(
    words: Sequence[Word],
    total_removed_ms: float,
    pauses_removed: int,
    fillers_removed: int,
    original_duration_ms: float,
) -> Stats:
    """Assemble a :class:`Stats` from the transcript and the plan's totals.

    Parameters
    ----------
    words:
        The full transcript (used for pause statistics + speech duration).
    total_removed_ms:
        Sum of every cut's removed duration.
    pauses_removed, fillers_removed:
        Counts the engine reports.
    original_duration_ms:
        Media length before editing.
    """
    gaps = _gaps(words)
    silence_before = sum(gaps)
    speech = sum(w.duration_ms for w in words)
    output = max(0.0, original_duration_ms - total_removed_ms)
    percent = (total_removed_ms / original_duration_ms * 100.0) if original_duration_ms > 0 else 0.0

    return Stats(
        original_duration_ms=original_duration_ms,
        output_duration_ms=output,
        time_saved_ms=total_removed_ms,
        percent_removed=percent,
        speech_duration_ms=speech,
        silence_duration_ms=silence_before,
        pauses_total=len(gaps),
        pauses_removed=pauses_removed,
        fillers_removed=fillers_removed,
        average_pause_ms=(silence_before / len(gaps)) if gaps else 0.0,
        longest_pause_ms=max(gaps) if gaps else 0.0,
    )
