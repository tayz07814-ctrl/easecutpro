import 'package:flutter/services.dart';

/// Bridge to the native two-pass silence engine (see SilenceEngine.kt): pass 1
/// protects the kept transcript words (timestamps), pass 2 protects real sound the
/// transcript missed (adaptive RMS energy) — everything else becomes a cut. Runs
/// in its own OS process so a native decoder fault can never crash the app.
/// ("Vad" in the names is legacy — the FSMN VAD/ONNX engine was removed to cut
/// APK size after it proved crashy on some devices.)
///
/// Returns silence regions [startS, endS] (seconds) to REMOVE, or an empty list on
/// any failure so the caller can fall back to transcript word-gap silence.
class NativeVad {
  static const MethodChannel _m = MethodChannel('ec/vad');

  static Future<List<List<double>>> detectSilences(
    String uri, {
    /// KEPT transcript words (after the AI's word cuts) as flattened
    /// [startS, endS, startS, endS, …] pairs — these spans are protected.
    required List<double> wordsS,

    /// Gaps shorter than this are left alone.
    double minSilenceS = 0.3,

    /// Air kept at a cut's start — right after the preceding speech ends.
    double padLeftS = 0.12,

    /// Lead kept at a cut's end — just before the next speech starts.
    double padRightS = 0.1,

    /// Energy-verified shrink into word spans (eats ASR-padded word tails; half
    /// of it may trim word starts). 0 = timestamps are inviolable.
    double trimEdgeS = 0.0,

    /// Treat non-word energy islands under 400 ms (breaths, lip smacks) as silence.
    bool removeBreaths = false,

    /// dB above the clip's measured noise floor that counts as sound.
    double sensitivityDb = 10.0,
  }) async {
    try {
      final res = await _m.invokeMethod<List<dynamic>>('detectSilences', {
        'uri': uri,
        'wordsS': wordsS,
        'minSilenceS': minSilenceS,
        'padLeftS': padLeftS,
        'padRightS': padRightS,
        'trimEdgeS': trimEdgeS,
        'removeBreaths': removeBreaths,
        'sensitivityDb': sensitivityDb,
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
