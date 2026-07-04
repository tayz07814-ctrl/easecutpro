"""
Audio similarity tier (optional) — design step 6.

Embeds two time-segments of the source audio with wav2vec2 and returns their
cosine similarity. Same WORDS spoken in two takes still differ acoustically a
little, but a real retake is far more acoustically similar than two unrelated
spans — so a high audio_sim is strong corroboration that a textual match is a
genuine repeat (and helps when the ASR text is noisy).

Fully optional & lazy: requires torch + torchaudio + transformers and an audio
file. `AudioEmbedder.try_load` returns None if anything is missing.

GPU note: runs on the RTX 4060 Ti automatically when CUDA is available.
"""

from __future__ import annotations

from typing import Optional

import numpy as np


class AudioEmbedder:
    def __init__(self, model_name: str, audio_path: str, device: str = "auto"):
        import torch
        import torchaudio
        from transformers import Wav2Vec2Model, Wav2Vec2FeatureExtractor

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "cpu"
        self.device = device
        self.torch = torch

        wav, sr = torchaudio.load(audio_path)        # (channels, samples)
        if wav.shape[0] > 1:                          # downmix to mono
            wav = wav.mean(dim=0, keepdim=True)
        if sr != 16000:                               # wav2vec2 expects 16 kHz
            wav = torchaudio.functional.resample(wav, sr, 16000)
            sr = 16000
        self.sr = sr
        self.wav = wav.squeeze(0)                      # (samples,)

        self.fe = Wav2Vec2FeatureExtractor.from_pretrained(model_name)
        self.model = Wav2Vec2Model.from_pretrained(model_name).to(device).eval()
        self._cache: dict[tuple[int, int], np.ndarray] = {}

    @classmethod
    def try_load(cls, model_name: str, audio_path: str, device: str = "auto") -> Optional["AudioEmbedder"]:
        try:
            return cls(model_name, audio_path, device)
        except Exception:
            return None

    def _embed(self, start: float, end: float) -> Optional[np.ndarray]:
        a = max(0, int(start * self.sr))
        b = min(self.wav.shape[0], int(end * self.sr))
        if b - a < int(0.05 * self.sr):               # < 50 ms => unusable
            return None
        key = (a, b)
        if key in self._cache:
            return self._cache[key]
        seg = self.wav[a:b]
        inputs = self.fe(seg.numpy(), sampling_rate=self.sr, return_tensors="pt")
        with self.torch.no_grad():
            out = self.model(inputs.input_values.to(self.device))
        # mean-pool the frame-level hidden states into one segment embedding
        vec = out.last_hidden_state.mean(dim=1).squeeze(0).cpu().numpy()
        n = np.linalg.norm(vec) + 1e-8
        vec = vec / n
        self._cache[key] = vec
        return vec

    def segment_similarity(self, s_a: float, e_a: float, s_b: float, e_b: float) -> float:
        va = self._embed(s_a, e_a)
        vb = self._embed(s_b, e_b)
        if va is None or vb is None:
            return 0.0
        return float(np.clip(np.dot(va, vb), 0.0, 1.0))
