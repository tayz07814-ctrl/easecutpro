import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../cloud/stt.dart' show Word;
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Cut Lord REVIEW pass. Opens AFTER the judge has found cuts (they arrive pre-applied
/// via [aiCuts]); the transcript is rendered grouped into SENTENCES (not one paragraph)
/// so it's readable. Tap a word to keep/cut; "Execute" emits the final inclusive index
/// ranges. [judging] is kept for compatibility (normally false here).
class CutReviewSheet extends StatefulWidget {
  final List<Word> words;
  final ValueListenable<List<List<int>>> aiCuts; // AI proposal (may arrive late / empty)
  final ValueListenable<bool> judging; // true while the AI judge is still running
  final String modelLabel;
  final void Function(List<List<int>> finalCuts) onExecute;

  const CutReviewSheet({
    super.key,
    required this.words,
    required this.aiCuts,
    required this.judging,
    required this.modelLabel,
    required this.onExecute,
  });

  @override
  State<CutReviewSheet> createState() => _CutReviewSheetState();
}

/// The same list the web editor strikes with its "Strike fillers" button
/// (shared/fillers.ts DEFAULT_FILLERS), so both apps remove the same words.
const _defaultFillers = [
  'um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'err', 'ah', 'hmm', 'mm', 'mhm', 'eh', //
  'like', 'basically', 'actually', 'literally', 'honestly', //
  'you know', 'i mean', 'sort of', 'kind of',
];

final _nonWord = RegExp(r"[^a-z']");
String _norm(String s) => s.toLowerCase().replaceAll(_nonWord, '');

class _CutReviewSheetState extends State<CutReviewSheet> {
  final Set<int> _cut = {};
  List<List<int>> _lastAi = const [];

  /// Word indices that are filler words or filler PHRASES ("you know", "i mean").
  Set<int> _fillerIds() {
    final singles = {for (final f in _defaultFillers) if (!f.contains(' ')) _norm(f)}..remove('');
    final phrases = [
      for (final f in _defaultFillers)
        if (f.contains(' ')) [for (final p in f.trim().toLowerCase().split(RegExp(r'\s+'))) _norm(p)]
    ].where((p) => p.length > 1).toList();
    final words = widget.words;
    final ids = <int>{};
    for (var i = 0; i < words.length; i++) {
      if (singles.contains(_norm(words[i].text))) ids.add(i);
    }
    for (var i = 0; i < words.length; i++) {
      for (final ph in phrases) {
        if (i + ph.length <= words.length) {
          var hit = true;
          for (var k = 0; k < ph.length; k++) {
            if (_norm(words[i + k].text) != ph[k]) {
              hit = false;
              break;
            }
          }
          if (hit) {
            for (var k = 0; k < ph.length; k++) {
              ids.add(i + k);
            }
          }
        }
      }
    }
    return ids;
  }

  @override
  void initState() {
    super.initState();
    _mergeAi(widget.aiCuts.value);
    widget.aiCuts.addListener(_onAi);
    widget.judging.addListener(_onJudging);
  }

  @override
  void dispose() {
    widget.aiCuts.removeListener(_onAi);
    widget.judging.removeListener(_onJudging);
    super.dispose();
  }

  void _onAi() {
    setState(() => _mergeAi(widget.aiCuts.value));
  }

  void _onJudging() {
    if (mounted) setState(() {});
  }

  /// Merge freshly-proposed AI ranges into the cut set (keeps the user's own edits).
  void _mergeAi(List<List<int>> ranges) {
    if (identical(ranges, _lastAi)) return;
    _lastAi = ranges;
    for (final r in ranges) {
      if (r.length == 2) {
        for (int i = r[0]; i <= r[1] && i < widget.words.length; i++) {
          if (i >= 0) _cut.add(i);
        }
      }
    }
  }

  List<List<int>> _ranges() {
    final sorted = _cut.where((i) => i >= 0 && i < widget.words.length).toList()..sort();
    final out = <List<int>>[];
    for (final i in sorted) {
      if (out.isNotEmpty && i == out.last[1] + 1) {
        out.last[1] = i;
      } else {
        out.add([i, i]);
      }
    }
    return out;
  }

  /// Group word indices into sentences (break after a word ending in . ? ! …) so the
  /// transcript reads as sentences rather than one long paragraph.
  List<List<int>> _sentences() {
    final out = <List<int>>[];
    var cur = <int>[];
    for (int i = 0; i < widget.words.length; i++) {
      cur.add(i);
      final t = widget.words[i].text.trimRight();
      if (t.isNotEmpty && (t.endsWith('.') || t.endsWith('?') || t.endsWith('!') || t.endsWith('…'))) {
        out.add(cur);
        cur = <int>[];
      }
    }
    if (cur.isNotEmpty) out.add(cur);
    return out;
  }

  double get _savedS {
    double s = 0;
    for (final i in _cut) {
      if (i >= 0 && i < widget.words.length) s += (widget.words[i].end - widget.words[i].start);
    }
    return s;
  }

  Widget _bulkBtn(String label, VoidCallback? onTap) {
    final on = onTap != null;
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: Ec.chip,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: Ec.border),
        ),
        child: Text(label,
            style: TextStyle(
                color: on ? Ec.textDim : Ec.disabled, fontSize: 12, fontWeight: FontWeight.w600)),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final judging = widget.judging.value;
    return SheetScaffold(
      title: 'Review cuts',
      heightFactor: 0.86,
      trailing: judging
          ? const Row(mainAxisSize: MainAxisSize.min, children: [
              SizedBox(width: 13, height: 13, child: CircularProgressIndicator(strokeWidth: 2, color: Ec.indigo)),
              SizedBox(width: 7),
              Text('Finding cuts…', style: TextStyle(color: Ec.textMute, fontSize: 12)),
            ])
          : Text('~${_savedS.toStringAsFixed(1)}s', style: const TextStyle(color: Ec.textMute, fontSize: 12)),
      child: Column(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text('Tap a word to keep or cut it. Struck-through words are removed.',
                  style: TextStyle(color: Ec.textMute, fontSize: 12.5)),
            ),
          ),
          // Bulk passes, matching the web transcript editor.
          Padding(
            padding: const EdgeInsets.fromLTRB(14, 0, 14, 8),
            child: Row(
              children: [
                _bulkBtn('Strike fillers', () => setState(() => _cut.addAll(_fillerIds()))),
                const SizedBox(width: 8),
                _bulkBtn('Restore all', _cut.isEmpty ? null : () => setState(() => _cut.clear())),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // One Wrap per sentence, with a gap between them — reads as sentences
                  // instead of one continuous paragraph.
                  for (final sentence in _sentences())
                    Padding(
                      padding: const EdgeInsets.only(bottom: 9),
                      child: Wrap(
                        spacing: 3,
                        runSpacing: 2,
                        children: [for (final i in sentence) _wordChip(i)],
                      ),
                    ),
                ],
              ),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                children: [
                  Text('${_cut.length} cut',
                      style: const TextStyle(color: Ec.textDim, fontSize: 13, fontWeight: FontWeight.w600)),
                  if (_cut.isNotEmpty) ...[
                    const SizedBox(width: 10),
                    GestureDetector(
                      onTap: () => setState(() => _cut.clear()),
                      child: const Text('Clear', style: TextStyle(color: Ec.textMute, fontSize: 12.5)),
                    ),
                  ],
                  const Spacer(),
                  GestureDetector(
                    onTap: () => Navigator.of(context).pop(),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                      child: Text('Cancel', style: TextStyle(color: Ec.textMute, fontSize: 14)),
                    ),
                  ),
                  const SizedBox(width: 6),
                  GradientButton(
                    label: 'Execute cuts',
                    icon: Icons.content_cut,
                    onTap: () => widget.onExecute(_ranges()),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _wordChip(int i) {
    final cut = _cut.contains(i);
    return GestureDetector(
      onTap: () => setState(() => cut ? _cut.remove(i) : _cut.add(i)),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 3),
        decoration: BoxDecoration(
          color: cut ? const Color(0x33FF5D6C) : Colors.transparent,
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(
          widget.words[i].text,
          style: TextStyle(
            color: cut ? const Color(0xFFFF8A9A) : Ec.text,
            fontSize: 14.5,
            height: 1.35,
            decoration: cut ? TextDecoration.lineThrough : null,
            decorationColor: const Color(0xFFFF8A9A),
            decorationThickness: 2,
          ),
        ),
      ),
    );
  }
}
