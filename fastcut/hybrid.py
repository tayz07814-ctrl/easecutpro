"""
Hybrid Decision System (design step 8).

Blends the transparent heuristic probability with the optional learned
classifier's probability:

    final = alpha * heuristic + (1 - alpha) * classifier

`alpha = 1.0` (or no classifier loaded) => pure heuristic, which is the default
shipping behaviour. As you collect labelled data and train the classifier, lower
alpha to lean on it. The threshold that turns `final` into a cut lives in
Config.accept_threshold, so heuristic and hybrid share one tunable gate.
"""

from __future__ import annotations

from typing import List, Optional

from .config import Config
from .types import Candidate, WordToken


def apply_hybrid(
    candidates: List[Candidate],
    words: List[WordToken],
    cfg: Config,
    classifier=None,
) -> List[Candidate]:
    use_clf = classifier is not None and cfg.use_classifier
    pairs = []
    if use_clf:
        for c in candidates:
            a = " ".join(w.word for w in words[c.i:c.i + c.L])
            b = " ".join(w.word for w in words[c.j:c.j + c.L])
            pairs.append((a, b))
        probs = classifier.predict_proba_batch(pairs)  # one batched GPU call
    for idx, c in enumerate(candidates):
        if use_clf:
            c.ml_prob = float(probs[idx])
            c.final_prob = cfg.hybrid_alpha * c.prob + (1.0 - cfg.hybrid_alpha) * c.ml_prob
        else:
            c.final_prob = c.prob
    return candidates
