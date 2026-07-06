"""
Feature Extraction Module (design step 2).

Given an *earlier* span [i, i+L) and a *later* span [j, j+L) — where [i, j) is the
candidate abandoned attempt and [j, ...) is the kept take — compute every signal
the scoring engine and the optional ML model consume.

The guiding question each feature answers: "does this look like the speaker
re-doing the same thought, or like two genuinely different thoughts?"
"""

from __future__ import annotations

import math
from typing import List, Optional

from .config import Config
from .textsim import lev_ratio, prefix_overlap, seq_ratio
from .types import Features, WordToken

_EPS = 1e-6

_TRAILING_FRAGMENT_WORDS = {
    "a", "an", "the", "and", "but", "or", "so", "because", "if", "when",
    "while", "that", "which", "who", "where", "to", "of", "for", "with",
    "without", "in", "on", "at", "by", "from", "into", "onto", "as", "than",
    "is", "are", "was", "were", "be", "been", "being", "am", "do", "does",
    "did", "have", "has", "had", "can", "could", "should", "would", "will",
    "may", "might", "must", "it's", "that's", "you're", "we're", "i'm",
}


def _mean_conf(words: List[WordToken]) -> float:
    if not words:
        return 1.0
    return sum(w.conf for w in words) / len(words)


def _marker_before(words: List[WordToken], j: int, markers, zone: int = 3) -> float:
    """1.0 if a correction marker ('sorry', 'i mean', ...) sits around the restart
    boundary j. Markers are matched as token runs so multi-word ones ('i mean',
    'let me') work. Scanned over [j-zone, j+2)."""
    lo = max(0, j - zone)
    hi = min(len(words), j + 2)
    toks = [w.norm for w in words[lo:hi] if w.norm]
    joined = " ".join(toks)
    for m in markers:
        parts = m.lower().split()
        if len(parts) == 1:
            if parts[0] in toks:          # single-word marker: exact token match
                return 1.0
        else:
            if " ".join(parts) in joined:  # multi-word marker: contiguous run
                return 1.0
    return 0.0


# Discourse-connector openings that commonly START an abandoned-and-restarted
# sentence. Content openings ("i", "it", "this"…) are excluded on purpose —
# they mark deliberate lists/anaphora, not restarts.
_CONNECTOR_OPENERS = frozenset(
    ("so", "but", "and", "then", "if", "when", "because", "also", "plus",
     "or", "now", "well", "okay", "basically", "honestly", "literally", "like")
)


def _trailing_fragment_score(words: List[WordToken]) -> float:
    """High when a span ends like a sentence fragment instead of a complete take."""
    if not words:
        return 0.0
    last = words[-1].norm
    if not last:
        return 0.0
    if last in _TRAILING_FRAGMENT_WORDS:
        return 1.0
    # Cut-off words often end immediately before the corrected full word:
    # "power" -> "powerful", "conceal" -> "concealing".
    if len(words) >= 2 and not words[-1].ends_sentence and len(last) <= 4:
        return 0.35
    return 0.0


def _count_occurrences(tokens: List[str], sub: tuple, cache: dict) -> int:
    """How many times the token tuple `sub` appears in `tokens` (memoized)."""
    if not sub:
        return 0
    if sub in cache:
        return cache[sub]
    n, m, hits = len(tokens), len(sub), 0
    first = sub[0]
    for p in range(0, n - m + 1):
        if tokens[p] == first and tuple(tokens[p:p + m]) == sub:
            hits += 1
    cache[sub] = hits
    return hits


def extract_features(
    words: List[WordToken],
    i: int,
    j: int,
    L: int,
    cfg: Config,
    sem=None,            # SemanticModel | None
    audio=None,          # AudioEmbedder | None
    ctx=None,            # {"tokens": [...], "cache": {}} for repeat-count, or None
) -> Features:
    a = words[i:i + L]          # earlier comparison span
    b = words[j:j + L]          # later comparison span
    earlier = words[i:j]        # the full abandoned attempt that would be cut

    a_tok = [w.norm for w in a if w.norm]
    b_tok = [w.norm for w in b if w.norm]
    a_text = " ".join(w.word for w in a)
    b_text = " ".join(w.word for w in b)

    f = Features()

    # ---- text similarity (lexical, always available & cheap) ----
    f.seq_sim = seq_ratio(a_tok, b_tok)
    f.lev_sim = lev_ratio(" ".join(a_tok), " ".join(b_tok))

    # ---- prefix overlap: restarts repeat the opening words ----
    pre = prefix_overlap(a_tok, b_tok)
    f.prefix_overlap = pre / max(1, min(len(a_tok), len(b_tok)))
    f.prefix_len = pre

    # ---- how often the shared OPENING phrase recurs in the whole transcript ----
    # A long opening that appears many times marks a heavily re-taken line.
    # Counted from 3 shared words (scoring demands a much higher count + real
    # similarity before a 3-word opening may fire the repeat rule — see
    # scoring.repeat_rule_fires).
    if ctx is not None and pre >= 3:
        f.prefix_repeat_count = _count_occurrences(ctx["tokens"], tuple(a_tok[:pre]), ctx["cache"])
    else:
        f.prefix_repeat_count = 1

    # ---- correction markers (cheap; also gates the semantic call) ----
    f.marker_before = _marker_before(words, j, cfg.markers)

    # Lexical prefilter: only spend a GPU embedding on pairs that already look
    # plausibly related. Obvious non-matches skip the semantic tier entirely
    # (huge speedup on long transcripts) and fall back to lexical similarity.
    plausible = (
        max(f.seq_sim, f.lev_sim) >= 0.30
        or f.prefix_overlap >= 0.40
        or f.marker_before >= 1.0
    )
    use_sem = sem is not None and plausible

    # ---- semantic similarity (optional; lexical fallback) ----
    if use_sem:
        f.sem_sim = sem.similarity(a_text, b_text)
        # blend: semantics dominate, lexical anchors it to exact wording
        f.combined_sim = 0.5 * f.sem_sim + 0.3 * f.seq_sim + 0.2 * f.lev_sim
    else:
        f.sem_sim = max(f.seq_sim, f.lev_sim)
        f.combined_sim = 0.6 * f.seq_sim + 0.4 * f.lev_sim

    # ---- length-robust alignment similarity ----
    # The fixed L-window compares [i,i+L) vs [j,j+L) at EQUAL length, so a reworded
    # retake whose kept take is LONGER (inserted words) drifts out of alignment and
    # scores low (e.g. "...arms tied on the chest, but also looser on the waist" vs
    # the longer "...arms and tight on the chest, so it makes... but also looser on
    # the waist behind that belly"). Compare the WHOLE abandoned attempt [i,j)
    # against a later window allowed to run longer, via token SequenceMatcher which
    # absorbs insertions/deletions — recovering the true overlap. Anchored + gated
    # downstream, so it lifts recall on real retakes without inviting over-cuts.
    earlier_full = [w.norm for w in words[i:j] if w.norm]
    span = j - i
    later_end = min(len(words), j + int(1.7 * span) + 3)
    later_full = [w.norm for w in words[j:later_end] if w.norm]
    f.align_sim = seq_ratio(earlier_full, later_full)
    # The 1.7x window above recovers LONGER kept takes, but it also DILUTES the
    # ratio when the kept take is the SAME length (16 matching tokens vs a
    # 30-token window caps out at ~0.7) — that dilution hid a verbatim doubled
    # sentence in the 2026-07-05 bed-skit run. Also compare length-matched, and
    # at char level: ASR garble re-spells retaken words ('toner'->'turn or',
    # 'kojic'->'cook'/'cojac'), which token matching reads as different words
    # while char-level Levenshtein still sees the same line (small discount so
    # exact token matches keep ranking above garble matches).
    if earlier_full:
        lf_trim = later_full[: len(earlier_full)]
        f.align_sim = max(
            f.align_sim,
            seq_ratio(earlier_full, lf_trim),
            0.97 * lev_ratio(" ".join(earlier_full), " ".join(lf_trim)),
            # Space-stripped: ASR garble also SPLITS/JOINS words ('toner' ->
            # 'turn or'), which even char-level matching over spaced text
            # penalizes twice. Concatenation makes the split invisible.
            0.97 * lev_ratio("".join(earlier_full), "".join(lf_trim)),
        )
    f.combined_sim = max(f.combined_sim, f.align_sim)

    # ---- tail divergence: after the shared prefix, are the continuations the
    #      SAME thought (retake) or DIFFERENT points (keep both)? ----
    a_tail = a_tok[pre:]
    b_tail = b_tok[pre:]
    if not a_tail and not b_tail:
        f.tail_sem = 1.0
    else:
        # Tail similarity decides retake-vs-distinct when the openings match.
        #  - token overlap: the continuations repeat the same words.
        #  - FRAGMENT check: the first divergent word is a cut-off of the other
        #    ('power' -> 'powerful'), i.e. one is a prefix of the other. This is a
        #    false start. We use prefix-containment, NOT raw edit distance, so
        #    'strengthen' vs 'restore' (different words that share a few letters)
        #    does NOT count as a fragment and stays a DISTINCT point.
        lex_tail = seq_ratio(a_tail, b_tail)
        if a_tail and b_tail:
            x, y = a_tail[0], b_tail[0]
            if len(x) >= 3 and len(y) >= 3 and (x.startswith(y) or y.startswith(x)):
                lex_tail = max(lex_tail, 0.9)
            elif len(x) >= 5 and len(y) >= 5 and lev_ratio(x, y) >= 0.66:
                # GARBLED same word: ASR re-spells the retaken word two ways
                # ('transitionic' vs 'transemic' for tranexamic). Two long words
                # 2/3 char-identical at the divergence point are the same word
                # misheard, not two thoughts. Short/different words stay safe:
                # lev('strengthen','restore')≈0.42, lev('year','summer')<0.4.
                lex_tail = max(lex_tail, 0.9)
        elif not a_tail and b_tail and pre >= 4:
            # The earlier attempt is a strict PREFIX of the restart: the speaker
            # said the same >=4-word opening and stopped ("...used to be pitch"
            # -> "...used to be pitch black"). That is the definition of a false
            # start; an empty tail must read as corroborated, not divergent.
            # pre >= 4 keeps 2-3 word connective openings ("and then") safe.
            lex_tail = max(lex_tail, 0.9)
        if use_sem and (a_tail or b_tail):
            sem_tail = sem.similarity(" ".join(a_tail), " ".join(b_tail))
            f.tail_sem = max(lex_tail, sem_tail)
        else:
            f.tail_sem = lex_tail
        # Length-robust tail: align the post-prefix remainder of the whole
        # abandoned attempt against the (possibly longer) later take, so a reworded
        # continuation that repeats the same thought with extra words still reads as
        # corroborated instead of "divergent tail".
        if len(earlier_full) > pre:
            f.tail_sem = max(f.tail_sem, seq_ratio(earlier_full[pre:], later_full[pre:]))

    # ---- timing ----
    gap = 0.0
    if 0 < j < len(words):
        gap = max(0.0, words[j].start - words[j - 1].end)
    f.gap = gap
    f.immediate = math.exp(-gap / 0.5)  # ~1 for a tight restart, decays with pause
    # Real restarts begin at a clause boundary (after a pause or sentence punct);
    # 0.35 s matches the renderer's clause splitter. Competing alignments of the
    # same retake anchored MID-clause (on the takes' shared tail) lack this and
    # lose to the clause-start alignment in the greedy resolver.
    if j > 0 and (words[j - 1].ends_sentence or gap >= 0.35):
        f.restart_clause_start = 1.0

    # ---- restart-shape flags ----
    # Tail lengths must be SENTENCE-bounded, not L-window-bounded: the compared
    # span truncates the kept take, so "…help restore your skin barrier." would
    # look like a 1-word tail ("restore") and masquerade as a final-word swap.
    def _sentence_len_from(k: int, cap: int = 30) -> int:
        n_words = 0
        for x in range(k, min(len(words), k + cap)):
            n_words += 1
            if words[x].ends_sentence:
                break
        return n_words
    a_tail_full = max(0, (j - i) - pre)  # the whole abandoned attempt
    b_tail_full = max(0, _sentence_len_from(j) - pre)  # kept take's own sentence
    # final_word_swap: the two takes are the SAME sentence with only the ending
    # swapped ("…this scent." -> "…this perfume."): both post-prefix tails are
    # tiny. A LONGER second tail means the speaker went on to say something NEW
    # ("…help strengthen." -> "…help restore your skin barrier.") — that's a
    # distinct point, not a swap.
    f.final_word_swap = 1.0 if (pre >= 3 and a_tail_full <= 2 and b_tail_full <= 2) else 0.0
    # connector_restart: a SHORT complete-ish earlier sentence restarted with the
    # same short opening and then RE-ELABORATED at length ("So if they're in
    # stock." -> "So if you see that link there, I would freaking run."). Pure
    # tail similarity can't see these paraphrase restarts. Requires: >=2 shared
    # opening tokens, short earlier attempt, tight restart, a much longer
    # continuation after the shared opening, AND a discourse-connector opening —
    # content openings ("I love…", "It has…") are deliberate lists/anaphora and
    # must never trip this ("I love the smell. I love the price." is intended).
    f.connector_restart = (
        1.0
        if (
            pre >= 2
            and (j - i) <= 6
            and f.immediate >= 0.5
            and b_tail_full >= 4
            and a_tail_full >= 1
            and a_tok
            and a_tok[0] in _CONNECTOR_OPENERS
        )
        else 0.0
    )
    f.restart_pause = min(1.0, gap / 0.7)

    # ---- earlier-attempt completeness ----
    # Incomplete takes tend to be short, trail off on function words, have lower
    # confidence near the end, or pause before the restart. Sentence punctuation
    # pulls the score back down so complete thoughts that share an opening survive.
    f.earlier_len_words = j - i
    min_complete = 7.0
    shortness = max(0.0, (min_complete - (j - i)) / min_complete)
    last_conf = earlier[-1].conf if earlier else 1.0
    low_conf_tail = max(0.0, (0.7 - last_conf) / 0.7)
    f.earlier_ends_sentence = 1.0 if earlier and earlier[-1].ends_sentence else 0.0
    f.trailing_fragment = _trailing_fragment_score(earlier)
    complete_penalty = 0.55 * f.earlier_ends_sentence
    incomplete = (
        0.42 * shortness
        + 0.26 * low_conf_tail
        + 0.22 * f.trailing_fragment
        + 0.10 * f.restart_pause
        - complete_penalty
    )
    f.earlier_incomplete = min(1.0, max(0.0, incomplete))

    dur_a = max(_EPS, a[-1].end - a[0].start) if a else _EPS
    dur_b = max(_EPS, b[-1].end - b[0].start) if b else _EPS
    f.dur_ratio = dur_a / dur_b
    f.rate_earlier = len(a) / dur_a
    f.rate_later = len(b) / dur_b
    f.rate_change = abs(f.rate_later - f.rate_earlier) / max(_EPS, f.rate_earlier)

    # ---- confidence ----
    f.conf_earlier = _mean_conf(a)
    f.conf_later = _mean_conf(b)
    f.conf_diff = f.conf_later - f.conf_earlier

    # ---- script alignment (only when the user pasted their script) ----
    # attempt off-script while the restart matches the script => the attempt is
    # the flubbed take; the scripted line survives.
    smask = ctx.get("script_mask") if ctx else None
    if smask:
        from .script import offscript_ratio

        f.script_gap = offscript_ratio(smask, i, j) - offscript_ratio(smask, j, j + L)

    # ---- audio (optional) ----
    if audio is not None:
        try:
            f.audio_sim = audio.segment_similarity(
                a[0].start, a[-1].end, b[0].start, b[-1].end
            )
        except Exception:
            f.audio_sim = 0.0

    return f
