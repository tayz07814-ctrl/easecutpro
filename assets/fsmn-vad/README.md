# FunASR FSMN-VAD assets

These files come from [`funasr/fsmn-vad-onnx`](https://huggingface.co/funasr/fsmn-vad-onnx):

- `model_quant.onnx` — quantized FSMN-VAD model
- `vad.mvn` — model CMVN parameters

The model repository declares the assets under the Apache License 2.0. The
runtime implementation in this project follows FunASR's documented 16 kHz,
80-bin fbank, 5-frame LFR, CMVN, and FSMN-cache input contract.
