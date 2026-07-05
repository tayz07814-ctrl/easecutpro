"""
Central configuration for the Fast Cut retake-detection engine.

Everything tunable lives here so you can adjust behaviour without touching the
algorithm. The scoring weights are the heart of accuracy — each one is
documented with *why* it matters and which direction pushes "this is a retake".

All times are in SECONDS (matching the transcription output).
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class ScoringWeights:
    """
    Linear weights fed into a logistic (sigmoid) to produce P(retake) in [0,1].

    Sign convention: a POSITIVE weight on a feature that is high for real retakes
    pushes the probability UP. Penalty terms carry their negative sign inline in
    scoring.py, so keep these magnitudes positive and let scoring.py subtract.
    """

    bias: float = -3.0
    """Intercept. Negative so that, with no evidence, P(retake) is low (we are
    conservative — cutting real content is worse than missing a repeat)."""

    similarity: float = 4.5
    """Overall text similarity between the earlier span and the later span.
    The single strongest signal: a retake says (almost) the same words again.
    Gated by `corroboration` in scoring.py so a shared opening alone is not
    enough — the continuation must agree too."""

    prefix_overlap: float = 1.5
    """Fraction of leading words shared. Restarts almost always repeat the
    OPENING ("I think we should— I think we should..."). Also gated by
    corroboration so two distinct points sharing an opening are not cut."""

    earlier_incomplete: float = 2.4
    """The earlier attempt looks abandoned (short / trails off / lower confidence
    at its end). Incomplete-then-repeated is the definition of a false start."""

    marker_before: float = 1.9
    """A correction marker ("sorry", "i mean", "let me", "actually", "wait")
    sits just before the restart. Strong intent-to-redo signal."""

    immediate: float = 0.9
    """The later span immediately follows the earlier one (no unrelated words in
    between). Consecutive duplicates are far more likely to be retakes than two
    matching phrases separated by a sentence of other content. Gated by
    corroboration so adjacent DISTINCT sentences don't score on immediacy alone."""

    audio_similarity: float = 2.2
    """Cosine similarity of wav2vec2 audio embeddings of the two spans (optional
    tier). Same words AND same acoustic delivery => very confident retake. Only
    contributes when the audio tier is enabled."""

    confidence_drop: float = 1.1
    """The earlier span has lower ASR confidence than the later one. Mumbled /
    abandoned takes transcribe worse than the clean final take."""

    # ----- penalty weights (scoring.py subtracts these) -----

    tail_divergence: float = 0.0
    """DEPRECATED / unused. The tail-divergence guard is now built directly into
    `corroboration` (scoring.py): gating the similarity & prefix evidence is
    stronger than a separate subtractive penalty. Kept at 0.0 for config
    backward-compatibility."""

    gap: float = 0.8
    """Penalty. A long pause between the two spans makes a retake less likely
    (the speaker moved on rather than restarting)."""

    connector_restart: float = 1.8
    """Bonus for the connector-restart shape: a SHORT complete attempt restarted
    with the same >=2-token opening and then re-elaborated at length ("So if
    they're in stock." -> "So if you see that link there, I would freaking
    run."). Lexical tail similarity is blind to these paraphrase restarts, so
    the shape carries its own evidence (features.connector_restart)."""

    repeat_bonus: float = 1.1
    """Bonus (x combined_sim) applied when the shared opening recurs enough times
    to trip the repeat-count rule. A line taken 3+ times where THIS take still
    aligns well with a later one is almost certainly an earlier take to drop —
    even when it's a COMPLETE-length reworded take (so earlier_incomplete=0 and the
    fixed-window prefix is diluted). Gated by combined_sim, so it only lifts pairs
    that are genuinely similar."""


@dataclass
class Config:
    # ---- phrase window builder ----
    min_window: int = 3
    max_window: int = 8
    window_stride: int = 1

    # ---- candidate search ----
    min_phrase: int = 2
    """Minimum comparable length (words) for a candidate pair. Below this,
    matches are noise ('the', 'and')."""
    max_phrase: int = 12
    """Maximum comparable length. Caps how much of each take we line up."""
    max_lookback: int = 26
    """How many words back from a potential restart point we search for the
    abandoned attempt it restarts. Needs to span TWO long repeated sentences so
    a line re-taken several times (each ~10 words) collapses to the last take.
    The sentence-anchor + corroboration + repeat-count guards keep the wider
    search from over-cutting."""
    lookahead_windows: int = 6
    """Reported for parity with the design spec; the lookback search above is the
    operational knob (a restart at j looks back, which is equivalent to each
    window looking ahead N)."""

    # ---- heavily-retaken lines ----
    retake_repeat_count: int = 3
    """If a candidate's shared OPENING phrase (>= retake_repeat_minlen words)
    occurs at least this many times across the transcript, the line is being
    re-taken repeatedly, so earlier COMPLETE takes are cut even when only the
    final word differs (e.g. '...raccoon eyes this year' vs '...this summer').
    Distinct points that merely share a short opening don't repeat this often, so
    they're untouched."""
    retake_repeat_minlen: int = 4
    """Minimum shared-opening length (words) for the repeat-count rule, so common
    short fragments ('the', 'i think') never trigger it."""
    retake_repeat_floor: float = 0.72
    """Corroboration floor applied when the repeat-count rule fires — enough to
    clear the gate for a divergent-tail complete earlier take."""

    # ---- decision thresholds ----
    min_candidate_prob: float = 0.45
    """A pair must score at least this to become a cut candidate."""
    accept_threshold: float = 0.60
    """Final hybrid probability required to actually emit a cut."""
    extend_accept_threshold: float = 0.50
    """Lower bar for BACKWARD EXTENSION of an already-confirmed cut. The line is
    proven re-taken at this point and the distinct-content protections live in
    the detect gates (sentence-anchor, tail/corroboration), so a chained earlier
    take that scores 0.5+ against the true survivor is swallowed instead of
    surviving on a technicality (garbled 'Warning you warn you might…' take 1,
    2026-07-05 skincare run: 0.568 vs the old 0.60 bar)."""
    merge_gap: float = 0.25
    """Adjacent cuts closer than this (seconds) are merged into one range."""

    # ---- correction markers (lower-cased, matched as token runs) ----
    markers: tuple[str, ...] = (
        "sorry", "oops", "wait", "no", "actually", "i mean", "let me",
        "let's try", "scratch that", "start over", "again", "hold on", "um no",
    )
    """These signal an intentional redo when they sit just before a repeat. NOTE:
    a marker ALONE never triggers a cut — there must also be a matching repeat —
    which is how we avoid nuking a legitimate 'I mean' that is real content."""

    weak_markers: tuple[str, ...] = ("no", "again")
    """Markers too common as ORDINARY content words to stand in for the shared
    leading-word anchor. They still add score (weights.marker_before) next to a
    real repeat, but a candidate whose ONLY anchor is a weak marker is rejected
    — 'there's NO way this works' must not license a cut of the words before it
    (real false cut caught in the 2026-07-05 bed-skit run)."""

    # ---- tiers (auto-disabled if deps/inputs are missing) ----
    use_semantic: bool = True
    """sentence-transformers MiniLM embeddings for similarity. Falls back to
    lexical-only if torch / the package is unavailable."""
    use_audio: bool = False
    """wav2vec2 acoustic similarity. Requires an audio file path + torchaudio."""
    use_classifier: bool = False
    """Trained MiniLM/DistilBERT retake classifier for the hybrid decision."""

    # ---- debug dump ----
    debug_dump: bool = True
    """Write a full record of every run (input words, config, every candidate
    with its features/score, final cuts, ML verify verdicts) to `debug_path` so
    a surprising run can be diagnosed after the fact. Best-effort: a failed
    write never breaks the run."""
    debug_path: str = ""
    """Where the dump goes. Empty = `fastcut/last_run.json` next to the package
    (overwritten each run; the previous run is kept as last_run.prev.json)."""

    # ---- batched ML verification of the FINAL cuts (engine._verify_cuts) ----
    # The tiers never run inside the candidate search (a model call per window
    # pair is minutes of CPU on long transcripts); they only judge the final cuts.
    verify_corroborate_sim: float = 0.75
    """Semantic/acoustic similarity at or above this corroborates a cut (small
    confidence lift; an acoustic match also blocks the semantic veto)."""
    verify_veto_sim: float = 0.0
    """A cut whose abandoned attempt reads as a DIFFERENT thought (semantic sim
    below this) is vetoed — but only when the heuristic was unsure (below
    verify_veto_max_conf) and the audio doesn't say 'same delivery'. DISABLED
    (0.0) by default: reworded restarts ("So if they're in stock." -> "So if you
    see that link…") legitimately read as different thoughts to MiniLM, so a
    semantic veto deletes true cuts the tuned lexical gates fought to keep.
    Raise to ~0.3 to experiment with over-cut protection."""
    verify_veto_max_conf: float = 0.72
    """Cuts at or above this heuristic confidence are never semantically vetoed
    (the tuned lexical core has final say on its confident cuts)."""

    # ---- batched semantic RESCUE of borderline candidates ----
    semantic_rescue_floor: float = 0.30
    """Candidates scoring in [floor, accept_threshold) get ONE batched semantic
    re-score. This is where the ML tier earns recall: ASR garble ('transitionic'
    vs 'transemic acid' for tranexamic) floors lexical similarity on true
    retakes, while MiniLM still reads both spans as the same line."""
    semantic_rescue_sim: float = 0.80
    """Semantic similarity of the full spans required to rescue. High on
    purpose: distinct points sharing an opening ('help strengthen.' vs 'help
    restore your skin barrier.') read as DIFFERENT meanings to MiniLM and stay
    below this, so the strengthen/restore keep-guarantee holds."""

    semantic_model: str = "sentence-transformers/all-MiniLM-L6-v2"
    audio_model: str = "facebook/wav2vec2-base-960h"
    classifier_path: str = ""  # path to a fine-tuned classifier dir (optional)

    # ---- hybrid blend ----
    hybrid_alpha: float = 0.6
    """final = alpha*heuristic + (1-alpha)*classifier. 1.0 => heuristic only.
    Used only when the classifier tier is active."""

    device: str = "auto"  # "auto" | "cuda" | "cpu"

    weights: ScoringWeights = field(default_factory=ScoringWeights)

    def to_dict(self) -> dict:
        return asdict(self)

    @staticmethod
    def from_dict(d: Optional[dict]) -> "Config":
        if not d:
            return Config()
        w = d.pop("weights", None) if isinstance(d, dict) else None
        cfg = Config(**{k: v for k, v in d.items() if k in Config.__dataclass_fields__})
        if w:
            cfg.weights = ScoringWeights(
                **{k: v for k, v in w.items() if k in ScoringWeights.__dataclass_fields__}
            )
        return cfg
