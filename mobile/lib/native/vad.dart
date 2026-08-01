import 'package:flutter/services.dart';

/// Native FSMN (FunASR) VAD bridge — the Retake Final Boss silence engine run
/// on-device via ONNX (see EcVad.kt). Returns silence regions [startS, endS]
/// (seconds) to REMOVE, or an empty list on any failure so the caller can fall
/// back to transcript word-gap silence. The audio never leaves the phone.
class NativeVad {
  static const MethodChannel _m = MethodChannel('ec/vad');

  static Future<List<List<double>>> detectSilences(
    String uri, {
    double padBeforeS = 0.18,
    double padAfterS = 0.12,
    double trimEdgesS = 0.02,
    bool tailTrim = false,
  }) async {
    try {
      final res = await _m.invokeMethod<List<dynamic>>('detectSilences', {
        'uri': uri,
        'padBeforeS': padBeforeS,
        'padAfterS': padAfterS,
        'trimEdgesS': trimEdgesS,
        'tailTrim': tailTrim,
      });
      if (res == null) return const [];
      return [
        for (final r in res)
          [for (final x in (r as List)) (x as num).toDouble()],
      ];
    } catch (_) {
      return const [];
    }
  }
}
