"""Regressions for restart shapes the engine used to miss (user screenshots),
plus the keep-guarantees that must never regress.
Run: fastcut/.venv/Scripts/python.exe -m fastcut.test_missed_restarts
"""
from __future__ import annotations

from .config import Config
from .engine import run
from .types import WordToken


def words_from(sentences, gap_between=0.25):
    words = []
    t = 0.0
    for s in sentences:
        for tok in s.split():
            words.append(WordToken(word=tok, start=t, end=t + 0.28))
            t += 0.3
        t += gap_between
    return words


def cut_texts(sents, gap=0.25):
    cuts, _ = run(words_from(sents, gap_between=gap), Config())
    return [c.text for c in cuts]


ok = True


def check(name, cond):
    global ok
    print(f"  {'PASS' if cond else 'FAIL'}  {name}")
    ok = ok and cond


print("1) contraction fragment restart (you're -> your)")
cuts = cut_texts([
    "Like, do not be surprised if you're got or",
    "do not be surprised if your man's wants to live up in your neck after wearing this.",
])
check("garbled first attempt cut", any("you're got or" in t for t in cuts))
check("kept take's opening not eaten", not any("your man's" in t for t in cuts))

print("2) connector paraphrase restart (So if …)")
cuts = cut_texts([
    "So if they're in stock.",
    "So if you see that link there, I would freaking run.",
])
check("abandoned short attempt cut", any("they're in stock" in t for t in cuts))
check("re-elaboration kept", not any("freaking run" in t for t in cuts))

print("3) KEEP: distinct points sharing a long opening (strengthen/restore)")
cuts = cut_texts([
    "But most importantly, it's gonna help strengthen.",
    "But most importantly, it's gonna help restore your skin barrier.",
])
check("neither distinct point cut", not any("strengthen" in t or "restore" in t for t in cuts))

print("4) KEEP: deliberate anaphora list (content opening)")
cuts = cut_texts([
    "I love the smell.",
    "I love the price, and honestly the bottle looks amazing too.",
])
check("anaphora list untouched", not cuts)

print("5) final-word swap still cut (scent -> perfume)")
# an IMMEDIATE restart (tight gap, like whisper.cpp contiguous stamps) — the
# swap floor deliberately requires immediacy so slower re-mentions stay kept.
cuts = cut_texts([
    "You are going to fall in love with this scent.",
    "You are going to fall in love with this perfume.",
], gap=0.08)
check("earlier swap-take cut", any("this scent" in t for t in cuts))

print("\nMISSED-RESTARTS " + ("OK" if ok else "FAILED"))
raise SystemExit(0 if ok else 1)
