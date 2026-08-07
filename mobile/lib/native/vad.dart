import 'package:flutter/services.dart';

/// Bridge to the native Silence Mastery engine (SilenceEngine.kt) — the SAME
/// engine the web app on main runs: Silero VAD (threshold 0.55) finds silence
/// by listening to the audio; breath cleanup walks sentence-ending exhales;
/// pads/trims shape every cut edge. No transcript involvement. Runs in its own
/// OS process so a native fault can never crash the app.
///
/// The engine's reply: silence regions [startS, endS] (seconds) to REMOVE plus
/// a one-line diagnostic (probability bands / segment count / speech coverage)
/// so a surprising result explains itself right on the phone.
class SilenceResult {
  final List<List<double>> regions;
  final String stats;
  const SilenceResult(this.regions, this.stats);
}

class NativeVad {
  static const MethodChannel _m = MethodChannel('ec/vad');

  static Future<SilenceResult> detectSilences(
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
      final res = await _m.invokeMethod<Map<dynamic, dynamic>>('detectSilences', {
        'uri': uri,
        'minSilenceS': minSilenceS,
        'padLeftMs': padLeftMs,
        'padRightMs': padRightMs,
        'trimLeftMs': trimLeftMs,
        'trimRightMs': trimRightMs,
        'breathRefine': breathRefine,
      });
      if (res == null) return const SilenceResult([], '');
      final regions = [
        for (final r in (res['regions'] as List? ?? const []))
          [for (final x in (r as List)) (x as num).toDouble()],
      ];
      return SilenceResult(regions, (res['stats'] as String?) ?? '');
    } on PlatformException catch (e) {
      // Engine failures must be LOUD (the caller shows them) — never swallowed.
      throw Exception(e.message ?? 'silence engine failed');
    }
  }
}
