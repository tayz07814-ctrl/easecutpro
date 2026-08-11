import 'package:shared_preferences/shared_preferences.dart';

/// Which speech-to-text provider transcribes the audio.
enum SttProvider { auto, assemblyai, deepgram }

/// Which engine decides what counts as silence.
enum SilenceEngineKind {
  /// Silero VAD listens to the audio (the web app's engine).
  silero,

  /// Transcript-based: keep the word timestamps, cut everything else.
  transcript,
}

/// App-level preferences that outlive a project — persisted in SharedPreferences
/// and loaded once at startup, so the values are plain synchronous statics
/// everywhere they're read.
class AppSettings {
  // ---- transcription ------------------------------------------------------
  static SttProvider sttProvider = SttProvider.auto;

  // ---- silence engine -----------------------------------------------------
  static SilenceEngineKind silenceEngine = SilenceEngineKind.silero;

  /// TRANSCRIPT ENGINE — a kept speech island shorter than this is dropped as a
  /// stray stamp rather than kept as a fragment (seconds).
  static double minSpeechS = 0.20;

  /// TRANSCRIPT ENGINE — silence kept on BOTH sides of every speech span, so
  /// onsets and tails breathe instead of being clipped (ms).
  static int transcriptPadMs = 120;

  /// Audio cross-fade applied across every cut seam on export (ms, 0 = hard
  /// cut). Shared by both engines.
  static int crossFadeMs = 8;

  static const _kStt = 'ec.sttProvider';
  static const _kEngine = 'ec.silenceEngine';
  static const _kMinSpeech = 'ec.minSpeechS';
  static const _kPad = 'ec.transcriptPadMs';
  static const _kFade = 'ec.crossFadeMs';

  static Future<void> load() async {
    try {
      final p = await SharedPreferences.getInstance();
      final stt = p.getString(_kStt);
      if (stt != null) {
        sttProvider = SttProvider.values.firstWhere(
          (v) => v.name == stt,
          orElse: () => SttProvider.auto,
        );
      }
      final eng = p.getString(_kEngine);
      if (eng != null) {
        silenceEngine = SilenceEngineKind.values.firstWhere(
          (v) => v.name == eng,
          orElse: () => SilenceEngineKind.silero,
        );
      }
      minSpeechS = (p.getDouble(_kMinSpeech) ?? minSpeechS).clamp(0.0, 2.0);
      transcriptPadMs = (p.getInt(_kPad) ?? transcriptPadMs).clamp(0, 1000);
      crossFadeMs = (p.getInt(_kFade) ?? crossFadeMs).clamp(0, 120);
    } catch (_) {
      // defaults are already correct — a failed read must never block startup
    }
  }

  static Future<void> save() async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setString(_kStt, sttProvider.name);
      await p.setString(_kEngine, silenceEngine.name);
      await p.setDouble(_kMinSpeech, minSpeechS);
      await p.setInt(_kPad, transcriptPadMs);
      await p.setInt(_kFade, crossFadeMs);
    } catch (_) {}
  }

  static String get sttLabel => switch (sttProvider) {
        SttProvider.auto => 'Automatic',
        SttProvider.assemblyai => 'AssemblyAI',
        SttProvider.deepgram => 'Deepgram',
      };

  static String get engineLabel =>
      silenceEngine == SilenceEngineKind.silero ? 'Silero VAD' : 'Transcript';
}
