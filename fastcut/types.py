"""Core data structures shared across the engine."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional


@dataclass
class WordToken:
    """One transcribed word with its source-media time range and ASR confidence."""

    word: str
    start: float
    end: float
    conf: float = 1.0

    @property
    def norm(self) -> str:
        """Lower-cased, punctuation-stripped form used for matching."""
        return _normalize(self.word)

    @property
    def ends_sentence(self) -> bool:
        """True if the raw token ends a sentence (so the NEXT word starts a new
        one). Used to keep restart anchors on sentence starts, not on a previous
        sentence's trailing word."""
        s = self.word.rstrip("\"')]}>")
        return s.endswith((".", "!", "?", "…"))


def _normalize(s: str) -> str:
    # Apostrophes are DROPPED (not kept) so contractions match their stems:
    # "you're" -> "youre" startswith "your" -> the cut-off-fragment rule fires.
    # Keeping them made "you're" vs "your" look unrelated and missed restarts.
    out = []
    for ch in s.lower():
        if ch.isalnum():
            out.append(ch)
    return "".join(out)


@dataclass
class Window:
    """A contiguous run of words (a candidate phrase)."""

    i: int            # index of first word (inclusive)
    j: int            # index after last word (exclusive)
    words: List[WordToken]

    @property
    def start(self) -> float:
        return self.words[0].start

    @property
    def end(self) -> float:
        return self.words[-1].end

    @property
    def text(self) -> str:
        return " ".join(w.word for w in self.words)

    @property
    def norm_tokens(self) -> List[str]:
        return [w.norm for w in self.words if w.norm]

    @property
    def duration(self) -> float:
        return max(1e-6, self.end - self.start)


@dataclass
class Features:
    """All per-pair features, kept as a flat dict-able record for transparency,
    debugging, and as the feature vector for the optional ML model."""

    seq_sim: float = 0.0          # SequenceMatcher token ratio
    lev_sim: float = 0.0          # rapidfuzz / Levenshtein ratio
    sem_sim: float = 0.0          # semantic cosine (or lexical fallback)
    combined_sim: float = 0.0     # blended similarity actually used in scoring
    align_sim: float = 0.0        # length-robust full-span alignment similarity
    prefix_overlap: float = 0.0   # shared leading-token fraction
    tail_sem: float = 1.0         # semantic sim of the post-prefix tails
    earlier_incomplete: float = 0.0
    earlier_len_words: int = 0
    marker_before: float = 0.0
    immediate: float = 0.0
    gap: float = 0.0              # seconds between earlier-end and later-start
    dur_ratio: float = 1.0
    rate_earlier: float = 0.0     # words/sec
    rate_later: float = 0.0
    rate_change: float = 0.0
    conf_earlier: float = 1.0
    conf_later: float = 1.0
    conf_diff: float = 0.0        # later - earlier
    audio_sim: float = 0.0
    prefix_repeat_count: int = 1  # how many times the shared opening appears overall
    prefix_len: int = 0           # shared leading tokens (raw count, not fraction)
    final_word_swap: float = 0.0  # same sentence, only the ending swapped (tails <=2 words)
    connector_restart: float = 0.0  # short attempt restarted w/ same opening + longer re-elaboration
    earlier_ends_sentence: float = 0.0
    trailing_fragment: float = 0.0
    restart_pause: float = 0.0

    def vector(self) -> List[float]:
        """Ordered numeric vector (handy for ML / logging / ONNX)."""
        return [
            self.seq_sim, self.lev_sim, self.sem_sim, self.combined_sim,
            self.prefix_overlap, self.tail_sem, self.earlier_incomplete,
            float(self.earlier_len_words), self.marker_before, self.immediate,
            self.gap, self.dur_ratio, self.rate_earlier, self.rate_later,
            self.rate_change, self.conf_earlier, self.conf_later, self.conf_diff,
            self.audio_sim, float(self.prefix_repeat_count),
            self.earlier_ends_sentence, self.trailing_fragment, self.restart_pause,
        ]


@dataclass
class Candidate:
    i: int                 # first word of the abandoned attempt (inclusive)
    j: int                 # restart point = first word of the kept take (exclusive end of cut)
    L: int                 # comparison length used
    prob: float            # heuristic probability
    feats: Features
    kind: str = "retake"   # retake | repetition | false_start | partial_restart
    ml_prob: Optional[float] = None
    final_prob: float = 0.0
    probe: bool = False    # gate-rejected garble shape kept ONLY for semantic rescue


@dataclass
class Cut:
    cut_start: float
    cut_end: float
    confidence: float
    kind: str = "retake"
    # debug / explainability extras (ignored by the minimal JSON consumer)
    text: str = ""
    word_range: tuple[int, int] = (0, 0)

    def to_json(self, verbose: bool = False) -> dict:
        d = {
            "cut_start": round(self.cut_start, 3),
            "cut_end": round(self.cut_end, 3),
            "confidence": round(self.confidence, 3),
        }
        if verbose:
            d["kind"] = self.kind
            d["text"] = self.text
            d["word_range"] = list(self.word_range)
        return d


def words_from_json(items: list) -> List[WordToken]:
    """Parse the transcription payload into WordTokens.

    Accepts both {"word",...} (spec) and {"text",...} (EaseCutPro's Word type),
    and tolerates a missing 'conf' (defaults to 1.0)."""
    out: List[WordToken] = []
    for it in items:
        w = it.get("word", it.get("text", ""))
        if w is None:
            w = ""
        out.append(
            WordToken(
                word=str(w),
                start=float(it.get("start", 0.0)),
                end=float(it.get("end", it.get("start", 0.0))),
                conf=float(it.get("conf", it.get("confidence", 1.0))),
            )
        )
    return out
