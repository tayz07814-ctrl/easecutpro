"""
Retake Detection Logic (design step 4).

Pipeline:
  1. For each potential restart point j, search BACK up to `max_lookback` words for
     the abandoned attempt [i, j) that j best restarts (this is the "compare each
     window with the next N windows" lookahead, expressed as a lookback from the
     restart — equivalent and cheaper to dedupe).
  2. Score every (i, j) pair; keep the best-scoring i per j above
     `min_candidate_prob`.
  3. Classify each candidate: full repetition / false start / partial restart /
     retake.
  4. Resolve overlaps greedily (highest probability wins; adjacent cuts are kept
     so chained takes all collapse to the final one), then merge touching ranges.

The cut for a candidate removes the abandoned attempt [words[i].start,
words[j].start) and keeps word j onward — i.e. the LAST take survives.
"""

from __future__ import annotations

from typing import List, Optional

from .config import Config
from .features import extract_features
from .scoring import score_retake
from .types import Candidate, Cut, Features, WordToken


def _classify(f: Features) -> str:
    if f.combined_sim >= 0.90 and f.prefix_overlap >= 0.80:
        return "repetition"          # said (almost) the exact same phrase again
    if f.earlier_incomplete >= 0.50 and f.prefix_overlap >= 0.50:
        return "false_start"         # short abandoned opening, then restarted
    if f.prefix_overlap >= 0.50 and f.combined_sim < 0.85:
        return "partial_restart"     # same opening, re-worded continuation
    return "retake"


def build_ctx(words: List[WordToken]) -> dict:
    """Shared per-transcript context for repeat-count features."""
    return {"tokens": [w.norm for w in words], "cache": {}}


def _strong_prefix_retake(f: Features) -> bool:
    # Long identical opening + immediate restart. `final_word_swap` keeps this to
    # true ending substitutions ("…this scent." -> "…this perfume."): a LONGER
    # second tail ("…help strengthen." -> "…help restore your skin barrier.") is
    # a distinct point and must NOT qualify.
    return (
        f.earlier_len_words >= 5
        and f.prefix_overlap >= 0.75
        and f.combined_sim >= 0.80
        and f.immediate >= 0.70
        and f.final_word_swap >= 1.0
    )


def _connector_restart(f: Features) -> bool:
    """Short complete attempt restarted with the same opening then re-elaborated
    at length ("So if they're in stock." -> "So if you see that link there…").
    Lexical tails share nothing, so this shape needs its own evidence path."""
    return f.connector_restart >= 1.0


def find_candidates(
    words: List[WordToken], cfg: Config, sem=None, audio=None, ctx=None
) -> List[Candidate]:
    n = len(words)
    cands: List[Candidate] = []
    if ctx is None:
        ctx = build_ctx(words)

    for j in range(1, n):
        best: Optional[Candidate] = None
        lo = max(0, j - cfg.max_lookback)
        # A restart begins a NEW sentence; it never anchors on the previous
        # sentence's trailing word. Skip j whose first word ends a sentence
        # ('anymore.') — that misaligns the cut onto the prior sentence's tail.
        if words[j].ends_sentence:
            continue
        for i in range(lo, j):
            L = min(cfg.max_phrase, j - i, n - j)
            if L < cfg.min_phrase:
                continue
            # If the token immediately before both spans also matches, this is a
            # shifted alignment ("trying..." vs "trying...") that leaves the true
            # restart word ("I'm") inside the cut. Let the earlier i/j pair own it.
            if (
                i > 0
                and j > 0
                and words[i - 1].norm
                and words[i - 1].norm == words[j - 1].norm
                and not words[i - 1].ends_sentence
            ):
                continue
            # The abandoned attempt must also start at a sentence start, not on a
            # trailing 'anymore.'-type word.
            if words[i].ends_sentence:
                continue
            f = extract_features(words, i, j, L, cfg, sem=sem, audio=audio, ctx=ctx)

            # Anchor requirement: a genuine restart re-says the OPENING at the
            # restart point, so the abandoned attempt and the kept take must share
            # a leading word. Rejecting un-anchored pairs kills "floating" matches
            # — a shifted sub-window with high mid-sequence overlap but mismatched
            # first words (e.g. comparing '...help strengthen' against
            # 'But most importantly...'). These misalignments are the main source
            # of over-cutting. A correction marker can stand in for the anchor.
            if f.prefix_overlap <= 0.0 and f.marker_before < 1.0:
                continue

            # Cheap reject: nothing lexical, no marker — cannot be a retake.
            if f.combined_sim < 0.34 and f.prefix_overlap < 0.5 and f.marker_before < 1.0:
                continue

            if (
                f.earlier_incomplete < 0.25
                and f.tail_sem < 0.45
                and f.prefix_repeat_count < cfg.retake_repeat_count
                and f.combined_sim < 0.88
                and not _strong_prefix_retake(f)
                and not _connector_restart(f)
            ):
                continue

            # A short completed question/statement can share a word with a later
            # sentence ("use it?" ... "safe to use.") without being a retake.
            # Require very strong evidence before cutting sentence-final spans.
            if (
                f.earlier_ends_sentence >= 1.0
                and f.prefix_repeat_count < cfg.retake_repeat_count
                and f.tail_sem < 0.75
                and f.combined_sim < 0.92
                and not _strong_prefix_retake(f)
                and not _connector_restart(f)
            ):
                continue

            p = score_retake(f, cfg)
            if best is None or p > best.prob:
                best = Candidate(i=i, j=j, L=L, prob=p, feats=f)

        if best is not None and best.prob >= cfg.min_candidate_prob:
            best.kind = _classify(best.feats)
            cands.append(best)

    return cands


def extend_cuts_back(cuts: List[Cut], words: List[WordToken], cfg: Config, sem=None, audio=None, ctx=None) -> None:
    """Chained-restart handler. find_candidates picks ONE abandoned attempt per
    restart point, so a chain like 'one of the most power | one of the most | one
    of the most powerful...' only cuts the attempt nearest the survivor. Here we
    walk BACKWARD from each confirmed cut and swallow any preceding chunk that
    ALSO scores as a repeat of the KEPT take (e.g. the 'power'->'powerful'
    fragment). It stops the moment a preceding chunk is NOT a repeat, so distinct
    earlier sentences ('the cat sat.' before 'the cat ran.') are never eaten."""
    if ctx is None:
        ctx = build_ctx(words)
    for cut in cuts:
        jw = cut.word_range[1]          # kept take starts here
        s = cut.word_range[0]           # current cut start (moves left)
        best_conf = cut.confidence
        for _ in range(6):              # bounded: at most 6 chained attempts
            if s <= 0:
                break
            best_p, best_pr = None, 0.0
            for p in range(max(0, s - cfg.max_lookback), s):
                L = min(cfg.max_phrase, s - p, len(words) - jw)
                if L < cfg.min_phrase:
                    continue
                if (
                    p > 0
                    and jw > 0
                    and words[p - 1].norm
                    and words[p - 1].norm == words[jw - 1].norm
                    and not words[p - 1].ends_sentence
                ):
                    continue
                if words[p].ends_sentence:   # don't anchor on a prior sentence's tail
                    continue
                f = extract_features(words, p, jw, L, cfg, sem=sem, audio=audio, ctx=ctx)
                if f.prefix_overlap <= 0.0 and f.marker_before < 1.0:
                    continue
                if (
                    f.earlier_incomplete < 0.25
                    and f.tail_sem < 0.45
                    and f.prefix_repeat_count < cfg.retake_repeat_count
                    and f.combined_sim < 0.88
                    and not _strong_prefix_retake(f)
                ):
                    continue
                if (
                    f.earlier_ends_sentence >= 1.0
                    and f.prefix_repeat_count < cfg.retake_repeat_count
                    and f.tail_sem < 0.75
                    and f.combined_sim < 0.92
                    and not _strong_prefix_retake(f)
                ):
                    continue
                pr = score_retake(f, cfg)
                if pr >= cfg.accept_threshold and pr > best_pr:
                    best_p, best_pr = p, pr
            if best_p is None:
                break
            s = best_p
            best_conf = max(best_conf, best_pr)
        if s < cut.word_range[0]:
            cut.cut_start = words[s].start
            cut.word_range = (s, jw)
            cut.confidence = best_conf
            cut.text = " ".join(w.word for w in words[s:jw])


def merge_overlapping_cuts(cuts: List[Cut], words: List[WordToken], cfg: Config) -> List[Cut]:
    """Collapse cuts whose word ranges overlap or touch into single clean ranges.
    Backward extension can grow cuts until they overlap each other; this tidies
    the final output so the app gets one range per abandoned region."""
    if not cuts:
        return cuts
    cuts.sort(key=lambda c: c.word_range[0])
    out: List[Cut] = [cuts[0]]
    for c in cuts[1:]:
        prev = out[-1]
        if c.word_range[0] <= prev.word_range[1] or c.cut_start - prev.cut_end <= cfg.merge_gap:
            prev.word_range = (prev.word_range[0], max(prev.word_range[1], c.word_range[1]))
            prev.cut_end = max(prev.cut_end, c.cut_end)
            prev.confidence = max(prev.confidence, c.confidence)
            prev.text = " ".join(w.word for w in words[prev.word_range[0]:prev.word_range[1]])
            if prev.kind != c.kind:
                prev.kind = "retake"
        else:
            out.append(c)
    return out


def resolve_cuts(
    candidates: List[Candidate], words: List[WordToken], cfg: Config
) -> List[Cut]:
    """Greedy non-overlapping selection by descending final probability, then
    merge adjacent ranges. Adjacent (boundary-touching) cuts are allowed so that
    a chain of takes collapses to the final one."""
    # accept highest-confidence cuts first; reject any that overlap an accepted one
    accepted: List[Candidate] = []
    occupied: List[tuple[int, int]] = []  # word-index ranges already cut

    for c in sorted(candidates, key=lambda c: c.final_prob, reverse=True):
        if any(c.i < hi and lo < c.j for (lo, hi) in occupied):  # strict overlap
            continue
        accepted.append(c)
        occupied.append((c.i, c.j))

    accepted.sort(key=lambda c: c.i)

    cuts: List[Cut] = []
    for c in accepted:
        cut = Cut(
            cut_start=words[c.i].start,
            cut_end=words[c.j].start,  # keep word j (the surviving take) onward
            confidence=c.final_prob,
            kind=c.kind,
            text=" ".join(w.word for w in words[c.i:c.j]),
            word_range=(c.i, c.j),
        )
        # merge with previous if they touch (chained takes / sub-word gaps)
        if cuts and cut.cut_start - cuts[-1].cut_end <= cfg.merge_gap:
            prev = cuts[-1]
            prev.cut_end = max(prev.cut_end, cut.cut_end)
            prev.confidence = max(prev.confidence, cut.confidence)
            prev.text = (prev.text + " " + cut.text).strip()
            prev.word_range = (prev.word_range[0], cut.word_range[1])
            prev.kind = "retake" if prev.kind != cut.kind else prev.kind
        else:
            cuts.append(cut)

    return cuts
