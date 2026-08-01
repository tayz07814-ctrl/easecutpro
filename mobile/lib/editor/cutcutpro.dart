import 'dart:convert';
import 'dart:math' as math;

import '../cloud/stt.dart';

/// Pure port of the essential shared/cutcutpro.ts + edit.ts logic (VAD-free):
/// words → AI payload → word-cut EDL → KEEP ranges, plus word-gap silence and
/// caption grouping. All the AI ever sees are word indices + pause ids.

// Single-word fillers tagged in the payload — the single-token subset of the web
// DEFAULT_FILLERS (shared/fillers.ts); multi-word phrases can't match a per-word norm.
const _fillers = {
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'ah', 'hmm', 'mm', 'mhm', 'eh',
  'like', 'basically', 'actually', 'literally', 'honestly',
};

String _norm(String s) => s.toLowerCase().replaceAll(RegExp(r"[^a-z0-9']"), '');

// A word that closes a sentence: sentence punctuation, optionally trailing quotes /
// brackets. Mirrors shared/cutcutpro.ts ENDS_SENTENCE.
final _endsSentence = RegExp(r'''[.!?…]["')\]]*$''');
final _trailingDash = RegExp(r'[-–—]$');

/// Deterministic signals the judge payload + refinement need — the portable subset
/// of shared/cutcutpro.ts buildTimestampMap (no VAD, no diarization on mobile).
class _JudgeMap {
  final Set<int> fillers; // word indices that are vocal fillers
  final Set<int> stutters; // immediate repeats / abandoned word fragments
  final List<int> incompleteEndWords; // last word of a clause abandoned before a long pause
  _JudgeMap(this.fillers, this.stutters, this.incompleteEndWords);
}

_JudgeMap _buildJudgeMap(List<Word> words) {
  final fillers = <int>{};
  for (int i = 0; i < words.length; i++) {
    if (_fillers.contains(_norm(words[i].text))) fillers.add(i);
  }

  // Stutters: immediate word repeats ("I I", "the the") and cut-off fragments
  // ("th-", "pow—" / "pow" → "powerful") where the next word completes them.
  final stutters = <int>{};
  for (int i = 0; i < words.length - 1; i++) {
    final a = _norm(words[i].text);
    final b = _norm(words[i + 1].text);
    if (a.isEmpty) continue;
    if (a == b && a.length <= 8) {
      stutters.add(i);
    } else if (_trailingDash.hasMatch(words[i].text.trim()) &&
        b.startsWith(a.substring(0, math.min(2, a.length)))) {
      stutters.add(i);
    } else if (a.length >= 2 && a.length < b.length && b.startsWith(a) && b.length - a.length >= 2) {
      stutters.add(i);
    }
  }

  // Incomplete sentences: a chunk ending WITHOUT sentence punctuation right before a
  // long pause (≥600 ms) — the speaker abandoned the thought. Pauses are word gaps.
  final incomplete = <int>[];
  for (int i = 0; i < words.length - 1; i++) {
    final gapMs = (words[i + 1].start - words[i].end) * 1000;
    if (gapMs < 600) continue;
    if (!_endsSentence.hasMatch(words[i].text.trim())) incomplete.add(i);
  }

  return _JudgeMap(fillers, stutters, incomplete);
}

/// Build the `payload` string sent to procut-judge — the mobile twin of
/// shared/cutcutpro.ts buildAiPayload: index|text lines with FILLER / STUTTER tags,
/// inter-word pauses (≥250 ms) marked between words, and an INCOMPLETE SENTENCES
/// section so the judge can dedupe retakes and drop abandoned false starts exactly
/// like the desktop web. (No VAD / diarization on mobile → single-speaker header,
/// no VAD-confirmed markers — the degraded-gracefully forms of the same payload.)
String buildPayload(List<Word> words) {
  final map = _buildJudgeMap(words);

  // Pause ids in order (a leading-air pause reserves p0 like the web, even though it
  // is not emitted inline); each inter-word gap ≥250 ms is marked after its word.
  final pauseId = <int, String>{};
  final pauseDurMs = <int, int>{};
  int pid = 0;
  if (words.isNotEmpty && words[0].start >= 0.4) pid++;
  for (int i = 0; i < words.length - 1; i++) {
    final gapMs = ((words[i + 1].start - words[i].end) * 1000).round();
    if (gapMs >= 250) {
      pauseId[i] = 'p$pid';
      pauseDurMs[i] = gapMs;
      pid++;
    }
  }

  final lines = <String>[];
  for (int i = 0; i < words.length; i++) {
    final tags = <String>[];
    if (map.fillers.contains(i)) tags.add('FILLER');
    if (map.stutters.contains(i)) tags.add('STUTTER');
    lines.add('$i|${words[i].text}${tags.isEmpty ? '' : ' <${tags.join(',')}>'}');
    final id = pauseId[i];
    if (id != null) lines.add('-- $id: pause ${pauseDurMs[i]}ms');
  }

  final inc = map.incompleteEndWords.map((e) {
    final from = math.max(0, e - 6);
    return 'word $e: "…${words.sublist(from, e + 1).map((w) => w.text).join(' ')}"';
  }).join('\n');

  final sb = StringBuffer();
  sb.write('SPEAKERS: 1 (single on-camera speaker — every repeated line is the same person re-recording a take).\n\n');
  sb.write('WORDS (index|text, one per line; pauses marked between):\n');
  sb.write(lines.join('\n'));
  sb.write('\n\n');
  if (inc.isNotEmpty) {
    sb.write('INCOMPLETE SENTENCES (left hanging before a pause):\n$inc\n');
  }
  return sb.toString();
}

/// validateEdl — parse the model's raw JSON → inclusive word-index cut ranges.
List<List<int>> parseWordCuts(String? raw, int n) {
  if (raw == null || n == 0) return [];
  var jsonStr = raw;
  final anchor = raw.indexOf('word_cuts');
  if (anchor >= 0) {
    var s = raw.lastIndexOf('{', anchor);
    if (s < 0) s = raw.indexOf('{');
    if (s >= 0) {
      int depth = 0, e = -1;
      for (int k = s; k < raw.length; k++) {
        if (raw[k] == '{') {
          depth++;
        } else if (raw[k] == '}') {
          depth--;
          if (depth == 0) {
            e = k;
            break;
          }
        }
      }
      if (e > s) jsonStr = raw.substring(s, e + 1);
    }
  }
  try {
    final obj = jsonDecode(jsonStr) as Map<String, dynamic>;
    final wc = (obj['word_cuts'] as List?) ?? [];
    final out = <List<int>>[];
    for (final c in wc) {
      final m = c as Map;
      var from = (m['from'] as num).round();
      var to = (m['to'] as num).round();
      if (from > to) {
        final tmp = from;
        from = to;
        to = tmp;
      }
      from = from.clamp(0, n - 1);
      to = to.clamp(0, n - 1);
      out.add([from, to]);
    }
    var cutCount = 0;
    for (final r in out) {
      cutCount += r[1] - r[0] + 1;
    }
    if (n >= 20 && cutCount > 0.9 * n) return []; // runaway guard
    return out;
  } catch (_) {
    return [];
  }
}

/// word-cut index ranges (+ optional word-gap silence) → KEEP ranges (ms) on the source.
List<List<int>> keepRanges(
  List<Word> words,
  List<List<int>> wordCuts,
  double durS, {
  bool cutSilence = true,
  double minPauseS = 0.5,
  double padS = 0.1,
  double airAfterS = 0.3, // silence: air kept after the last word (padAfter)
  double leadBeforeS = 0.1, // silence: lead kept before the next word (padBefore)
  // Silence regions (ms) already computed elsewhere — the FSMN (FunASR) native VAD
  // (Retake Final Boss). When supplied these ARE the silence cuts; the caller passes
  // cutSilence:false so the transcript word-gap fallback below is skipped.
  List<List<int>> extraSilenceMs = const [],
}) {
  final durMs = (durS * 1000).round();
  final cuts = <List<int>>[]; // [startMs, endMs]

  for (final r in wordCuts) {
    if (r[0] >= words.length || r[1] >= words.length) continue;
    final startS = words[r[0]].start;
    final endS = words[r[1]].end;
    final prevEnd = r[0] > 0 ? words[r[0] - 1].end : 0.0;
    final nextStart = r[1] < words.length - 1 ? words[r[1] + 1].start : durS;
    final padL = math.min(padS, math.max(0.0, (startS - prevEnd) / 2));
    final padR = math.min(padS, math.max(0.0, (nextStart - endS) / 2));
    cuts.add([((startS - padL) * 1000).round(), ((endS + padR) * 1000).round()]);
  }

  for (final s in extraSilenceMs) {
    if (s.length == 2 && s[1] > s[0]) cuts.add([s[0], s[1]]);
  }

  if (cutSilence) {
    for (int i = 0; i < words.length - 1; i++) {
      final gap = words[i + 1].start - words[i].end;
      if (gap < minPauseS) continue;
      final cutStart = words[i].end + airAfterS; // keep this much trailing air
      final cutEnd = words[i + 1].start - leadBeforeS; // lead kept into the next word
      if (cutEnd - cutStart >= 0.03) {
        cuts.add([(cutStart * 1000).round(), (cutEnd * 1000).round()]);
      }
    }
  }

  if (cuts.isEmpty) return [[0, durMs]];
  for (final c in cuts) {
    c[0] = c[0].clamp(0, durMs);
    c[1] = c[1].clamp(0, durMs);
  }
  cuts.removeWhere((c) => c[1] - c[0] <= 10);
  cuts.sort((a, b) => a[0].compareTo(b[0]));
  final merged = <List<int>>[];
  for (final c in cuts) {
    if (merged.isNotEmpty && c[0] <= merged.last[1] + 120) {
      merged.last[1] = math.max(merged.last[1], c[1]);
    } else {
      merged.add([c[0], c[1]]);
    }
  }
  final keeps = <List<int>>[];
  int cursor = 0;
  for (final c in merged) {
    if (c[0] > cursor) keeps.add([cursor, c[0]]);
    cursor = c[1];
  }
  if (cursor < durMs) keeps.add([cursor, durMs]);
  keeps.removeWhere((k) => k[1] - k[0] < 200); // drop < 0.2s slivers
  if (keeps.isEmpty) return [[0, durMs]];
  return keeps;
}

class CaptionLine {
  final String text;
  final double startS;
  final double endS;
  final List<Word> words; // the individual words in this line (for karaoke timing)
  CaptionLine(this.text, this.startS, this.endS, {this.words = const []});
}

/// Group words into caption lines (≤6 words / ≤2.8s / sentence-ender).
List<CaptionLine> groupCaptions(List<Word> words) {
  final out = <CaptionLine>[];
  var cur = <Word>[];
  void flush() {
    if (cur.isEmpty) return;
    final text = cur.map((w) => w.text.trim()).join(' ').replaceAllMapped(RegExp(r'\s+([,.!?;:])'), (m) => m[1]!);
    out.add(CaptionLine(text, cur.first.start, cur.last.end, words: List<Word>.from(cur)));
    cur = [];
  }

  for (final w in words) {
    cur.add(w);
    if (cur.length >= 6 || (w.end - cur.first.start) >= 2.8 || RegExp(r'[.!?]$').hasMatch(w.text.trim())) {
      flush();
    }
  }
  flush();
  return out;
}
