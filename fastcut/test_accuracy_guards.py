"""Small guards for Fast Cut precision/recall tuning.

Run:
    fastcut/.venv/Scripts/python.exe -m fastcut.test_accuracy_guards
"""

from __future__ import annotations

from .config import Config
from .engine import run
from .types import WordToken


def words_from_text(text: str, low_conf_until: int = -1) -> list[WordToken]:
    out: list[WordToken] = []
    t = 0.0
    for i, tok in enumerate(text.split()):
        conf = 0.42 if i <= low_conf_until else 0.96
        out.append(WordToken(word=tok, start=t, end=t + 0.28, conf=conf))
        t += 0.34
    return out


def cut_text(cuts) -> str:
    return " | ".join(c.text.lower() for c in cuts)


def main() -> None:
    cfg = Config()

    complete_distinct = words_from_text(
        "It helps strengthen your skin barrier. It helps restore your glow."
    )
    cuts, _ = run(complete_distinct, cfg)
    assert not cuts, f"complete divergent sentences should be kept, got: {cut_text(cuts)}"

    completed_question = words_from_text(
        "But I have sensitive skin. Can I still use it? No. This is probably safe to use."
    )
    cuts, _ = run(completed_question, cfg)
    text = cut_text(cuts)
    assert "use it" not in text, f"completed question should be kept, got: {text}"

    synonym_retake = words_from_text(
        "I'm trying to get my girl this scent. I'm trying to get my girl this perfume."
    )
    cuts, _ = run(synonym_retake, cfg)
    text = cut_text(cuts)
    assert "this scent" in text, f"near-identical synonym retake should be cut, got: {text}"

    abandoned = words_from_text(
        "I want to I want to explain this clearly.",
        low_conf_until=2,
    )
    cuts, _ = run(abandoned, cfg)
    text = cut_text(cuts)
    assert "i want to" in text, f"low-confidence false start should be cut, got: {text}"

    print("accuracy guards: PASS")


if __name__ == "__main__":
    main()
