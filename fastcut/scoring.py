"""
Scoring Engine (design step 3).

Turns a Features record into P(retake) in [0,1] via a transparent weighted sum
pushed through a logistic (sigmoid). Every term is interpretable — you can read
off exactly why a pair scored high or low, which makes tuning tractable (unlike
an LLM's opaque verdict).

    corroboration = tail_sem + (1 - tail_sem) * earlier_incomplete
    match         = combined_sim * corroboration
    z = bias
        + similarity      * match
        + prefix_overlap  * prefix_overlap * corroboration
        + earlier_incomplete * earlier_incomplete
        + marker_before   * marker_before
        + immediate       * immediate * corroboration
        + audio_similarity* audio_sim * corroboration
        + confidence_drop * max(0, conf_diff)         # earlier lower-conf
        - gap             * max(0, gap - 1.0)
    P = sigmoid(z)

`corroboration` is the key false-positive guard. A shared OPENING (high prefix /
similarity) only counts as retake evidence when the CONTINUATION also matches
(high tail_sem) OR the earlier attempt was abandoned (high earlier_incomplete).
For two distinct points that merely start the same way — 'it helps strengthen.'
vs 'it helps restore your skin barrier.' — tail_sem is low and the earlier span
is complete, so corroboration -> ~0, the similarity/prefix evidence is gated out,
and we KEEP both. For a true restart the continuation repeats (tail_sem high) or
the earlier attempt is a fragment (earlier_incomplete high), so it still fires.
"""

from __future__ import annotations

import math

from .config import Config
from .types import Features


def sigmoid(x: float) -> float:
    if x >= 0:
        z = math.exp(-x)
        return 1.0 / (1.0 + z)
    z = math.exp(x)
    return z / (1.0 + z)


def repeat_rule_fires(f: Features, cfg: Config) -> bool:
    """Is the shared opening re-taken often enough to trust the repeat rule?
    4+ shared words: `retake_repeat_count` occurrences (the tuned rule).
    Exactly 3 shared words: far stricter — common 3-word openings ('and then
    we', 'i think the') recur naturally in ordinary speech, so demand
    `retake_repeat_count + 2` occurrences AND real window similarity
    ('warning you might' x6 in the 2026-07-05 skincare run qualifies)."""
    if f.prefix_len >= cfg.retake_repeat_minlen:
        return f.prefix_repeat_count >= cfg.retake_repeat_count
    if f.prefix_len == 3:
        return f.prefix_repeat_count >= cfg.retake_repeat_count + 2 and f.combined_sim >= 0.70
    return False


def corroboration(f: Features, cfg: Config) -> float:
    """In [0,1]: how much the CONTINUATION (not just the opening) supports a
    retake. High when the tails match, or when the earlier attempt was abandoned.
    Near 0 for two complete, distinct thoughts that share an opening — UNLESS the
    shared opening recurs many times (a heavily re-taken line), in which case a
    floor is applied so earlier complete takes still get cut."""
    base = f.tail_sem + (1.0 - f.tail_sem) * f.earlier_incomplete
    if repeat_rule_fires(f, cfg):
        return max(base, cfg.retake_repeat_floor)
    if (
        f.earlier_len_words >= 6
        and f.combined_sim >= 0.93
        and f.prefix_overlap >= 0.75
        and f.immediate >= 0.70
    ):
        # VERBATIM DOUBLE: a complete 6+-word sentence immediately re-said
        # almost word for word ("...20 seconds just by pulling up the sheets."
        # -> "...20 seconds by just pulling up the sheets."). A tiny mid-
        # sentence transposition drops tail_sem, but 0.93 whole-window
        # similarity IS the corroboration — two distinct thoughts never match
        # that closely (bed-skit run, 2026-07-05).
        return max(base, 0.72)
    if (
        f.earlier_len_words >= 5
        and f.prefix_overlap >= 0.75
        and f.combined_sim >= 0.80
        and f.immediate >= 0.70
        and f.final_word_swap >= 1.0
    ):
        # Same sentence restarted with a FINAL-WORD substitution only:
        # "this scent." -> "this perfume." The tail differs lexically, but the
        # long identical opening plus immediate restart is strong retake evidence.
        # final_word_swap keeps this from firing on a LONGER re-elaboration
        # ("…help strengthen." -> "…help restore your skin barrier."), which is a
        # distinct point that must be KEPT.
        return max(base, 0.65)
    if f.connector_restart >= 1.0:
        # "So if they're in stock." -> "So if you see that link there, I would…":
        # a short complete attempt restarted with the same opening and then
        # re-elaborated at length. The tails share nothing lexically, so give
        # this shape its own corroboration floor.
        return max(base, 0.60)
    return base


def score_retake(f: Features, cfg: Config) -> float:
    w = cfg.weights
    corr = corroboration(f, cfg)

    z = w.bias
    z += w.similarity * f.combined_sim * corr        # gated similarity evidence
    z += w.prefix_overlap * f.prefix_overlap * corr  # gated prefix evidence
    z += w.earlier_incomplete * f.earlier_incomplete
    # marker is gated by corroboration: a correction word only counts when the
    # continuation actually repeats (or the earlier attempt was abandoned). Stops
    # ordinary adverbs — "actually", "no", "wait" used as normal speech — from
    # forcing a cut on an unrelated span that merely sits near the marker.
    z += w.marker_before * f.marker_before * corr
    z += w.immediate * f.immediate * corr
    z += w.audio_similarity * f.audio_sim * corr
    z += w.confidence_drop * max(0.0, f.conf_diff)
    if repeat_rule_fires(f, cfg):
        z += w.repeat_bonus * f.combined_sim  # heavily-retaken line: drop earlier takes
    z += w.connector_restart * f.connector_restart  # paraphrase restart of a short attempt

    z -= w.gap * max(0.0, f.gap - 1.0)
    return sigmoid(z)


def explain(f: Features, cfg: Config) -> dict:
    """Per-term contribution breakdown — for debugging / tuning / UI tooltips."""
    w = cfg.weights
    corr = corroboration(f, cfg)
    terms = {
        "bias": w.bias,
        "similarity": w.similarity * f.combined_sim * corr,
        "prefix_overlap": w.prefix_overlap * f.prefix_overlap * corr,
        "earlier_incomplete": w.earlier_incomplete * f.earlier_incomplete,
        "marker_before": w.marker_before * f.marker_before * corr,
        "immediate": w.immediate * f.immediate * corr,
        "audio_similarity": w.audio_similarity * f.audio_sim * corr,
        "confidence_drop": w.confidence_drop * max(0.0, f.conf_diff),
        "repeat_bonus": (w.repeat_bonus * f.combined_sim
                         if repeat_rule_fires(f, cfg) else 0.0),
        "connector_restart": w.connector_restart * f.connector_restart,
        "-gap": -w.gap * max(0.0, f.gap - 1.0),
    }
    z = sum(terms.values())
    return {"z": z, "prob": sigmoid(z), "terms": terms, "corroboration": corr}
