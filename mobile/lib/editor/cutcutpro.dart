import 'dart:convert';
import 'dart:math' as math;

import '../cloud/stt.dart';

/// Pure port of the essential shared/cutcutpro.ts + edit.ts logic (VAD-free):
/// words → AI payload → word-cut EDL → KEEP ranges, plus word-gap silence and
/// caption grouping. All the AI ever sees are word indices + pause ids.

const _fillers = {'uh', 'um', 'er', 'ah', 'erm', 'hmm', 'uhh', 'umm', 'mm', 'mhm'};

String _norm(String s) => s.toLowerCase().replaceAll(RegExp(r"[^a-z0-9']"), '');

/// Build the `payload` string sent to procut-judge/ultracut-judge. Pauses are
/// inter-word gaps ≥ 250 ms (the ONNX-free silence signal); fillers are tagged.
String buildPayload(List<Word> words) {
  final byAfter = <int>{};
  final sb = StringBuffer();
  if (words.isNotEmpty && words[0].start >= 0.4) {
    sb.writeln('-- lead: pause ${(words[0].start * 1000).round()}ms');
  }
  sb.writeln('WORDS (index|text, one per line; pauses marked between):');
  for (int i = 0; i < words.length; i++) {
    final t = words[i].text;
    final filler = _fillers.contains(_norm(t));
    sb.writeln('$i|$t${filler ? ' <FILLER>' : ''}');
    if (i < words.length - 1) {
      final gap = words[i + 1].start - words[i].end;
      if (gap * 1000 >= 250) {
        sb.writeln('-- p$i: pause ${(gap * 1000).round()}ms');
        byAfter.add(i);
      }
    }
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
  CaptionLine(this.text, this.startS, this.endS);
}

/// Group words into caption lines (≤6 words / ≤2.8s / sentence-ender).
List<CaptionLine> groupCaptions(List<Word> words) {
  final out = <CaptionLine>[];
  var cur = <Word>[];
  void flush() {
    if (cur.isEmpty) return;
    final text = cur.map((w) => w.text.trim()).join(' ').replaceAllMapped(RegExp(r'\s+([,.!?;:])'), (m) => m[1]!);
    out.add(CaptionLine(text, cur.first.start, cur.last.end));
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
