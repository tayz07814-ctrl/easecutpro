"""
Lexical text-similarity helpers (no heavy deps).

Uses rapidfuzz when available (fast C++ Levenshtein) and always has a pure-stdlib
SequenceMatcher path, so the core engine runs even if rapidfuzz is absent.
"""

from __future__ import annotations

from difflib import SequenceMatcher
from typing import List

try:
    from rapidfuzz.distance import Levenshtein as _RFLev
    _HAS_RAPIDFUZZ = True
except Exception:  # pragma: no cover - optional
    _HAS_RAPIDFUZZ = False


def seq_ratio(a_tokens: List[str], b_tokens: List[str]) -> float:
    """Token-level SequenceMatcher ratio in [0,1].

    Operates on TOKENS (not characters) so that word insertions/deletions — the
    way restarts actually differ — are measured cleanly."""
    if not a_tokens and not b_tokens:
        return 1.0
    if not a_tokens or not b_tokens:
        return 0.0
    return SequenceMatcher(None, a_tokens, b_tokens, autojunk=False).ratio()


def lev_ratio(a: str, b: str) -> float:
    """Character-level normalized Levenshtein similarity in [0,1].

    Complements token-level matching: catches stutters and partial words
    ('powe—' vs 'powerful') that share characters but differ as tokens."""
    if not a and not b:
        return 1.0
    if not a or not b:
        return 0.0
    if _HAS_RAPIDFUZZ:
        return _RFLev.normalized_similarity(a, b)
    return SequenceMatcher(None, a, b, autojunk=False).ratio()


def prefix_overlap(a_tokens: List[str], b_tokens: List[str]) -> int:
    """Number of identical leading tokens shared by the two token lists."""
    n = 0
    for x, y in zip(a_tokens, b_tokens):
        if x == y:
            n += 1
        else:
            break
    return n


def has_rapidfuzz() -> bool:
    return _HAS_RAPIDFUZZ
