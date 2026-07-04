"""Regression sample from the user's screenshot (Valentine's dresser ad).

Target behaviour:
  * CUT the reworded retake  "It hugs the arms tied on the chest, but also
    looser on the waist"  (line 9) — currently MISSED.
  * Do NOT cut  "so you can actually move"  inside line 5 — currently a false
    positive (the adverb 'actually' is treated as a correction marker).
Run:  fastcut/.venv/Scripts/python.exe -m fastcut.test_repeat_sample
"""
from __future__ import annotations

from .config import Config
from .engine import run
from .types import WordToken

SENTENCES = [
    "Ladies, if you want a Valentine's Day gift for your man that you also benefit from get him this dresser that you can literally rip off him without ruining a single button.",
    "You know for when things start to get a little spicy after that Valentine's Day dinner.",
    "It hugs the arms and tight on the chest, so it makes them look jacked as fuck, but also loose around the stomach to hide that belly.",
    "It's made out of this silky smooth material that's super stretchy.",
    "So we cant it's made out of the silky smooth material that's super stretchy, so you can actually move it in, it's not uncomfortable, and it's anti-wrinkle, so you can and it's anti-wrinkle, so even when you bunch it up, it still doesn't get wrinkled.",
    "They fit true to size and come in a ton of different colors.",
    "But these sold out last Valentine's Day, so if your man's size is still in stock, I would not wait.",
    "Ladies, if you want to surprise your man for Valentine's Day.",
    "You know, for when things start to get a little spicy after that Valentine's Day dinner.",
    "It hugs the arms tied on the chest, but also looser on the waist.",
    "It hugs the arms and tight on the chest, so it makes them look jacked as fuck, but also looser on the waist behind that belly.",
    "It's made out of this silky smooth material that's super stretchy, and it's made out of the silky smooth material that's super stretchy and it's anti-wrinkle, so you can bunch it up and it still doesn't get wrinkled.",
    "And these fit true to size and come in a ton of different colors, but they sold out last Valentine's Day for obvious reasons.",
    "50 if you still see your man's size, it's in stock.",
    "But these sold out last, but these sold out last Valentine's Day.",
    "But these sold out last Valentine's Day for obvious reasons, so if you still see your man's size is in stock wouldn't wait.",
]


def build_words() -> list[WordToken]:
    words: list[WordToken] = []
    t = 0.0
    for s in SENTENCES:
        toks = s.split()
        for k, tok in enumerate(toks):
            start = t
            end = t + 0.32
            words.append(WordToken(word=tok, start=start, end=end, conf=1.0))
            # small intra-sentence gap, larger gap at the sentence boundary
            t = end + (0.30 if k == len(toks) - 1 else 0.05)
    return words


def main() -> None:
    words = build_words()
    cfg = Config()
    cuts, meta = run(words, cfg)
    print("meta:", {k: meta[k] for k in ("semantic", "words", "candidates", "cuts")})
    for c in cuts:
        print(f"  [{c.confidence:.2f}] {c.kind:14s} \"{c.text}\"")

    hugs_cut = any("tied on the chest" in c.text.lower() for c in cuts)
    # the false positives are fragment cuts landing in "...so you can actually
    # move it in, it's not uncomfortable..." — any cut that is/contains these
    # short fragments (and is NOT the legit "...anti-wrinkle" repeat) is an overcut.
    def bad(t: str) -> bool:
        t = t.lower().strip()
        return ("actually move" in t) or t in ("so you", "so you can", "in stock")
    move_overcut = any(bad(c.text) for c in cuts)
    print("\nRESULT")
    print("  line9 reworded retake CUT :", "PASS" if hugs_cut else "FAIL (missed)")
    print("  'so you can actually move' NOT overcut :",
          "PASS" if not move_overcut else "FAIL (overcut)")


if __name__ == "__main__":
    main()
