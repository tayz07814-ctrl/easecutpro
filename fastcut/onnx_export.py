"""
ONNX export (bonus) — turn the trained sentence-pair classifier into an ONNX
graph for fast, dependency-light inference (onnxruntime-gpu on the 4060 Ti, or
CPU on machines without torch).

USAGE:
    python -m fastcut.onnx_export --model ./models/retake-minilm --out ./models/retake.onnx

Then run it with onnxruntime (no torch needed at inference time):
    import onnxruntime as ort, numpy as np
    sess = ort.InferenceSession("retake.onnx", providers=["CUDAExecutionProvider","CPUExecutionProvider"])
    # feed input_ids / attention_mask from the same tokenizer; softmax(logits)[:,1] = P(retake)
"""

from __future__ import annotations

import argparse


def export(model_dir: str, out_path: str, max_len: int = 64, opset: int = 17):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(model_dir)
    model = AutoModelForSequenceClassification.from_pretrained(model_dir).eval()

    dummy = tok("hello world", "hello world there", return_tensors="pt",
                padding="max_length", truncation=True, max_length=max_len)
    inputs = (dummy["input_ids"], dummy["attention_mask"])

    torch.onnx.export(
        model, inputs, out_path,
        input_names=["input_ids", "attention_mask"],
        output_names=["logits"],
        dynamic_axes={
            "input_ids": {0: "batch", 1: "seq"},
            "attention_mask": {0: "batch", 1: "seq"},
            "logits": {0: "batch"},
        },
        opset_version=opset, do_constant_folding=True,
    )
    print(f"exported ONNX -> {out_path}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="fastcut.onnx_export")
    ap.add_argument("--model", required=True, help="trained classifier dir")
    ap.add_argument("--out", required=True, help="output .onnx path")
    ap.add_argument("--max-len", type=int, default=64)
    args = ap.parse_args(argv)
    export(args.model, args.out, args.max_len)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
