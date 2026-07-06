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
from .features import _marker_before, extract_features
from .scoring import repeat_rule_fires, score_retake
from .types import Candidate, Cut, Features, WordToken


def _anchor_markers(cfg: Config) -> tuple:
    """Markers allowed to STAND IN for the shared-leading-word anchor. Weak
    markers ('no', 'again') are ordinary content words too often — they keep
    their scoring bonus but cannot anchor a candidate by themselves."""
    return tuple(m for m in cfg.markers if m not in cfg.weak_markers)


def _next_norm_index(words: List[WordToken]) -> List[Optional[int]]:
    """nxt[k] = index of the first word at or after k with a non-empty norm.
    Lets the anchor requirement (shared leading word) be tested BEFORE the full
    feature extraction — on long transcripts ~96% of (i, j) pairs fail it, and
    extract_features is ~200µs each, so testing first is the difference between
    ~10 s and well under a second on a 15-minute transcript."""
    n = len(words)
    nxt: List[Optional[int]] = [None] * n
    last: Optional[int] = None
    for k in range(n - 1, -1, -1):
        if words[k].norm:
            last = k
        nxt[k] = last
    return nxt


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


def _long_sentence_retake(f: Features) -> bool:
    """A LONG complete sentence immediately re-taken from a clause start with a
    largely matching continuation ('I'm gonna say babe it actually does work. I
    just tried it out… you got them.' -> 'Babe, it does work. I just tried it
    out. Wait, you got them?'). The sentence-final guard exists for SHORT
    sentences sharing a word with later content ('use it?' … 'safe to use.');
    a 10+-word attempt whose tail matches >=0.65 token-for-token, restarted
    immediately at a clause boundary, is a retake — two distinct 10+-word
    thoughts never overlap that much."""
    return (
        f.earlier_len_words >= 10
        and f.tail_sem >= 0.65
        and f.combined_sim >= 0.70
        and f.immediate >= 0.70
        and f.restart_clause_start >= 1.0
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
    nxt = _next_norm_index(words)
    anchor_markers = _anchor_markers(cfg)

    for j in range(1, n):
        best: Optional[Candidate] = None
        second: Optional[Candidate] = None
        long_span: Optional[Candidate] = None  # widest borderline pair (garbled chains)
        probe: Optional[Candidate] = None      # gate-rejected garble shape, for semantic rescue
        lo = max(0, j - cfg.max_lookback)
        # A restart begins a NEW sentence; it never anchors on the previous
        # sentence's trailing word. Skip j whose first word ends a sentence
        # ('anymore.') — that misaligns the cut onto the prior sentence's tail.
        if words[j].ends_sentence:
            continue
        marker_j = _marker_before(words, j, anchor_markers)
        for i in range(lo, j):
            L = min(cfg.max_phrase, j - i, n - j)
            if L < cfg.min_phrase:
                continue
            # Early anchor test (before the expensive extract_features call):
            # the attempt and the restart must share their leading word, or a
            # non-weak correction marker stands in. STRICT on purpose — a fuzzy
            # (first-4-words) variant was tried 2026-07-05 and immediately
            # produced floating over-cuts ('lightning and', 'them in'); the
            # strict anchor is the engine's main over-cut defence.
            if marker_j < 1.0:
                ai, bj = nxt[i], nxt[j]
                if (
                    ai is None or ai >= i + L or bj is None or bj >= j + L
                    or words[ai].norm != words[bj].norm
                ):
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

            # (Anchor requirement is enforced by the early test above — it
            # kills "floating" matches with high mid-sequence overlap but
            # unrelated openings, the main source of over-cutting.)

            # Cheap reject: nothing lexical, no marker — cannot be a retake.
            if f.combined_sim < 0.34 and f.prefix_overlap < 0.5 and f.marker_before < 1.0:
                continue

            # Sentence-final guard FIRST: a short completed question/statement
            # can share a word with a later sentence ("use it?" ... "safe to
            # use.") without being a retake. Nothing rejected here is ever
            # revived — not even by semantic rescue (strengthen/restore lives
            # behind this guard).
            if (
                f.earlier_ends_sentence >= 1.0
                and not repeat_rule_fires(f, cfg)
                and f.tail_sem < 0.75
                and f.combined_sim < 0.92
                and not _strong_prefix_retake(f)
                and not _connector_restart(f)
                and not _long_sentence_retake(f)
            ):
                continue

            if (
                f.earlier_incomplete < 0.25
                and f.tail_sem < 0.45
                and not repeat_rule_fires(f, cfg)
                and f.combined_sim < 0.88
                and not _strong_prefix_retake(f)
                and not _connector_restart(f)
            ):
                # Divergent-tail reject — but a GARBLED retake looks exactly
                # like this (ASR re-spelled the repeated words, flooring the
                # lexical tail). Keep the strongest such shape per restart as a
                # PROBE: it can only become a cut if the semantic tier reads
                # both spans as the same line (engine._semantic_rescue).
                if f.combined_sim >= 0.50 and f.prefix_overlap > 0.0 and f.earlier_len_words >= 4:
                    pp = score_retake(f, cfg)
                    if probe is None or pp > probe.prob:
                        probe = Candidate(i=i, j=j, L=L, prob=pp, feats=f, probe=True)
                continue

            p = score_retake(f, cfg)
            cand = Candidate(i=i, j=j, L=L, prob=p, feats=f)
            if best is None or p > best.prob:
                second = best
                best = cand
            elif second is None or p > second.prob:
                second = cand
            if (
                j - i >= 8
                and p >= cfg.semantic_rescue_floor
                and (long_span is None or j - i > long_span.j - long_span.i)
            ):
                long_span = cand

        # Keep the best pair AND the runner-up for this restart point. Both
        # share endpoint j, so they always overlap each other — the runner-up
        # can only win in resolve_cuts when the best is itself rejected for
        # overlapping an already-accepted cut. That is exactly the chained-take
        # case: for j = final take, best spans takes 1+2 but take 1 is already
        # cut, so the runner-up (take 2 alone) rescues the middle take that a
        # single-candidate-per-j search silently kept (skincare 'pitch/pitch
        # black' chain, 2026-07-05: the middle take scored 0.993 yet survived).
        seen_i = set()
        for c in (best, second, long_span):
            if c is not None and c.prob >= cfg.min_candidate_prob and c.i not in seen_i:
                seen_i.add(c.i)
                c.kind = _classify(c.feats)
                cands.append(c)
        # The widest borderline pair rides along below min_candidate_prob too:
        # a garbled 3-take chain scores ~0.35 lexically while local stutters at
        # the same restart score 0.9+ — without this slot the chain pair never
        # exists for the semantic tier to rescue. Filtered out before cutting
        # unless rescued past accept_threshold.
        if (
            long_span is not None
            and long_span.i not in seen_i
            and long_span.prob < cfg.min_candidate_prob
        ):
            seen_i.add(long_span.i)
            long_span.kind = _classify(long_span.feats)
            cands.append(long_span)
        if probe is not None and probe.i not in seen_i:
            probe.kind = _classify(probe.feats)
            cands.append(probe)

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
    anchor_markers = _anchor_markers(cfg)
    for cut in cuts:
        jw = cut.word_range[1]          # kept take starts here
        s = cut.word_range[0]           # current cut start (moves left)
        best_conf = cut.confidence
        marker_jw = _marker_before(words, jw, anchor_markers)
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
                if f.prefix_overlap <= 0.0 and marker_jw < 1.0:
                    continue
                if (
                    f.earlier_incomplete < 0.25
                    and f.tail_sem < 0.45
                    and not repeat_rule_fires(f, cfg)
                    and f.combined_sim < 0.88
                    and not _strong_prefix_retake(f)
                ):
                    continue
                if (
                    f.earlier_ends_sentence >= 1.0
                    and not repeat_rule_fires(f, cfg)
                    and f.tail_sem < 0.75
                    and f.combined_sim < 0.92
                    and not _strong_prefix_retake(f)
                    and not _long_sentence_retake(f)
                ):
                    continue
                pr = score_retake(f, cfg)
                if pr >= cfg.extend_accept_threshold and pr > best_pr:
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


def _keep_last_swap(accepted: List[Candidate], candidates: List[Candidate], words: List[WordToken], cfg: Config) -> None:
    """Replace an accepted cut with an EARLIER-SHIFTED equivalent when one exists.

    Interleaved block retakes (link-line + exact-line said twice: A B A' B')
    admit two content-equivalent edits: cut the middle B+A' (keeps A…B') or cut
    the leading A+B (keeps A'+B'). The middle cut often scores higher (whichever
    inner pair is more verbatim), but it KEEPS THE EARLIER take of A — violating
    keep-last. Swap is allowed only when it provably changes nothing but WHICH
    take airs: the block the swap newly cuts ([y.i, c.i)) must match the block
    it releases ([y.j, c.j)) at >=0.70 token similarity. By construction the
    kept text stays equivalent, just resolved to the LATER takes."""
    from .textsim import seq_ratio as _sr

    for idx, c in enumerate(accepted):
        best = None
        for y in candidates:
            if y is c or y.probe or y.final_prob < cfg.accept_threshold:
                continue
            if not (y.i < c.i and y.j < c.j and c.i < y.j):  # earlier-shifted overlap
                continue
            newly_cut = [w.norm for w in words[y.i : c.i] if w.norm]
            released = [w.norm for w in words[y.j : c.j] if w.norm]
            if not newly_cut or not released:
                continue
            if min(len(newly_cut), len(released)) / max(len(newly_cut), len(released)) < 0.6:
                continue
            if _sr(newly_cut, released) < 0.70:
                continue
            # must not collide with the other accepted cuts
            if any(o is not c and y.i < o.j and o.i < y.j for o in accepted):
                continue
            if best is None or y.i < best.i:
                best = y
        if best is not None:
            accepted[idx] = best


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

    _keep_last_swap(accepted, candidates, words, cfg)

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
