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

/// Merge overlapping / adjacent inclusive word-cut ranges (sorted, coalesced).
List<List<int>> _mergeWordCuts(List<List<int>> cuts) {
  final sorted = [for (final c in cuts) [c[0], c[1]]]..sort((a, b) => a[0].compareTo(b[0]));
  final out = <List<int>>[];
  for (final c in sorted) {
    if (out.isNotEmpty && c[0] <= out.last[1] + 1) {
      out.last[1] = math.max(out.last[1], c[1]);
    } else {
      out.add([c[0], c[1]]);
    }
  }
  return out;
}

/// Deterministic post-EDL refinement — the mobile port of shared/cutcutpro.ts
/// refineEdl. Two pure passes over the AI's word cuts fix the screenshot-verified
/// failure family where the model cuts only the TAIL of an abandoned take:
///   (1) boundary dedupe — if kept words BEFORE a cut re-say the opening of the kept
///       words AFTER it (≥2-token prefix), extend the cut back over the doomed copy;
///   (2) fragment sweep — if a mapped INCOMPLETE sentence lost its continuation to a
///       cut, cut the whole broken clause (back to the previous sentence end).
/// A runaway guard reverts everything if refinement would cut >85% of words.
List<List<int>> refineWordCuts(List<Word> words, List<List<int>> wordCuts) {
  if (words.isEmpty || wordCuts.isEmpty) return wordCuts;
  final map = _buildJudgeMap(words);
  final tok = [for (final w in words) _norm(w.text)];
  bool endsSentence(int i) => _endsSentence.hasMatch(words[i].text.trim());

  var cuts = _mergeWordCuts(wordCuts);
  bool inCut(int i) {
    for (final c in cuts) {
      if (i >= c[0] && i <= c[1]) return true;
    }
    return false;
  }

  // ---- pass 1: boundary dedupe / backward extension --------------------------
  for (int sweep = 0; sweep < 4; sweep++) {
    var changed = false;
    for (final c in cuts) {
      final after = <int>[]; // kept tokens AFTER the cut (surviving take's opening)
      for (int i = c[1] + 1; i < words.length && after.length < 6; i++) {
        if (!inCut(i)) after.add(i);
      }
      final before = <int>[]; // kept tokens BEFORE the cut (potential doomed opening)
      for (int i = c[0] - 1; i >= 0 && before.length < 10; i--) {
        if (!inCut(i)) before.insert(0, i);
      }
      if (after.length < 2 || before.isEmpty) continue;
      var bestS = -1, bestN = 0;
      for (int s = 0; s < before.length; s++) {
        var n = 0;
        while (n < after.length &&
            s + n < before.length &&
            tok[before[s + n]] == tok[after[n]] &&
            tok[after[n]].isNotEmpty) {
          n++;
        }
        if (n >= 2 && n > bestN) {
          bestN = n;
          bestS = s;
        }
      }
      if (bestS >= 0 && c[0] - before[bestS] <= 12) {
        c[0] = before[bestS];
        changed = true;
      }
    }
    cuts = _mergeWordCuts(cuts);
    if (!changed) break;
  }

  // ---- pass 2: incomplete-fragment sweep -------------------------------------
  for (final e in map.incompleteEndWords) {
    if (e < 0 || e >= words.length || inCut(e)) continue;
    final next = [e + 1, e + 2].where((i) => i < words.length).toList();
    if (!next.any(inCut)) continue;
    List<int>? cut;
    for (final c in cuts) {
      if (next.any((i) => i >= c[0] && i <= c[1])) {
        cut = c;
        break;
      }
    }
    if (cut == null) continue;
    var start = -1;
    for (int i = e - 1, steps = 0; i >= 0 && steps < 20; i--, steps++) {
      if (inCut(i)) continue;
      if (endsSentence(i)) {
        start = i + 1;
        break;
      }
      if (i == 0) start = 0;
    }
    if (start < 0 || start > e) continue;
    if (cut[0] > start) cut[0] = math.min(cut[0], start);
  }
  cuts = _mergeWordCuts(cuts);

  // ---- runaway guard ---------------------------------------------------------
  var cutCount = 0;
  for (final c in cuts) {
    cutCount += c[1] - c[0] + 1;
  }
  if (words.length >= 20 && cutCount > words.length * 0.85) return wordCuts;
  return cuts;
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
