import 'package:flutter/services.dart';

/// Bridge to the native Silence Mastery engine (SilenceEngine.kt) — the SAME
/// engine the web app on main runs: Silero VAD (threshold 0.55) finds silence
/// by listening to the audio; breath cleanup walks sentence-ending exhales;
/// pads/trims shape every cut edge. No transcript involvement. Runs in its own
/// OS process so a native fault can never crash the app.
///
/// Returns silence regions [startS, endS] (seconds) to REMOVE, or an empty list
/// on any failure so the caller can fall back to transcript word-gap silence.
class NativeVad {
  static const MethodChannel _m = MethodChannel('ec/vad');

  static Future<List<List<double>>> detectSilences(
    String uri, {
    /// Gaps shorter than this many seconds are natural beats — kept.
    double minSilenceS = 0.15,

    /// Silence KEPT on a removed gap's left edge (right after the sentence
    /// ending that precedes it), ms.
    double padLeftMs = 0,

    /// Silence KEPT on the right edge (just before the next sentence), ms.
    double padRightMs = 0,

    /// Cut extended LEFT into the sentence ENDING beyond the detected edge, ms.
    double trimLeftMs = 30,

    /// Cut extended RIGHT into the next sentence's ONSET, ms.
    double trimRightMs = 10,

    /// Breath cleanup at sentence endings (RMS edge refinement) — walks each
    /// cut's left edge back over the exhale so it lands where the voice stops.
    bool breathRefine = true,
  }) async {
    try {
      final res = await _m.invokeMethod<List<dynamic>>('detectSilences', {
        'uri': uri,
        'minSilenceS': minSilenceS,
        'padLeftMs': padLeftMs,
        'padRightMs': padRightMs,
        'trimLeftMs': trimLeftMs,
        'trimRightMs': trimRightMs,
        'breathRefine': breathRefine,
      });
      if (res == null) return const [];
      return [
        for (final r in res)
          [for (final x in (r as List)) (x as num).toDouble()],
      ];
    } on PlatformException catch (e) {
      // Engine failures must be LOUD (the caller shows them) — never swallowed.
      throw Exception(e.message ?? 'silence engine failed');
    }
  }
}
