"""The output of the engine: an Edit Decision List (cuts) plus a plan wrapper.

A :class:`Cut` is one span of media to delete. The :class:`SilencePlan` bundles
all cuts with the surviving KEEP ranges and the statistics — it is the single
object the UI receives back from the engine.

Times are milliseconds internally; :pyattr:`Cut.start_s` / :pyattr:`Cut.end_s`
expose seconds for FFmpeg (``-ss`` / ``-to`` / the ``select`` filter).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from ..engine.stats import Stats

CutReason = Literal["gap", "filler"]


@dataclass(frozen=True, slots=True)
class Cut:
    """One span to remove from the source media.

    ``removed_ms`` equals ``end_ms - start_ms`` and is stored explicitly so the
    export/EDL rows carry it without a recompute.
    """

    start_ms: float
    end_ms: float
    removed_ms: float
    reason: CutReason = "gap"

    @property
    def start_s(self) -> float:
        """Cut start in seconds (FFmpeg)."""
        return self.start_ms / 1000.0

    @property
    def end_s(self) -> float:
        """Cut end in seconds (FFmpeg)."""
        return self.end_ms / 1000.0

    def as_row(self) -> dict[str, float | str]:
        """Flat dict for EDL export / logging (seconds + ms + reason)."""
        return {
            "cut_start_s": round(self.start_s, 3),
            "cut_end_s": round(self.end_s, 3),
            "cut_start_ms": round(self.start_ms, 1),
            "cut_end_ms": round(self.end_ms, 1),
            "duration_removed_ms": round(self.removed_ms, 1),
            "reason": self.reason,
        }


@dataclass(frozen=True, slots=True)
class SilencePlan:
    """Everything the engine produces for one settings run.

    Attributes
    ----------
    cuts:
        Ordered, non-overlapping spans to remove.
    keeps:
        The complement of ``cuts`` over ``[0, original_duration_ms]`` — the
        segments to KEEP, ready for FFmpeg trim+concat.
    stats:
        Numbers for the Statistics + Export panels.
    original_duration_ms:
        Media length the plan was computed against.
    """

    cuts: tuple[Cut, ...]
    keeps: tuple[tuple[float, float], ...]
    stats: Stats
    original_duration_ms: float = field(default=0.0)

    # -- export helpers ------------------------------------------------------
    def edl_rows(self) -> list[dict[str, float | str]]:
        """The EDL as a list of flat rows (Cut Start / Cut End / Duration Removed)."""
        return [c.as_row() for c in self.cuts]

    def keep_ranges_s(self) -> list[tuple[float, float]]:
        """KEEP ranges in seconds — the segments FFmpeg should concatenate."""
        return [(a / 1000.0, b / 1000.0) for a, b in self.keeps]
