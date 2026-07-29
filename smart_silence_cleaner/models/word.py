"""The :class:`Word` — one transcript token with its AssemblyAI timestamps.

All times are **milliseconds** (what AssemblyAI returns natively). Keeping the
whole engine in ms avoids float-seconds drift; seconds are produced only at the
very end for FFmpeg (see :mod:`smart_silence_cleaner.models.edl`).
"""

from __future__ import annotations

from dataclasses import dataclass

from ..config import (
    COMMA_ENDERS,
    CONTEXTUAL_FILLERS,
    SENTENCE_ENDERS,
    SINGLE_FILLERS,
)


def normalize(text: str) -> str:
    """Lower-case a token and strip surrounding punctuation for comparison.

    ``"Um,"`` -> ``"um"``. Interior apostrophes are kept (``"don't"``).
    """
    return text.strip().strip(".,!?;:—-…\"'`()[]").lower()


@dataclass(slots=True)
class Word:
    """A single spoken word with its start/end offset (milliseconds).

    Parameters
    ----------
    start_ms, end_ms:
        Offsets from the start of the media, in milliseconds.
    text:
        The raw token text, including any trailing punctuation AssemblyAI
        attached (``"world."``). Punctuation is what drives the sentence/comma
        pause rules, so it is preserved verbatim here.
    """

    start_ms: float
    end_ms: float
    text: str

    # -- derived -------------------------------------------------------------
    @property
    def duration_ms(self) -> float:
        """How long the word itself occupies (never negative)."""
        return max(0.0, self.end_ms - self.start_ms)

    @property
    def clean(self) -> str:
        """The token lower-cased with edge punctuation removed."""
        return normalize(self.text)

    # -- punctuation ---------------------------------------------------------
    def ends_sentence(self) -> bool:
        """True when the token ends a sentence (``.`` ``?`` ``!`` ``…``)."""
        stripped = self.text.rstrip("\"'`)]}")
        return bool(stripped) and stripped[-1] in SENTENCE_ENDERS

    def ends_clause(self) -> bool:
        """True when the token ends a clause (``,`` ``;`` ``:`` ``—``)."""
        stripped = self.text.rstrip("\"'`)]}")
        return bool(stripped) and stripped[-1] in COMMA_ENDERS

    # -- fillers -------------------------------------------------------------
    def is_single_filler(self, include_contextual: bool = True) -> bool:
        """True for a one-word filler (``uh``/``um``/… and optionally ``like``).

        Multi-word fillers such as ``"you know"`` are matched at the sequence
        level in :func:`filler_spans`, not here.
        """
        c = self.clean
        if c in SINGLE_FILLERS:
            return True
        return include_contextual and c in CONTEXTUAL_FILLERS


def parse_words(raw: list[dict]) -> list[Word]:
    """Build :class:`Word` objects from AssemblyAI-style dicts.

    Accepts either millisecond keys (``start``/``end``) — AssemblyAI's native
    shape — or already-built objects. Unknown/short entries are skipped.
    """
    out: list[Word] = []
    for w in raw:
        try:
            start = float(w["start"])
            end = float(w["end"])
            text = str(w.get("text", w.get("word", "")))
        except (KeyError, TypeError, ValueError):
            continue
        if end < start:
            start, end = end, start
        out.append(Word(start_ms=start, end_ms=end, text=text))
    return out
