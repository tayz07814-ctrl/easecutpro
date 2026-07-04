"""
Mini ML model (optional) — design step 7, inference side.

A lightweight sentence-pair classifier (MiniLM / DistilBERT) that takes the
earlier span and the later span and outputs P(retake). Training lives in
train.py; this file is inference only and is loaded lazily by the hybrid system.

Input encoding: the two texts are fed as a SENTENCE PAIR
    tokenizer(text_a, text_b)  ->  "[CLS] text_a [SEP] text_b [SEP]"
which is exactly the "text1 [SEP] text2" format requested, done the correct way
for HF models (proper segment ids + special tokens).

Runs on GPU when available; batched so the whole transcript's candidate pairs
are scored in one forward pass.
"""

from __future__ import annotations

from typing import List, Optional, Tuple


class RetakeClassifier:
    def __init__(self, model_dir: str, device: str = "auto", max_len: int = 64):
        import torch
        from transformers import AutoModelForSequenceClassification, AutoTokenizer

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.torch = torch
        self.max_len = max_len
        self.tok = AutoTokenizer.from_pretrained(model_dir)
        self.model = AutoModelForSequenceClassification.from_pretrained(model_dir).to(device).eval()

    @classmethod
    def try_load(cls, model_dir: str, device: str = "auto") -> Optional["RetakeClassifier"]:
        try:
            return cls(model_dir, device)
        except Exception:
            return None

    def predict_proba_batch(self, pairs: List[Tuple[str, str]], batch_size: int = 64) -> List[float]:
        """P(retake) for each (text_a, text_b) pair. Label index 1 == retake."""
        if not pairs:
            return []
        out: List[float] = []
        for k in range(0, len(pairs), batch_size):
            chunk = pairs[k:k + batch_size]
            enc = self.tok(
                [a for a, _ in chunk],
                [b for _, b in chunk],
                padding=True, truncation=True, max_length=self.max_len,
                return_tensors="pt",
            ).to(self.device)
            with self.torch.no_grad():
                logits = self.model(**enc).logits
                probs = self.torch.softmax(logits, dim=-1)[:, 1]
            out.extend(probs.cpu().tolist())
        return out

    def predict_proba(self, text_a: str, text_b: str) -> float:
        return self.predict_proba_batch([(text_a, text_b)])[0]
