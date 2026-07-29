"""The :class:`SilenceSettings` — the *only* thing the UI hands the engine.

Two vocabularies live here:

* **Raw parameters** (``min_gap_ms``, ``target_pause_ms`` …) — what the engine
  actually consumes. These are surfaced verbatim in the collapsed *Advanced*
  panel for power users.
* **Creator sliders** — three plain-language sliders a non-technical creator
  uses instead. The mapping functions at the bottom translate a slider value
  (0-100) into the raw parameters and back, so the UI can show where a preset
  sits on each slider.

All ``*_ms`` fields are milliseconds.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

from .. import config


@dataclass(slots=True)
class SilenceSettings:
    """Every knob the silence engine understands.

    Attributes
    ----------
    min_gap_ms:
        Pauses **shorter** than this are left completely alone — natural rhythm.
    target_pause_ms:
        A trimmed pause is shortened *down to* this length (not to zero), which
        is what keeps speech from feeling rushed. Used for ordinary word gaps.
    sentence_pause_ms:
        Target pause kept after a sentence ender (``. ? !``) when *Keep Sentence
        Flow* is on. Usually longer than ``target_pause_ms``.
    comma_pause_ms:
        Target pause kept after a comma/clause when *Keep Sentence Flow* is on.
    merge_gap_ms:
        If the speech kept **between** two cuts is shorter than this, the two
        cuts are merged into one (avoids choppy micro-islands).
    pad_before_ms:
        Protected air kept immediately **before** the next word (never cut).
    pad_after_ms:
        Protected air kept immediately **after** the current word (never cut).
    keep_sentence_flow:
        Use the sentence/comma pause targets above. Only consulted when
        ``smart_silence`` is on.
    remove_fillers:
        Also delete filler words (uh, um, erm, you know, like …) and merge the
        silence around them.
    smart_silence:
        Master switch. **On** → punctuation-aware, natural pacing (the sentence
        / comma rules apply, subject to ``keep_sentence_flow``). **Off** → every
        over-threshold gap is trimmed to the single ``target_pause_ms`` with no
        punctuation awareness (plain gap-based).
    """

    # raw parameters (Advanced panel) -------------------------------------- #
    min_gap_ms: float = 300.0
    target_pause_ms: float = 180.0
    sentence_pause_ms: float = 350.0
    comma_pause_ms: float = 250.0
    merge_gap_ms: float = 100.0
    pad_before_ms: float = 60.0
    pad_after_ms: float = 80.0

    # toggles --------------------------------------------------------------- #
    keep_sentence_flow: bool = True
    remove_fillers: bool = False
    smart_silence: bool = True

    def copy(self, **changes: object) -> "SilenceSettings":
        """Return a new settings object with ``changes`` applied (immutable style)."""
        return replace(self, **changes)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Creator-slider <-> raw-parameter mapping                                    #
# --------------------------------------------------------------------------- #
# Sliders are 0-100 integers. Each helper is pure so it can be unit-tested and
# reused by both the controller (slider moved -> settings) and the view (preset
# selected -> where do the sliders sit?).


def _lerp(lo: float, hi: float, t: float) -> float:
    """Linear interpolation; ``t`` clamped to [0, 1]."""
    t = 0.0 if t < 0 else 1.0 if t > 1 else t
    return lo + (hi - lo) * t


def _inv_lerp(lo: float, hi: float, value: float) -> float:
    """Inverse of :func:`_lerp` — where does ``value`` sit in [lo, hi] as [0, 1]?"""
    if hi == lo:
        return 0.0
    t = (value - lo) / (hi - lo)
    return 0.0 if t < 0 else 1.0 if t > 1 else t


def apply_pause_slider(s: SilenceSettings, value: int) -> SilenceSettings:
    """Slider 1 — *Keep More Pauses … Remove More Pauses*.

    Drives ``min_gap_ms`` + ``target_pause_ms``. Higher value = shorter gaps
    kept and a tighter target (remove more).
    """
    t = value / 100.0
    return s.copy(
        min_gap_ms=_lerp(config.BOUNDS_MIN_GAP_MS[1], config.BOUNDS_MIN_GAP_MS[0], t),
        target_pause_ms=_lerp(config.BOUNDS_TARGET_PAUSE_MS[1], config.BOUNDS_TARGET_PAUSE_MS[0], t),
    )


def apply_speed_slider(s: SilenceSettings, value: int) -> SilenceSettings:
    """Slider 2 — *Relaxed Conversation … Fast Conversation*.

    Drives ``sentence_pause_ms`` + ``comma_pause_ms`` (+ nudges the target).
    Higher value = faster, shorter rhetorical pauses.
    """
    t = value / 100.0
    return s.copy(
        sentence_pause_ms=_lerp(config.BOUNDS_SENTENCE_PAUSE_MS[1], config.BOUNDS_SENTENCE_PAUSE_MS[0], t),
        comma_pause_ms=_lerp(config.BOUNDS_COMMA_PAUSE_MS[1], config.BOUNDS_COMMA_PAUSE_MS[0], t),
        target_pause_ms=_lerp(config.BOUNDS_TARGET_PAUSE_MS[1], config.BOUNDS_TARGET_PAUSE_MS[0], t),
    )


def apply_breath_slider(s: SilenceSettings, value: int) -> SilenceSettings:
    """Slider 3 — *Natural Breathing … Minimal Breathing*.

    Drives padding + merge distance. Higher value = tighter breaths (less pad,
    smaller merge distance so more air is swept).
    """
    t = value / 100.0
    pad = _lerp(config.BOUNDS_PAD_MS[1], config.BOUNDS_PAD_MS[0], t)
    return s.copy(
        pad_before_ms=pad * 0.75,
        pad_after_ms=pad,
        merge_gap_ms=_lerp(config.BOUNDS_MERGE_GAP_MS[1], config.BOUNDS_MERGE_GAP_MS[0], t),
    )


def to_sliders(s: SilenceSettings) -> tuple[int, int, int]:
    """Best-fit slider positions (pause, speed, breath) for a settings object.

    Used to place the three sliders when a preset is chosen. Approximate — the
    raw params are the source of truth (Advanced panel).
    """
    pause = _inv_lerp(config.BOUNDS_MIN_GAP_MS[1], config.BOUNDS_MIN_GAP_MS[0], s.min_gap_ms)
    speed = _inv_lerp(config.BOUNDS_SENTENCE_PAUSE_MS[1], config.BOUNDS_SENTENCE_PAUSE_MS[0], s.sentence_pause_ms)
    breath = _inv_lerp(config.BOUNDS_PAD_MS[1], config.BOUNDS_PAD_MS[0], s.pad_after_ms)
    return round(pause * 100), round(speed * 100), round(breath * 100)
