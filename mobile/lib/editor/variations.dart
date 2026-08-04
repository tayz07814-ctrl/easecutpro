// Variations — cut the source into segments and rejoin them in a chosen order.
//
// A Dart port of the web engine (shared/variations.ts + shared/aiVariations.ts +
// cloud/variationEngine.ts) so the phone accepts the SAME JSON contract and gets
// the SAME AI arrangements as the desktop web app.
//
// The array ORDER is the edit: ranges may be out of order, may repeat and may
// overlap. A 60s source with [[5,8],[1,3],[15,25],[55,60]] becomes a 21s edit
// whose second clip is earlier in the source than its first. Nothing here ever
// sorts or merges — that would quietly destroy the feature.

import 'dart:convert';

import '../cloud/edge.dart';
import '../cloud/stt.dart';

/// One segment of the source, in SECONDS.
class VariationClip {
  final double start;
  final double end;
  final String? name; // creator/role label, shown in the panel
  const VariationClip(this.start, this.end, {this.name});
}

class Variation {
  final String? name;
  final List<VariationClip> clips;
  const Variation(this.name, this.clips);

  /// Total runtime of the arrangement, in seconds.
  double get durationS =>
      clips.fold(0.0, (n, c) => n + (c.end - c.start > 0 ? c.end - c.start : 0.0));

  /// Source ranges in ms, ready for `TimelineModel.applyKeepRanges`.
  List<List<int>> rangesMs() =>
      [for (final c in clips) [(c.start * 1000).round(), (c.end * 1000).round()]];
}

class VariationParse {
  final List<Variation> variations;
  final String? error; // fatal — nothing can be applied
  final List<String> warnings; // non-fatal notes (dropped/clamped entries)
  const VariationParse(this.variations, {this.error, this.warnings = const []});
}

/// The example shown in the panel's empty state and copied by "Copy example".
const variationExample = '''{
  "name": "Hook first",
  "clips": [
    { "start": 5,  "end": 8,  "name": "Hook" },
    { "start": 1,  "end": 3,  "name": "Intro" },
    { "start": 15, "end": 25, "name": "Main point" },
    { "start": 55, "end": 60, "name": "CTA" }
  ]
}''';

double? _readTime(Map row, List<String> keys) {
  for (final k in keys) {
    final v = row[k];
    if (v is num) return v.toDouble();
    if (v is String && v.trim().isNotEmpty) {
      final n = double.tryParse(v.trim());
      if (n != null) return n;
    }
  }
  return null;
}

VariationClip? _coerceClip(dynamic raw, int index, List<String> warnings) {
  // [start, end] tuple
  if (raw is List) {
    final a = raw.isNotEmpty ? raw[0] : null;
    final b = raw.length > 1 ? raw[1] : null;
    final start = a is num ? a.toDouble() : double.tryParse('$a');
    final end = b is num ? b.toDouble() : double.tryParse('$b');
    if (start == null || end == null) {
      warnings.add('clip ${index + 1}: expected [start, end] numbers — skipped');
      return null;
    }
    return VariationClip(start, end);
  }
  if (raw is! Map) {
    warnings.add('clip ${index + 1}: not an object or [start, end] pair — skipped');
    return null;
  }
  final start = _readTime(raw, ['start', 'from', 'in', 's', 'startS', 'start_s']);
  var end = _readTime(raw, ['end', 'to', 'out', 'e', 'endS', 'end_s']);
  if (end == null) {
    final dur = _readTime(raw, ['duration', 'length', 'dur']);
    if (start != null && dur != null) end = start + dur;
  }
  if (start == null || end == null) {
    warnings.add('clip ${index + 1}: missing start/end — skipped');
    return null;
  }
  final name = raw['name'] is String
      ? raw['name'] as String
      : (raw['label'] is String ? raw['label'] as String : null);
  return VariationClip(start, end, name: name);
}

/// Parse + validate a hand-written variation file against the source duration.
///
/// Ranges past the end are CLAMPED (not dropped) so `[55, 60]` against a 59.8s
/// file still gets the tail. Reversed pairs are swapped — the intent is
/// unambiguous. Zero-length ranges are dropped. Order, repeats and overlaps are
/// preserved verbatim.
VariationParse parseVariation(String text, double durationS, {String? fallbackName}) {
  final warnings = <String>[];
  dynamic data;
  try {
    data = jsonDecode(text);
  } catch (e) {
    return VariationParse(const [], error: 'That file isn’t valid JSON ($e)', warnings: warnings);
  }

  List? rows;
  String? name;
  if (data is List) {
    rows = data;
  } else if (data is Map) {
    final list = data['clips'] ?? data['segments'] ?? data['variations'] ?? data['ranges'];
    if (list is List) rows = list;
    if (data['name'] is String) name = data['name'] as String;
  }
  if (rows == null) {
    return VariationParse(const [],
        error: 'Expected a list of clips — either a top-level array, or an object with a "clips" array.',
        warnings: warnings);
  }
  if (rows.isEmpty) {
    return VariationParse(const [], error: 'That file has no clips in it.', warnings: warnings);
  }

  final clips = <VariationClip>[];
  for (var i = 0; i < rows.length; i++) {
    final c = _coerceClip(rows[i], i, warnings);
    if (c == null) continue;
    var start = c.start;
    var end = c.end;
    if (start > end) {
      warnings.add('clip ${i + 1}: start was after end — swapped');
      final t = start;
      start = end;
      end = t;
    }
    if (start < 0) {
      warnings.add('clip ${i + 1}: started before 0 — clamped');
      start = 0;
    }
    if (durationS > 0 && end > durationS) {
      warnings.add('clip ${i + 1}: ran past the end of the video — clamped to ${durationS.toStringAsFixed(2)}s');
      end = durationS;
    }
    if (durationS > 0 && start >= durationS) {
      warnings.add('clip ${i + 1}: starts past the end of the video — skipped');
      continue;
    }
    if (end - start < 0.01) {
      warnings.add('clip ${i + 1}: shorter than 10ms — skipped');
      continue;
    }
    clips.add(VariationClip(start, end, name: c.name));
  }

  if (clips.isEmpty) {
    return VariationParse(const [], error: 'None of the clips in that file were usable.', warnings: warnings);
  }
  return VariationParse([Variation(name ?? fallbackName, clips)], warnings: warnings);
}

// ---- AI variations (ultracut-judge on its `variations` prompt) ----

const _roleLabel = <String, String>{
  'hook': 'Hook',
  'intro': 'Intro',
  'problem': 'Problem',
  'selling': 'Selling point',
  'cta': 'CTA',
};

/// The complete user message: index-anchored words and nothing else. No timings,
/// so the model cannot anchor on (or fabricate) them.
String buildVariationPayload(List<Word> words, double durationS, int count) {
  final lines = [for (var i = 0; i < words.length; i++) '$i|${words[i].text}'].join('\n');
  return 'SOURCE: ${durationS.toStringAsFixed(1)}s, ${words.length} words.\n'
      'PRODUCE: $count distinct variation${count == 1 ? '' : 's'}.\n\n'
      'VERBATIM TRANSCRIPT (immutable index|word):\n$lines';
}

/// Sentence-ending punctuation on the word itself.
final _endsSentence = RegExp(r'''[.!?…]["')\]]*\s*$''');

/// Snap a range out to whole sentences: a section that begins mid-clause reads as
/// a clipped-off fragment. Both walks are bounded, so a transcript with no
/// punctuation at all degrades to the model's original range.
(int, int) _snapToSentence(List<Word> words, int from, int to, {int maxWalk = 25}) {
  var a = from;
  for (var n = 0; n < maxWalk && a > 0; n++) {
    if (_endsSentence.hasMatch(words[a - 1].text.trim())) break;
    a--;
  }
  var b = to;
  for (var n = 0; n < maxWalk && b < words.length - 1; n++) {
    if (_endsSentence.hasMatch(words[b].text.trim())) break;
    b++;
  }
  return (a, b);
}

String _extractJson(String raw) {
  var t = raw.replaceAll(RegExp(r'<think>[\s\S]*?</think>', caseSensitive: false), '');
  t = t.replaceAll(RegExp(r'```(?:json)?', caseSensitive: false), '').replaceAll('```', '').trim();
  final m = RegExp(r'\{[\s\S]*\}').firstMatch(t);
  return (m != null ? m.group(0)! : t).trim();
}

/// Validate the model's reply and convert word INDICES to source seconds.
/// Deliberately unlike the retake validator: sections are never sorted and never
/// merged — array order is the edit, and repeats/overlaps are legitimate.
VariationParse validateAiVariations(String raw, List<Word> words, {bool snap = true}) {
  final warnings = <String>[];
  if (words.isEmpty) return VariationParse(const [], warnings: ['The transcript is empty.']);

  dynamic parsed;
  try {
    parsed = jsonDecode(_extractJson(raw));
  } catch (_) {
    return VariationParse(const [], warnings: ['The AI reply wasn’t valid JSON.']);
  }
  final rows = (parsed is Map && parsed['variations'] is List) ? parsed['variations'] as List : const [];
  if (rows.isEmpty) return VariationParse(const [], warnings: ['The AI returned no variations.']);

  final out = <Variation>[];
  for (var vi = 0; vi < rows.length; vi++) {
    final v = rows[vi];
    final sections = (v is Map && v['sections'] is List) ? v['sections'] as List : const [];
    final clips = <VariationClip>[];
    for (var si = 0; si < sections.length; si++) {
      final s = sections[si];
      if (s is! Map) continue;
      final rawFrom = s['from'], rawTo = s['to'];
      var from = (rawFrom is num) ? rawFrom.round() : int.tryParse('$rawFrom') ?? -1;
      var to = (rawTo is num) ? rawTo.round() : int.tryParse('$rawTo') ?? -1;
      if (from < 0 || to < 0) {
        warnings.add('variation ${vi + 1}, section ${si + 1}: no usable word range — skipped');
        continue;
      }
      if (from > to) {
        final t = from;
        from = to;
        to = t;
      }
      from = from.clamp(0, words.length - 1);
      to = to.clamp(0, words.length - 1);
      if (snap) {
        final r = _snapToSentence(words, from, to);
        from = r.$1;
        to = r.$2;
      }
      final start = words[from].start;
      final end = words[to].end;
      if (!(end > start)) {
        warnings.add('variation ${vi + 1}, section ${si + 1}: zero-length after snapping — skipped');
        continue;
      }
      final role = s['role'] is String ? (s['role'] as String).toLowerCase() : '';
      clips.add(VariationClip(start, end,
          name: _roleLabel[role] ?? (role.isNotEmpty ? role : 'Section ${si + 1}')));
    }
    if (clips.isEmpty) {
      warnings.add('variation ${vi + 1}: no usable sections — dropped');
      continue;
    }
    final vn = (v is Map && v['name'] is String && (v['name'] as String).trim().isNotEmpty)
        ? (v['name'] as String).trim()
        : 'Variation ${out.length + 1}';
    out.add(Variation(vn, clips));
  }
  if (out.isEmpty) warnings.add('None of the AI’s variations were usable.');
  return VariationParse(out, warnings: warnings);
}

/// Ask the judge to cast the transcript into [count] short-form arrangements.
/// Reuses `ultracut-judge` on its `variations` prompt — same engine, budget and
/// fallback model as the retake path; only the prompt and reply shape differ.
Future<VariationParse> generateVariations(
  List<Word> words,
  double durationS,
  int count, {
  void Function(String msg)? onProgress,
}) async {
  // Only real spoken words — blanks would shift every index the model returns.
  final clean = [for (final w in words) if (w.text.trim().isNotEmpty) w];
  if (clean.length < 20) {
    return const VariationParse([], warnings: ['This transcript is too short to build variations from.']);
  }
  onProgress?.call('Reading your transcript…');
  final payload = buildVariationPayload(clean, durationS, count);
  onProgress?.call('Casting $count variation${count == 1 ? '' : 's'}…');
  Map<String, dynamic> res;
  try {
    res = await invokeEdge('ultracut-judge', {
      'payload': payload,
      'proposal': {'word_cuts': [], 'pause_cuts': []},
      // Gemma 4 31B at reasoning 'medium', matching the web client.
      'model': 'google/gemma-4-31b-it',
      'promptVariant': 'variations',
      'reasoning': 'medium',
    });
  } catch (_) {
    return const VariationParse([], warnings: ['Couldn’t reach the AI — please try again.']);
  }
  final raw = res['raw'] as String?;
  if (raw == null || raw.isEmpty) {
    return const VariationParse([], warnings: ['The AI couldn’t analyse this transcript — please try again.']);
  }
  onProgress?.call('Checking the cuts…');
  final out = validateAiVariations(raw, clean);
  // The model is asked for an exact count; say so rather than silently under-
  // delivering, since the creator picked the number explicitly.
  if (out.variations.isNotEmpty && out.variations.length < count) {
    return VariationParse(out.variations, warnings: [
      ...out.warnings,
      'The AI returned ${out.variations.length} of $count — the transcript may not support more.',
    ]);
  }
  return out;
}
