import 'package:flutter/material.dart';

import '../cloud/stt.dart' show Word;
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Cut Lord REVIEW pass: the AI's proposed word cuts shown over the transcript.
/// Tap a word to keep/cut it; struck-through red = will be removed. "Execute"
/// emits the final inclusive index ranges so the editor computes keep-ranges.
class CutReviewSheet extends StatefulWidget {
  final List<Word> words;
  final List<List<int>> initialCuts; // inclusive index ranges
  final String modelLabel;
  final void Function(List<List<int>> finalCuts) onExecute;

  const CutReviewSheet({
    super.key,
    required this.words,
    required this.initialCuts,
    required this.modelLabel,
    required this.onExecute,
  });

  @override
  State<CutReviewSheet> createState() => _CutReviewSheetState();
}

class _CutReviewSheetState extends State<CutReviewSheet> {
  final Set<int> _cut = {};

  @override
  void initState() {
    super.initState();
    for (final r in widget.initialCuts) {
      if (r.length == 2) {
        for (int i = r[0]; i <= r[1]; i++) {
          _cut.add(i);
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

  double get _savedS {
    double s = 0;
    for (final i in _cut) {
      if (i >= 0 && i < widget.words.length) s += (widget.words[i].end - widget.words[i].start);
    }
    return s;
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Review cuts',
      heightFactor: 0.86,
      trailing: Text('${widget.modelLabel} · ~${_savedS.toStringAsFixed(1)}s',
          style: const TextStyle(color: Ec.textMute, fontSize: 12)),
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
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(14, 4, 14, 8),
              child: Wrap(
                spacing: 3,
                runSpacing: 2,
                children: [
                  for (int i = 0; i < widget.words.length; i++) _wordChip(i),
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
