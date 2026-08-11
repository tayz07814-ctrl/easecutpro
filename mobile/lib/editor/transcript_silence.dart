import '../cloud/stt.dart' show Word;

/// TRANSCRIPT SILENCE ENGINE — the alternative to Silero.
///
/// One rule: KEEP the word timestamps, CUT everything else. A 15s clip whose
/// words span 3–7s and 9–12s loses 0–3, 7–9 and 12–15. No audio analysis, no
/// model — the transcript IS the truth, so it can never crash and never needs
/// the ONNX runtime.
///
/// Three knobs (App settings → Silence engine):
///   • padS       — silence KEPT either side of every speech span, so onsets and
///                  tails breathe instead of landing hard on the first phoneme.
///   • minSpeechS — a kept island shorter than this is a stray stamp, not
///                  speech; it is dropped so a mis-timed word can't leave a
///                  100ms fragment spliced into the edit.
///   • cross-fade — applied at export (seam blend), not here: this module only
///                  decides WHERE the cuts land.
///
/// Pure + synchronous, so it is trivially testable and instant on any clip.
class TranscriptSilence {
  /// Kept SOURCE ranges (ms) for [words], over a clip of [durS] seconds.
  ///
  /// Padded spans that touch or overlap are merged, so a normal sentence stays
  /// one continuous take rather than being chopped between every word.
  static List<List<int>> keepRanges(
    List<Word> words,
    double durS, {
    required double padS,
    required double minSpeechS,
  }) {
    final durMs = (durS * 1000).round();
    if (durMs <= 0) return const [];
    final padMs = (padS * 1000).round().clamp(0, 5000);

    // 1. word spans -> padded, clamped, in order.
    final spans = <List<int>>[];
    for (final w in words) {
      final a = ((w.start * 1000).round() - padMs).clamp(0, durMs);
      final b = ((w.end * 1000).round() + padMs).clamp(0, durMs);
      if (b > a) spans.add([a, b]);
    }
    if (spans.isEmpty) return const [];
    spans.sort((x, y) => x[0].compareTo(y[0]));

    // 2. merge anything that now touches or overlaps.
    final merged = <List<int>>[];
    for (final s in spans) {
      final last = merged.isEmpty ? null : merged.last;
      if (last != null && s[0] <= last[1]) {
        if (s[1] > last[1]) last[1] = s[1];
      } else {
        merged.add([s[0], s[1]]);
      }
    }

    // 3. drop islands too short to be real speech (measured on the SPOKEN span,
    //    i.e. before padding, so the pad can't inflate a stray stamp past the
    //    threshold and keep it).
    final minSpokenMs = (minSpeechS * 1000).round();
    final kept = <List<int>>[];
    for (final m in merged) {
      final spokenMs = (m[1] - m[0]) - 2 * padMs;
      if (spokenMs >= minSpokenMs) kept.add(m);
    }
    // Everything was below the threshold — keep the longest rather than wipe the
    // timeline to nothing (applyKeepRanges would refuse an empty list anyway).
    if (kept.isEmpty && merged.isNotEmpty) {
      merged.sort((x, y) => (y[1] - y[0]).compareTo(x[1] - x[0]));
      kept.add(merged.first);
      kept.sort((x, y) => x[0].compareTo(y[0]));
    }
    return kept;
  }

  /// The removed complement of [keepRanges] — what a cut takes out (source ms).
  static List<List<int>> cutRanges(
    List<Word> words,
    double durS, {
    required double padS,
    required double minSpeechS,
  }) {
    final durMs = (durS * 1000).round();
    final keeps = keepRanges(words, durS, padS: padS, minSpeechS: minSpeechS);
    final out = <List<int>>[];
    var cursor = 0;
    for (final k in keeps) {
      if (k[0] > cursor) out.add([cursor, k[0]]);
      cursor = k[1] > cursor ? k[1] : cursor;
    }
    if (durMs > cursor) out.add([cursor, durMs]);
    return out.where((r) => r[1] - r[0] > 10).toList();
  }
}
