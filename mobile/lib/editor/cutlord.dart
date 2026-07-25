import 'dart:math' as math;

import '../cloud/edge.dart';
import '../cloud/stt.dart';
import '../native/exporter.dart';
import 'cutcutpro.dart';

/// A Cut Lord model choice → which edge function + LLM to use.
class CutLordModel {
  final String label;
  final String slug; // 'ultracut-judge' | 'procut-judge'
  final String? model; // null for procut-judge (Claude)
  final String? reasoning;
  const CutLordModel(this.label, this.slug, this.model, this.reasoning);
}

const cutLordRetake = CutLordModel('Retake Beta', 'ultracut-judge', 'google/gemini-3.6-flash', 'low');
const cutLordUltra = CutLordModel('Ultracut Beta', 'ultracut-judge', 'deepseek-v4-flash', 'medium');
const cutLordPremium = CutLordModel('Premium Cut', 'procut-judge', null, null);

/// Extract the clip's audio and transcribe it (AssemblyAI → Deepgram).
Future<List<Word>> extractAndTranscribe(
  NativeExporter exporter,
  String videoPath, {
  Progress? onProgress,
}) async {
  onProgress?.call(4, 'Getting your audio…');
  final audio = await exporter.extractAudio('file://$videoPath');
  return transcribe(audio, onProgress: onProgress);
}

class CutLordResult {
  final List<List<int>> keeps; // kept source ranges (ms)
  final List<List<int>> wordCuts; // inclusive word-index cut ranges (for review)
  final double savedS;
  final int segments;
  CutLordResult(this.keeps, this.wordCuts, this.savedS, this.segments);
}

/// Send the transcript to the judge edge function → word cuts (NOT yet applied,
/// so the caller can show a review pass) plus a preview keep-range/saved estimate.
Future<CutLordResult> judge(
  List<Word> words,
  CutLordModel model,
  double durS, {
  bool cutSilence = true,
  double minPauseS = 0.5,
  double padS = 0.1,
  Progress? onProgress,
}) async {
  onProgress?.call(66, 'Finding cuts…');
  final payload = buildPayload(words);
  final req = <String, dynamic>{
    'payload': payload,
    'proposal': {'word_cuts': [], 'pause_cuts': []},
  };
  if (model.model != null) {
    req['model'] = model.model;
    req['promptVariant'] = 'sharp';
    req['reasoning'] = model.reasoning ?? 'off';
  }
  final res = await invokeEdge(model.slug, req);
  final wordCuts = parseWordCuts(res['raw'] as String?, words.length);
  onProgress?.call(92, 'Applying cuts…');
  final keeps = keepRanges(words, wordCuts, durS,
      cutSilence: cutSilence, minPauseS: minPauseS, padS: padS);
  final keptMs = keeps.fold<int>(0, (a, k) => a + (k[1] - k[0]));
  return CutLordResult(keeps, wordCuts, math.max(0.0, durS - keptMs / 1000.0), keeps.length);
}
