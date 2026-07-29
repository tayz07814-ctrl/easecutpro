"""Headless engine tests — pure Python, NO Qt, runnable with plain `python`.

Run:  python -m smart_silence_cleaner.tests.test_engine
It prints a summary and exits non-zero if any assertion fails. These lock the
canonical behaviour that the web (TypeScript) port must reproduce exactly.
"""

from __future__ import annotations

from ..engine.silence_engine import SilenceEngine
from ..models.presets import PresetManager
from ..models.settings import SilenceSettings
from ..models.word import Word

_checks = 0
_fails = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _checks, _fails
    _checks += 1
    if cond:
        print(f"  ok   {name}")
    else:
        _fails += 1
        print(f"  FAIL {name}  {detail}")


def w(start: float, end: float, text: str = "word") -> Word:
    return Word(start_ms=start, end_ms=end, text=text)


def test_trim_to_target() -> None:
    """900ms gap, mid-sentence, Balanced (target 180) -> removes exactly 720ms."""
    words = [w(0, 1000, "hello"), w(1900, 2400, "there")]  # gap = 900
    s = PresetManager.get("balanced").settings
    plan = SilenceEngine.plan(words, s, original_duration_ms=2400)
    check("one cut produced", len(plan.cuts) == 1, f"cuts={len(plan.cuts)}")
    if plan.cuts:
        cut = plan.cuts[0]
        removed = cut.removed_ms
        check("removed == 720ms (900-180)", abs(removed - 720) < 1.0, f"removed={removed}")
        kept_pause = 900 - removed
        check("kept pause == target 180ms", abs(kept_pause - 180) < 1.0, f"kept={kept_pause}")
        # SYMMETRIC split: 90ms (target/2) of silence retained on EACH side.
        silence_before = cut.start_ms - 1000  # after current word (end=1000)
        silence_after = 1900 - cut.end_ms     # before next word (start=1900)
        check("90ms kept after current word", abs(silence_before - 90) < 1.0, f"before={silence_before}")
        check("90ms kept before next word", abs(silence_after - 90) < 1.0, f"after={silence_after}")
        check("split is symmetric (both sides equal)", abs(silence_before - silence_after) < 0.5,
              f"before={silence_before} after={silence_after}")


def test_below_threshold_kept() -> None:
    """A gap under min_gap is left completely alone."""
    words = [w(0, 1000), w(1200, 1600)]  # gap 200 < balanced min_gap 300
    s = PresetManager.get("balanced").settings
    plan = SilenceEngine.plan(words, s, 1600)
    check("no cut below min_gap", len(plan.cuts) == 0, f"cuts={len(plan.cuts)}")


def test_gapless_removes_everything() -> None:
    """Aggressive Gapless: every gap > 80ms collapses to ~0 (whole gap removed)."""
    words = [w(0, 1000), w(1300, 1700)]  # gap 300
    s = PresetManager.get("aggressive_gapless").settings
    plan = SilenceEngine.plan(words, s, 1700)
    check("gapless makes one cut", len(plan.cuts) == 1, f"cuts={len(plan.cuts)}")
    if plan.cuts:
        check("gapless removes the whole 300ms gap", abs(plan.cuts[0].removed_ms - 300) < 1.0, f"removed={plan.cuts[0].removed_ms}")
    # a 60ms gap (< 80 min) survives
    words2 = [w(0, 1000), w(1060, 1400)]
    plan2 = SilenceEngine.plan(words2, s, 1400)
    check("gapless keeps sub-80ms gap", len(plan2.cuts) == 0, f"cuts={len(plan2.cuts)}")


def test_punctuation_targets() -> None:
    """Sentence enders keep a longer pause than plain gaps (Smart Silence on)."""
    s = PresetManager.get("balanced").settings  # sentence 350, comma 250, target 180
    sent = SilenceEngine.plan([w(0, 1000, "done."), w(2000, 2400, "next")], s, 2400)  # gap 1000
    plain = SilenceEngine.plan([w(0, 1000, "and"), w(2000, 2400, "then")], s, 2400)   # gap 1000
    if sent.cuts and plain.cuts:
        sent_kept = 1000 - sent.cuts[0].removed_ms
        plain_kept = 1000 - plain.cuts[0].removed_ms
        check("sentence pause (350) > plain pause (180)", sent_kept > plain_kept, f"sent={sent_kept} plain={plain_kept}")
        check("sentence keeps ~350ms", abs(sent_kept - 350) < 1.0, f"sent={sent_kept}")


def test_smart_off_is_uniform() -> None:
    """Smart Silence OFF ignores punctuation — sentence gap uses the plain target."""
    s = PresetManager.get("balanced").settings.copy(smart_silence=False)
    sent = SilenceEngine.plan([w(0, 1000, "done."), w(2000, 2400, "next")], s, 2400)
    if sent.cuts:
        kept = 1000 - sent.cuts[0].removed_ms
        check("smart-off keeps plain target 180 after '.'", abs(kept - 180) < 1.0, f"kept={kept}")


def test_filler_removal_merges() -> None:
    """'um' between two words is removed and the surrounding silence collapses."""
    words = [w(0, 1000, "the"), w(1200, 1500, "um"), w(1700, 2200, "point")]
    off = PresetManager.get("balanced").settings.copy(remove_fillers=False)
    on = PresetManager.get("balanced").settings.copy(remove_fillers=True)
    plan_off = SilenceEngine.plan(words, off, 2200)
    plan_on = SilenceEngine.plan(words, on, 2200)
    check("fillers off removes less than on", plan_on.stats.time_saved_ms > plan_off.stats.time_saved_ms,
          f"off={plan_off.stats.time_saved_ms} on={plan_on.stats.time_saved_ms}")
    check("filler count reported", plan_on.stats.fillers_removed == 1, f"fillers={plan_on.stats.fillers_removed}")


def test_keeps_complement() -> None:
    """KEEP ranges are the exact complement of the cuts over [0, duration]."""
    s = PresetManager.get("aggressive").settings
    words = [w(0, 1000), w(1800, 2400), w(3600, 4000)]
    plan = SilenceEngine.plan(words, s, 4200)
    # keeps + cuts must tile [0, 4200] with no overlap/gap
    covered = sorted([*plan.keeps, *[(c.start_ms, c.end_ms) for c in plan.cuts]], key=lambda t: t[0])
    ok = covered and abs(covered[0][0]) < 1e-6 and abs(covered[-1][1] - 4200) < 1e-6
    for a, b in zip(covered, covered[1:]):
        if abs(a[1] - b[0]) > 1e-6:
            ok = False
    check("keeps+cuts tile the whole timeline", ok, f"covered={covered}")


def test_sample_smoke() -> None:
    """The demo transcript runs and produces sane stats under every preset."""
    from ..sample_data import SAMPLE_DURATION_MS, sample_words

    for p in PresetManager.all():
        plan = SilenceEngine.plan(sample_words(), p.settings, SAMPLE_DURATION_MS)
        ok = (
            0 <= plan.stats.time_saved_ms <= SAMPLE_DURATION_MS
            and plan.stats.output_duration_ms <= SAMPLE_DURATION_MS
            and all(c.end_ms > c.start_ms for c in plan.cuts)
        )
        check(f"preset '{p.id}' produces a sane plan", ok,
              f"saved={plan.stats.time_saved_ms:.0f} cuts={len(plan.cuts)}")


def main() -> int:
    for fn in [
        test_trim_to_target,
        test_below_threshold_kept,
        test_gapless_removes_everything,
        test_punctuation_targets,
        test_smart_off_is_uniform,
        test_filler_removal_merges,
        test_keeps_complement,
        test_sample_smoke,
    ]:
        print(f"\n{fn.__name__}:")
        fn()
    print(f"\n{_checks - _fails}/{_checks} checks passed")
    return 1 if _fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
