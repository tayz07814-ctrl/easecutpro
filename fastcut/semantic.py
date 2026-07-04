"""
Semantic similarity tier (optional) — sentence-transformers MiniLM.

Lazy and fully optional: if torch / sentence-transformers are not installed
(e.g. on Python 3.14 where torch has no wheels), `SemanticModel.available()`
returns False and the engine silently falls back to lexical similarity.

When present it runs on the GPU (RTX 4060 Ti) and gives the engine real
paraphrase understanding — 'strengthen' vs 'restore your skin barrier' score as
DIFFERENT, while 'big' vs 'large' score as similar — which lexical matching
cannot do.
"""

from __future__ import annotations

from functools import lru_cache
from typing import List, Optional

import numpy as np


class SemanticModel:
    _instance: Optional["SemanticModel"] = None

    def __init__(self, model_name: str, device: str = "auto"):
        from sentence_transformers import SentenceTransformer  # lazy import
        import torch

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.model = SentenceTransformer(model_name, device=device)
        self._cache: dict[str, np.ndarray] = {}

    @classmethod
    def try_load(cls, model_name: str, device: str = "auto") -> Optional["SemanticModel"]:
        """Return a loaded model or None if the deps/model are unavailable."""
        if cls._instance is not None:
            return cls._instance
        try:
            cls._instance = cls(model_name, device)
            return cls._instance
        except Exception:
            return None

    def encode(self, texts: List[str]) -> np.ndarray:
        """L2-normalized embeddings, with a small per-process cache so repeated
        phrases (common in retake-heavy speech) are embedded once."""
        missing = [t for t in texts if t not in self._cache]
        if missing:
            vecs = self.model.encode(
                missing, convert_to_numpy=True, normalize_embeddings=True,
                show_progress_bar=False, batch_size=64,
            )
            for t, v in zip(missing, vecs):
                self._cache[t] = v
        return np.array([self._cache[t] for t in texts])

    def similarity(self, a: str, b: str) -> float:
        if not a.strip() or not b.strip():
            return 0.0
        va, vb = self.encode([a, b])
        # vectors are already normalized => dot product is cosine similarity
        return float(np.clip(np.dot(va, vb), 0.0, 1.0))


@lru_cache(maxsize=1)
def available() -> bool:
    """Cheap probe: are torch + sentence-transformers importable?"""
    try:
        import torch  # noqa: F401
        import sentence_transformers  # noqa: F401
        return True
    except Exception:
        return False
