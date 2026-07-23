/// Shared silence-detection settings, written by the Silence Settings modal and
/// read by Cut Lord when it computes keep-ranges. Simple process-global holder
/// (the editor is a single screen) — mirrors the web app's stable presets.
class SilenceSettings {
  static double trimS = 0.35; // trim pauses longer than this (minPauseS)
  static double keepS = 0.08; // pause left at each cut (padS)
  static bool cutSilence = true;

  static void apply({double? trimS, double? keepS, bool? cutSilence}) {
    if (trimS != null) SilenceSettings.trimS = trimS;
    if (keepS != null) SilenceSettings.keepS = keepS;
    if (cutSilence != null) SilenceSettings.cutSilence = cutSilence;
  }
}
