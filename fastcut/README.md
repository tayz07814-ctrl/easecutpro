# Fast Cut — Retake & Repetition Detection Engine

A hybrid **heuristic + ML** engine that detects retakes, repetitions, false
starts, and partial restarts in a word-level transcript and emits accurate cut
timestamps. Built to replace LLM-based detection (no GPT/Claude in the loop) and
to run locally on a GPU (tested target: RTX 4060 Ti, 16 GB).

It powers the **Fast Cut** button in EaseCutPro (next to Smart Cut, which stays
as the web-API fallback).

---

## Why this design

LLMs miscount over repeat-heavy word lists and are opaque to tune. This engine is
**transparent** (every cut has a per-feature score breakdown) and **tiered** so it
degrades gracefully:

| Tier | Deps | Runs on Python 3.14? | Adds |
|------|------|:---:|------|
| **Core** — windows + features + weighted scoring + detection | `numpy`, `rapidfuzz` | ✅ | the whole Fast Cut button, deterministic, ~0.3 s startup |
| **Semantic** — MiniLM sentence embeddings | `torch`, `sentence-transformers` | ❌ (needs 3.12) | paraphrase/retake understanding |
| **Audio** — wav2vec2 segment similarity | `torch`, `torchaudio` | ❌ (needs 3.12) | acoustic corroboration |
| **Classifier** — trained MiniLM/DistilBERT | `torch`, `transformers` | ❌ (needs 3.12) | a learned final decision (hybrid) |

If a tier's deps/inputs are missing it is skipped automatically — the engine
always returns an answer. `meta` in the response tells you which tiers ran.

> **PyTorch has no Python 3.14 wheels.** The core runs on 3.14 today; the GPU
> tiers need a 3.12 venv (`setup_ml.ps1`).

---

## Architecture (the 8 pieces)

```
words ─► windows.py ─► features.py ─► scoring.py ─► detect.py ─► hybrid.py ─► cuts
            (1)            (2)            (3)           (4)          (8)
                            ▲              ▲             ▲             ▲
                   semantic.py      (weights)   extend_cuts_back  classifier.py (7)
                   audio.py (6)                 (chained restarts)
```

1. **Phrase Window Builder** (`windows.py`) — overlapping windows, sizes 3–8.
2. **Feature Extraction** (`features.py`) — for each candidate pair:
   text similarity (token `SequenceMatcher` **and** char `Levenshtein` **and**
   optional MiniLM cosine), prefix overlap, **tail divergence** (prefix-aware:
   `power→powerful` is a fragment, `strengthen→restore` is not), earlier-attempt
   completeness, correction markers, timing gap, duration ratio, speech-rate
   change, confidence stats, optional audio cosine.
3. **Scoring Engine** (`scoring.py`) — a transparent logistic over weighted
   features. The key term is **corroboration**: a shared *opening* only counts
   when the *continuation* also matches or the earlier attempt was abandoned.
   That single idea kills the classic over-cut (two distinct points that start
   the same way). `explain()` returns the per-term breakdown.
4. **Detection Logic** (`detect.py`) — lookback restart search, type
   classification (`repetition` / `false_start` / `partial_restart` / `retake`),
   a **prefix-anchor requirement** (rejects misaligned floating matches),
   greedy non-overlapping resolution, and **backward extension** for chained
   restarts (keeps only the last take).
5. **Output** — clean JSON: `[{ "cut_start", "cut_end", "confidence" }]`.
6. **Audio similarity** (`audio.py`) — optional wav2vec2 tier.
7. **Mini ML model** (`classifier.py` + `train.py`) — sentence-pair MiniLM/
   DistilBERT, `text_a [SEP] text_b → P(retake)`, with a weak-supervision
   bootstrap so you can train without hand-labeling.
8. **Hybrid Decision** (`hybrid.py`) — `final = α·heuristic + (1-α)·classifier`,
   one tunable `accept_threshold`.

---

## Install & run

### Core (works now, Python 3.14)
```bash
python -m venv fastcut/.venv
fastcut/.venv/Scripts/python -m pip install -r fastcut/requirements-core.txt

# detect (stdin JSON -> stdout JSON)
echo '[{"word":"hi","start":0,"end":0.2}]' | fastcut/.venv/Scripts/python -m fastcut.cli
fastcut/.venv/Scripts/python -m fastcut.cli --in words.json --verbose
```

### GPU tiers (Python 3.12)
```powershell
powershell -ExecutionPolicy Bypass -File fastcut\setup_ml.ps1
# warm sidecar (models load once):
fastcut\.venv-ml\Scripts\python -m fastcut.server     # 127.0.0.1:8799
```

### Input / output
Input — a list of words (`word` or `text`; `conf` optional, defaults 1.0):
```json
[{"word":"I","start":0.10,"end":0.20,"conf":0.98}, ...]
```
Output:
```json
{"cuts":[{"cut_start":12.4,"cut_end":14.1,"confidence":0.87}], "meta":{...}}
```

---

## Tuning

All knobs live in `config.py`. Most useful:

- `accept_threshold` (0.60) — raise to cut less (more conservative), lower to cut
  more. This is the main aggressiveness dial.
- `weights.*` — per-feature weights, each documented inline.
- `markers` — correction phrases that signal an intentional redo.

Pass overrides per call via the `config` field of the JSON payload, or
`Config.from_dict(...)`.

---

## Training the classifier (optional)

```bash
# 1) weak-label a dataset from your real transcripts (no manual labeling)
python -m fastcut.train bootstrap --transcripts ./transcripts --out data.jsonl
# 2) fine-tune MiniLM (GPU auto-detected, fp16 on the 4060 Ti)
python -m fastcut.train train --data data.jsonl --out ./models/retake-minilm
# 3) enable it:  Config(use_classifier=True, classifier_path="./models/retake-minilm")
# 4) (bonus) export ONNX for fast, torch-free inference
python -m fastcut.onnx_export --model ./models/retake-minilm --out ./models/retake.onnx
```

Dataset format: JSONL `{"text_a","text_b","label"}` (1 = retake).

---

## Performance notes

- **Batch (default):** process the whole transcript at once. The semantic tier is
  gated behind a cheap lexical prefilter so embeddings only fire on plausible
  pairs; the classifier scores all candidate pairs in one batched GPU call.
- **Real-time:** the core is fast enough to run per-sentence as ASR streams in —
  call `run()` on a sliding tail of the last ~40 words after each finalized
  sentence, and only commit cuts that fall fully inside already-finalized words.
  Keep the GPU tiers in batch mode (warm sidecar) to avoid per-chunk model
  thrash.
- **ONNX:** `onnxruntime-gpu` removes torch from the inference path and is ~2–4×
  faster for the classifier; export once with `onnx_export.py`.

## Improving accuracy further

- Use real **Parakeet confidence** (`conf`) — the engine already weights
  low-confidence earlier takes; good confidences sharpen false-start detection.
- Turn on the **audio tier** for clips where the ASR text is unreliable.
- **Hand-correct** a few hundred bootstrapped pairs and retrain — biggest single
  win, since the heuristic's silver labels carry its blind spots.
- Add **speaker-diarization** features for interview footage (a "repeat" across a
  speaker change is usually not a retake).
- Calibrate `accept_threshold` per creator with a tiny labeled holdout
  (precision/recall tradeoff is explicit here, unlike an LLM).
