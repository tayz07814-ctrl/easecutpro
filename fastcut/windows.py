"""
Phrase Window Builder (design step 1).

Produces overlapping sliding windows of size [min_window..max_window] over the
flat word list. Each window carries its text, time bounds, and word list.

The detector itself does not *only* consume these fixed windows — it does a
finer-grained restart search over word indices — but the windows are exposed
because (a) the design asks for them, (b) they are useful for the semantic /
audio tiers which embed whole phrases, and (c) they make debugging legible.
"""

from __future__ import annotations

from typing import List

from .config import Config
from .types import Window, WordToken


def build_windows(words: List[WordToken], cfg: Config) -> List[Window]:
    """All overlapping windows of every allowed size, in reading order."""
    out: List[Window] = []
    n = len(words)
    for size in range(cfg.min_window, cfg.max_window + 1):
        for i in range(0, n - size + 1, cfg.window_stride):
            out.append(Window(i=i, j=i + size, words=words[i:i + size]))
    return out


def window(words: List[WordToken], i: int, j: int) -> Window:
    """Convenience: build a single window for the half-open range [i, j)."""
    return Window(i=i, j=j, words=words[i:j])
