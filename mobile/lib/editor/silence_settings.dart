/// Silence Mastery settings — a 1:1 mirror of main's shared/silenceMastery.ts
/// (SilenceMasterySettings + SILENCE_MASTERY_PRESETS). The engine is Silero-only,
/// exactly like the web app: the VAD's fixed tuning (threshold 0.55 etc.) lives
/// in the native engine; these values shape the cuts it finds.
class SilenceSettings {
  /// Gaps shorter than this many seconds are natural beats — kept.
  static double minSilenceS = 0.15;

  /// Silence KEPT on a removed gap's left edge (after the sentence ending), ms.
  static int padLeftMs = 0;

  /// Silence KEPT on the right edge (before the next sentence), ms.
  static int padRightMs = 0;

  /// Cut extended LEFT into the sentence ENDING beyond the detected edge, ms.
  static int trimLeftMs = 30;

  /// Cut extended RIGHT into the next sentence's ONSET, ms.
  static int trimRightMs = 10;

  /// Breath cleanup (RMS edge refinement) at sentence endings — on for the
  /// aggressive presets (Flash, Cut Throat), off for the gentle two.
  static bool breathRefine = true;

  /// "Mad Scientist" lever (UI-only): ON unlocks the sliders for hand-tuning.
  static bool madScientist = false;

  /// Blend audio across a cut on export (0 = hard cut) — mobile-only extra.
  static int seamOverlapMs = 0;

  /// Cut Lord's "also clean silence" toggle.
  static bool cutSilence = true;

  /// Review-before-apply. FALSE (default) stages the cuts on the timeline for
  /// inspection; TRUE commits them the moment they are found.
  static bool autoApplyCuts = false;

  // ---- Back-compat aliases: the transcript word-gap FALLBACK (used only when
  // the native engine fails) and Cut Lord's judge still consume the old names.
  static double get minGapS => minSilenceS;
  static double get trimS => minSilenceS;
  static double get keepS => padLeftMs / 1000.0;
  static double get padBeforeS => padRightMs / 1000.0; // lead kept before the next word
  static double get padAfterS => padLeftMs / 1000.0; // air kept after the last word

  /// Apply a named preset (values copied verbatim from SILENCE_MASTERY_PRESETS).
  static void applyPreset(String id) {
    switch (id) {
      case 'natural-rhythm':
        minSilenceS = 0.25;
        padLeftMs = 50;
        padRightMs = 100;
        trimLeftMs = 0;
        trimRightMs = 0;
        breathRefine = false;
        break;
      case 'no-chill':
        minSilenceS = 0.15;
        padLeftMs = 0;
        padRightMs = 0;
        trimLeftMs = 20;
        trimRightMs = 50;
        breathRefine = false;
        break;
      case 'cut-throat':
        minSilenceS = 0.15;
        padLeftMs = 0;
        padRightMs = 0;
        trimLeftMs = 75;
        trimRightMs = 15;
        breathRefine = true;
        break;
      case 'flash': // THE DEFAULT
      default:
        minSilenceS = 0.15;
        padLeftMs = 0;
        padRightMs = 0;
        trimLeftMs = 30;
        trimRightMs = 10;
        breathRefine = true;
    }
  }

  /// Which preset the current values exactly match, or null (custom) —
  /// mirrors matchSilenceMasteryPreset.
  static String? detectPreset() {
    bool eq(double a, double b) => (a - b).abs() < 1e-9;
    if (eq(minSilenceS, 0.25) && padLeftMs == 50 && padRightMs == 100 && trimLeftMs == 0 && trimRightMs == 0 && !breathRefine) {
      return 'natural-rhythm';
    }
    if (eq(minSilenceS, 0.15) && padLeftMs == 0 && padRightMs == 0 && trimLeftMs == 20 && trimRightMs == 50 && !breathRefine) {
      return 'no-chill';
    }
    if (eq(minSilenceS, 0.15) && padLeftMs == 0 && padRightMs == 0 && trimLeftMs == 30 && trimRightMs == 10 && breathRefine) {
      return 'flash';
    }
    if (eq(minSilenceS, 0.15) && padLeftMs == 0 && padRightMs == 0 && trimLeftMs == 75 && trimRightMs == 15 && breathRefine) {
      return 'cut-throat';
    }
    return null;
  }
}
