"""
Mini ML model (optional) — design step 7, training side.

Trains a MiniLM / DistilBERT sentence-pair classifier to output P(retake).

DATASET FORMAT (JSONL, one object per line):
    {"text_a": "i think we should", "text_b": "i think we should go", "label": 1}
    {"text_a": "the weather is nice", "text_b": "the team is shipping", "label": 0}
  label 1 = text_b is a retake/repetition of text_a ; 0 = not.

Two ways to get data:
  1. Hand-label pairs (best quality).
  2. WEAK SUPERVISION (no labeling): `bootstrap` runs the heuristic engine over
     your real transcripts and emits silver-labelled pairs — positives from
     accepted candidates, hard negatives from high-prefix-but-rejected pairs and
     random distant pairs. Train on these, then optionally hand-correct.

USAGE:
    # 1) make a dataset from your transcripts (folder of word-list JSON files)
    python -m fastcut.train bootstrap --transcripts ./transcripts --out data.jsonl

    # 2) train (GPU auto-detected)
    python -m fastcut.train train --data data.jsonl --out ./models/retake-minilm \
        --base sentence-transformers/all-MiniLM-L6-v2 --epochs 3

    # 3) point the engine at it:  Config(use_classifier=True, classifier_path=...)
"""

from __future__ import annotations

import argparse
import glob
import json
import os
from typing import List, Tuple

from .config import Config
from .detect import find_candidates
from .features import extract_features
from .scoring import score_retake
from .types import words_from_json


# --------------------------------------------------------------------------- #
# Weak-supervision dataset bootstrap
# --------------------------------------------------------------------------- #
def bootstrap_dataset(transcript_files: List[str], cfg: Config) -> List[dict]:
    rows: List[dict] = []
    for path in transcript_files:
        try:
            words = words_from_json(json.load(open(path, "r", encoding="utf-8")))
        except Exception:
            continue
        if len(words) < cfg.min_window:
            continue

        cands = find_candidates(words, cfg)  # heuristic-only (no torch needed)
        for c in cands:
            a = " ".join(w.word for w in words[c.i:c.i + c.L])
            b = " ".join(w.word for w in words[c.j:c.j + c.L])
            if c.prob >= cfg.accept_threshold:
                rows.append({"text_a": a, "text_b": b, "label": 1})        # positive
            elif c.feats.prefix_overlap >= 0.5 and c.prob <= 0.30:
                rows.append({"text_a": a, "text_b": b, "label": 0})        # hard negative

        # random distant pairs as easy negatives (different parts of the talk)
        n = len(words)
        step = max(8, n // 12)
        for i in range(0, n - step - 4, step):
            a = " ".join(w.word for w in words[i:i + 5])
            b = " ".join(w.word for w in words[i + step:i + step + 5])
            rows.append({"text_a": a, "text_b": b, "label": 0})
    return rows


# --------------------------------------------------------------------------- #
# Training
# --------------------------------------------------------------------------- #
def train_model(data_path: str, out_dir: str, base: str, epochs: int, max_len: int = 64):
    import numpy as np
    import torch
    from datasets import Dataset
    from transformers import (
        AutoModelForSequenceClassification, AutoTokenizer,
        Trainer, TrainingArguments,
    )

    rows = [json.loads(l) for l in open(data_path, "r", encoding="utf-8") if l.strip()]
    ds = Dataset.from_list(rows).train_test_split(test_size=0.1, seed=42)

    tok = AutoTokenizer.from_pretrained(base)

    def encode(b):
        return tok(b["text_a"], b["text_b"], truncation=True, max_length=max_len)

    ds = ds.map(encode, batched=True)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=2)

    def metrics(eval_pred):
        logits, labels = eval_pred
        preds = np.argmax(logits, axis=-1)
        tp = int(((preds == 1) & (labels == 1)).sum())
        fp = int(((preds == 1) & (labels == 0)).sum())
        fn = int(((preds == 0) & (labels == 1)).sum())
        prec = tp / (tp + fp + 1e-9)
        rec = tp / (tp + fn + 1e-9)
        f1 = 2 * prec * rec / (prec + rec + 1e-9)
        return {"precision": prec, "recall": rec, "f1": f1}

    args = TrainingArguments(
        output_dir=out_dir,
        num_train_epochs=epochs,
        per_device_train_batch_size=32,
        per_device_eval_batch_size=64,
        learning_rate=2e-5,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        metric_for_best_model="f1",
        fp16=torch.cuda.is_available(),     # use the 4060 Ti's tensor cores
        report_to=[],
        logging_steps=25,
    )
    trainer = Trainer(
        model=model, args=args,
        train_dataset=ds["train"], eval_dataset=ds["test"],
        compute_metrics=metrics,
    )
    trainer.train()
    trainer.save_model(out_dir)
    tok.save_pretrained(out_dir)
    print(f"saved classifier -> {out_dir}")
    print("eval:", trainer.evaluate())


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fastcut.train")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("bootstrap", help="weak-label a dataset from transcripts")
    b.add_argument("--transcripts", required=True, help="folder of word-list JSON files")
    b.add_argument("--out", required=True)

    t = sub.add_parser("train", help="train the classifier")
    t.add_argument("--data", required=True)
    t.add_argument("--out", required=True)
    t.add_argument("--base", default="sentence-transformers/all-MiniLM-L6-v2")
    t.add_argument("--epochs", type=int, default=3)

    args = ap.parse_args(argv)
    if args.cmd == "bootstrap":
        files = sorted(glob.glob(os.path.join(args.transcripts, "*.json")))
        rows = bootstrap_dataset(files, Config())
        with open(args.out, "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
        pos = sum(r["label"] for r in rows)
        print(f"wrote {len(rows)} pairs ({pos} pos / {len(rows) - pos} neg) -> {args.out}")
    elif args.cmd == "train":
        train_model(args.data, args.out, args.base, args.epochs)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
