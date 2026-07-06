"""
Script-anchored cutting (optional tier).

The creator pastes the script they MEANT to say. Aligning the verbatim
transcript against it gives the engine ground truth the heuristics can only
guess at:

  * a word that aligns to the script belongs in the final video;
  * a run of words with no counterpart in the script is a flub, aside, slate or
    abandoned tangent — cut material;
  * between two takes of the same line, the one that matches the script wins
    (fed into scoring as the `script_gap` feature).

Alignment details that matter:
  * it runs on REVERSED token lists — the script holds ONE copy of each line
    while the transcript holds every take, and difflib hands ties to the
    EARLIEST occurrence. Reversed, ties go to the LAST take, matching the
    engine's keep-last rule (aligning forward marked the final take
    "off-script" and cut it — the exact opposite of the goal).
  * ASR garble forgiveness: an unmatched word between matched blocks fuzzy-
    matches (char-level 70%) against the script tokens of that gap, and an
    isolated unmatched word between matched neighbours inherits their state.
  * off-script RUNS are only flagged when they do NOT read as a duplicate of
    scripted content — an earlier take of a scripted line is retake territory
    (cut with keep-last semantics elsewhere), not "off-script".
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import List, Optional

from .textsim import lev_ratio
from .types import WordToken, _normalize


def script_tokens(script: str) -> List[str]:
    return [t for t in (_normalize(w) for w in script.split()) if t]


def script_mask(words: List[WordToken], script: str) -> Optional[List[bool]]:
    """mask[k] = True when transcript word k has a counterpart in the script.
    Returns None when the script is empty after normalization."""
    b = script_tokens(script)
    if not b:
        return None
    a = [w.norm for w in words]
    n = len(a)
    ar, br = a[::-1], b[::-1]
    matched_r = [False] * n
    sm = SequenceMatcher(None, ar, br, autojunk=False)
    blocks = sm.get_matching_blocks()
    for bl in blocks:
        for k in range(bl.size):
            matched_r[bl.a + k] = True
    # Fuzzy pass: an unmatched transcript word sitting in the gap between two
    # matched blocks is compared against the script tokens spanned by that gap —
    # ASR re-spellings ('cojac' for 'kojic') must not read as off-script.
    for gi in range(len(blocks) - 1):
        a_lo, b_lo = blocks[gi].a + blocks[gi].size, blocks[gi].b + blocks[gi].size
        a_hi, b_hi = blocks[gi + 1].a, blocks[gi + 1].b
        if a_hi - a_lo == 0 or b_hi - b_lo == 0:
            continue
        for k in range(a_lo, a_hi):
            w = ar[k]
            if not w or len(w) < 3:
                continue
            if any(lev_ratio(w, br[m]) >= 0.7 for m in range(b_lo, b_hi)):
                matched_r[k] = True
    mask = matched_r[::-1]
    # Isolated unmatched word between matched neighbours: inherit (one-word
    # garble tolerance). Empty-norm tokens inherit their left neighbour.
    for k in range(n):
        if mask[k]:
            continue
        if not a[k] and k > 0:
            mask[k] = mask[k - 1]
        elif 0 < k < n - 1 and mask[k - 1] and mask[k + 1]:
            mask[k] = True
    return mask


def offscript_ratio(mask: List[bool], lo: int, hi: int) -> float:
    """Fraction of words in [lo, hi) with NO counterpart in the script."""
    lo, hi = max(0, lo), min(len(mask), hi)
    if hi <= lo:
        return 0.0
    return sum(1 for k in range(lo, hi) if not mask[k]) / (hi - lo)


def coverage(mask: List[bool]) -> float:
    return sum(mask) / max(1, len(mask))


def run_duplicates_script(words: List[WordToken], lo: int, hi: int, script: str) -> bool:
    """Does words[lo:hi) read as a DUPLICATE of scripted content (an earlier
    take of a scripted line, script tokens already consumed by the final take)?
    Longest-common-substring of the normalized text vs the script covering 60%
    of the run = yes — leave it to the retake logic instead of off-script."""
    run = "".join(w.norm for w in words[lo:hi])
    if not run:
        return True
    b = "".join(script_tokens(script))
    m = SequenceMatcher(None, run, b, autojunk=False).find_longest_match(0, len(run), 0, len(b))
    return m.size >= 0.6 * len(run)
