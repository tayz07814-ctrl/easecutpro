/// Silence-detection settings — mirrors web 0.01's VadSilenceSettings + presets
/// (Conservative / Balanced / Aggressive). Written by the Silence Settings modal,
/// read by Cut Lord when it computes keep-ranges. The on-device (VAD-free) cut
/// uses minGapS (pause threshold) and the pads; speechThreshold / removeBreaths /
/// edgeTrim are carried for parity with 0.01 (and future on-device VAD).
class SilenceSettings {
  static double speechThreshold = 0.75; // VAD strictness (parity)
  static double minGapS = 0.3; // trim pauses longer than this
  static double padBeforeS = 0.1; // lead kept before the next word at a cut
  static double padAfterS = 0.12; // air kept after the last word at a cut
  static double edgeTrimS = 0.0; // tighten joins to the word boundary (parity)
  static bool removeBreaths = false; // parity (needs on-device VAD)
  static int seamOverlapMs = 0; // blend audio across a cut (0 = hard cut)
  static bool cutSilence = true;

  // Back-compat aliases used by the cut-pipeline call sites.
  static double get trimS => minGapS;
  static double get keepS => padAfterS;

  /// Apply a named preset (values copied from web 0.01 SILENCE_PRESETS).
  static void applyPreset(String id) {
    switch (id) {
      case 'conservative':
        speechThreshold = 0.65;
        minGapS = 0.6;
        padBeforeS = 0.15;
        padAfterS = 0.2;
        edgeTrimS = 0.0;
        removeBreaths = false;
        break;
      case 'aggressive':
        speechThreshold = 0.75;
        minGapS = 0.05;
        padBeforeS = 0.0;
        padAfterS = 0.0;
        edgeTrimS = 0.05;
        removeBreaths = true;
        break;
      case 'balanced':
      default:
        speechThreshold = 0.75;
        minGapS = 0.3;
        padBeforeS = 0.1;
        padAfterS = 0.12;
        edgeTrimS = 0.0;
        removeBreaths = false;
    }
  }

  /// Which preset the current values match, or 'custom'.
  static String detectPreset() {
    bool eq(double a, double b) => (a - b).abs() < 1e-6;
    if (eq(speechThreshold, 0.65) && eq(minGapS, 0.6) && eq(padBeforeS, 0.15) && eq(padAfterS, 0.2) && eq(edgeTrimS, 0.0) && !removeBreaths) {
      return 'conservative';
    }
    if (eq(speechThreshold, 0.75) && eq(minGapS, 0.05) && eq(padBeforeS, 0.0) && eq(padAfterS, 0.0) && eq(edgeTrimS, 0.05) && removeBreaths) {
      return 'aggressive';
    }
    if (eq(speechThreshold, 0.75) && eq(minGapS, 0.3) && eq(padBeforeS, 0.1) && eq(padAfterS, 0.12) && eq(edgeTrimS, 0.0) && !removeBreaths) {
      return 'balanced';
    }
    return 'custom';
  }
}
