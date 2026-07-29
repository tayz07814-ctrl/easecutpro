"""The Smart Silence engine — transcript timestamps in, cut list out.

No audio analysis, no Qt, no I/O. One public entry point, :meth:`SilenceEngine.plan`.

The rule set (mirrors the product spec exactly):

1.  For each pair of adjacent kept words compute ``gap = next.start - cur.end``.
2.  ``gap <= min_gap``  → **keep it** (natural rhythm, untouched).
3.  ``gap  > min_gap``  → **trim it down to a target**, never to zero::

        removed = gap - target        # e.g. 900ms gap, 180ms target -> remove 720ms

    The kept ``target`` is what stops speech feeling rushed.
4.  The target depends on Smart Silence:
      * **Smart Silence ON** + *Keep Sentence Flow* → punctuation aware:
        longer pause after ``. ? !``, medium after ``,``, else the plain target.
      * **Smart Silence OFF** → every over-threshold gap trimmed to the single
        ``target_pause_ms`` (plain gap-based, no punctuation).
5.  ``pad_before`` / ``pad_after`` are protected margins kept next to each word.
6.  *Remove Filler Words* deletes uh/um/erm/you know/like… by treating them as
    part of the surrounding gap, so the silence around them collapses correctly.
7.  ``merge_gap`` fuses cuts separated only by a tiny silent sliver (never speech).

The result is a :class:`~smart_silence_cleaner.models.edl.SilencePlan`.
"""

from __future__ import annotations

from typing import Sequence

from .. import config
from ..models.edl import Cut, CutReason, SilencePlan
from ..models.settings import SilenceSettings
from ..models.word import Word
from . import stats as stats_mod


class SilenceEngine:
    """Stateless planner. Every method is pure — safe to call from any thread."""

    # ------------------------------------------------------------------ #
    # public                                                             #
    # ------------------------------------------------------------------ #
    @classmethod
    def plan(
        cls,
        words: Sequence[Word],
        settings: SilenceSettings,
        original_duration_ms: float | None = None,
    ) -> SilencePlan:
        """Compute the full cut plan for ``words`` under ``settings``.

        Parameters
        ----------
        words:
            The transcript in order. Empty input yields an empty plan.
        settings:
            The knobs (see :class:`SilenceSettings`).
        original_duration_ms:
            Media length. Defaults to the last word's end (no trailing trim).
        """
        words = [w for w in words if w.end_ms >= w.start_ms]
        if not words:
            return cls._empty_plan(original_duration_ms or 0.0)

        duration = original_duration_ms if original_duration_ms is not None else words[-1].end_ms
        duration = max(duration, words[-1].end_ms)

        filler_idx = cls._filler_indices(words) if settings.remove_fillers else set()
        filler_spans = [(words[i].start_ms, words[i].end_ms) for i in sorted(filler_idx)]

        # Words the viewer actually hears — fillers are dropped so the gap that
        # brackets them (word -> filler(s) -> word) collapses into one trim.
        kept = [w for i, w in enumerate(words) if i not in filler_idx]

        raw_cuts = cls._gap_cuts(kept, settings, filler_spans)
        cuts = cls._merge(raw_cuts, settings.merge_gap_ms)

        keeps = cls._complement(cuts, duration)
        total_removed = sum(c.removed_ms for c in cuts)
        pauses_removed = sum(1 for c in cuts if c.reason == "gap") + sum(
            1 for c in cuts if c.reason == "filler"
        )

        stats = stats_mod.compute(
            words=words,
            total_removed_ms=total_removed,
            pauses_removed=len([c for c in cuts]),
            fillers_removed=len(filler_idx),
            original_duration_ms=duration,
        )
        return SilencePlan(
            cuts=tuple(cuts),
            keeps=tuple(keeps),
            stats=stats,
            original_duration_ms=duration,
        )

    # ------------------------------------------------------------------ #
    # gap trimming                                                       #
    # ------------------------------------------------------------------ #
    @classmethod
    def _gap_cuts(
        cls,
        kept: Sequence[Word],
        s: SilenceSettings,
        filler_spans: list[tuple[float, float]],
    ) -> list[Cut]:
        """One trim per over-threshold gap between consecutive kept words."""
        cuts: list[Cut] = []
        for i in range(len(kept) - 1):
            cur, nxt = kept[i], kept[i + 1]
            gap = nxt.start_ms - cur.end_ms
            if gap <= s.min_gap_ms:
                continue  # below threshold — natural pause, keep whole

            target = cls._target_for(cur, s)
            # A kept pause can never be shorter than the protected pads, nor
            # longer than the gap itself.
            min_keep = s.pad_before_ms + s.pad_after_ms
            target = min(gap, max(target, min_keep, config.MIN_KEPT_PAUSE_MS))
            removed = gap - target
            if removed < config.MIN_MEANINGFUL_TRIM_MS:
                continue  # trimming this little isn't worth a splice

            # SYMMETRIC trim: keep half the target pause on EACH side of the cut
            # (silence retained right after the current word AND right before the
            # next word) so the join reads naturally, instead of biasing all the
            # kept air to one edge. The removed chunk is centred in the gap.
            keep_each = target / 2.0
            cut_start = cur.end_ms + keep_each
            cut_end = nxt.start_ms - keep_each
            # numeric safety: stay strictly inside the gap
            if cut_end <= cut_start or (cut_end - cut_start) < config.MIN_MEANINGFUL_TRIM_MS:
                continue

            reason: CutReason = (
                "filler"
                if any(fs < cut_end and fe > cut_start for fs, fe in filler_spans)
                else "gap"
            )
            cuts.append(Cut(start_ms=cut_start, end_ms=cut_end, removed_ms=cut_end - cut_start, reason=reason))
        return cuts

    @staticmethod
    def _target_for(cur: Word, s: SilenceSettings) -> float:
        """Pick the pause length to KEEP after ``cur``.

        Punctuation only matters when Smart Silence *and* Keep Sentence Flow are
        both on; otherwise every gap uses the single ``target_pause_ms``.
        """
        if s.smart_silence and s.keep_sentence_flow:
            if cur.ends_sentence():
                return s.sentence_pause_ms
            if cur.ends_clause():
                return s.comma_pause_ms
        return s.target_pause_ms

    # ------------------------------------------------------------------ #
    # fillers                                                            #
    # ------------------------------------------------------------------ #
    @classmethod
    def _filler_indices(cls, words: Sequence[Word]) -> set[int]:
        """Indices of filler tokens — single words and known phrases.

        Phrase fillers (``you know``) are matched greedily over consecutive
        tokens so both words are removed together.
        """
        idx: set[int] = set()
        cleans = [w.clean for w in words]

        # phrases first (mark every token of a matched phrase)
        for start in range(len(words)):
            for phrase in config.PHRASE_FILLERS:
                end = start + len(phrase)
                if end <= len(words) and tuple(cleans[start:end]) == phrase:
                    idx.update(range(start, end))

        # single-word fillers
        for i, w in enumerate(words):
            if w.is_single_filler():
                idx.add(i)
        return idx

    # ------------------------------------------------------------------ #
    # merge + complement                                                 #
    # ------------------------------------------------------------------ #
    @staticmethod
    def _merge(cuts: list[Cut], merge_gap_ms: float) -> list[Cut]:
        """Fuse overlapping cuts, or cuts separated by a silent sliver < merge_gap.

        Because every gap cut lives between two kept words, two *distinct* gap
        cuts are always separated by speech and will not be within ``merge_gap``
        of each other — so this only ever coalesces genuinely overlapping/adjacent
        spans and never eats a word.
        """
        if not cuts:
            return []
        ordered = sorted(cuts, key=lambda c: c.start_ms)
        out: list[Cut] = [ordered[0]]
        for c in ordered[1:]:
            last = out[-1]
            if c.start_ms - last.end_ms <= max(0.0, merge_gap_ms):
                start = last.start_ms
                end = max(last.end_ms, c.end_ms)
                reason: CutReason = "filler" if "filler" in (last.reason, c.reason) else "gap"
                out[-1] = Cut(start_ms=start, end_ms=end, removed_ms=end - start, reason=reason)
            else:
                out.append(c)
        return out

    @staticmethod
    def _complement(cuts: Sequence[Cut], duration_ms: float) -> list[tuple[float, float]]:
        """The KEEP ranges = ``[0, duration]`` minus every cut."""
        keeps: list[tuple[float, float]] = []
        cursor = 0.0
        for c in cuts:
            if c.start_ms > cursor:
                keeps.append((cursor, c.start_ms))
            cursor = max(cursor, c.end_ms)
        if duration_ms > cursor:
            keeps.append((cursor, duration_ms))
        return keeps

    # ------------------------------------------------------------------ #
    @staticmethod
    def _empty_plan(duration_ms: float) -> SilencePlan:
        empty_stats = stats_mod.compute([], 0.0, 0, 0, duration_ms)
        return SilencePlan(cuts=(), keeps=((0.0, duration_ms),) if duration_ms > 0 else (), stats=empty_stats, original_duration_ms=duration_ms)
