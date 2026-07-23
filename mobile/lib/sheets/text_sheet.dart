import 'package:flutter/material.dart';

import '../editor/text_overlay.dart';
import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// Text panel (MobileTextPanel.tsx) — 3 tabs: Text / Font / Style. "Add to
/// timeline" emits a real [TextOverlay] the editor shows in preview and bakes on export.
class TextSheet extends StatefulWidget {
  final void Function(TextOverlay) onAdd;
  const TextSheet({super.key, required this.onAdd});

  @override
  State<TextSheet> createState() => _TextSheetState();
}

class _TextSheetState extends State<TextSheet> {
  int _tab = 0; // 0 Text · 1 Font · 2 Style
  final _text = TextEditingController();
  String _align = 'center';
  double _size = 0.09;
  bool _bold = true;
  bool _italic = false;
  bool _bg = false;
  int _preset = 0;
  Color _color = Colors.white;

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Text',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
            child: _segmented(['Text', 'Font', 'Style'], _tab, (i) => setState(() => _tab = i)),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 20),
              child: switch (_tab) {
                0 => _textTab(),
                1 => _fontTab(),
                _ => _styleTab(),
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _textTab() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          decoration: BoxDecoration(
            color: const Color(0xFF101014),
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: Ec.border),
          ),
          child: TextField(
            controller: _text,
            maxLines: 4,
            style: const TextStyle(color: Ec.text, fontSize: 16),
            decoration: const InputDecoration(
              contentPadding: EdgeInsets.all(14),
              border: InputBorder.none,
              hintText: 'Type your text…',
              hintStyle: TextStyle(color: Ec.textFaint),
            ),
          ),
        ),
        const SizedBox(height: 16),
        GestureDetector(
          onTap: () {
            if (_text.text.trim().isEmpty) return;
            widget.onAdd(TextOverlay(
              text: _text.text.trim(),
              fontSize: _size,
              color: _color,
              bold: _bold,
              bg: _bg,
              startMs: 0,
              endMs: 0,
            ));
            Navigator.of(context).pop();
          },
          child: Container(
            height: 50,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: Ec.gradient,
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.add, color: Colors.white, size: 18),
                SizedBox(width: 6),
                Text('Add to timeline',
                    style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _fontTab() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _card('Alignment',
            child: _segmented(['Left', 'Center', 'Right'], ['left', 'center', 'right'].indexOf(_align),
                (i) => setState(() => _align = ['left', 'center', 'right'][i]))),
        const SizedBox(height: 12),
        _card('Size',
            child: EcSliderRow(
              label: 'Font size',
              valueLabel: (_size * 300).round().toString(),
              value: _size * 300,
              min: 6,
              max: 180,
              onChanged: (v) => setState(() => _size = v / 300),
            )),
        const SizedBox(height: 12),
        Row(
          children: [
            _glyphToggle('B', _bold, () => setState(() => _bold = !_bold), bold: true),
            const SizedBox(width: 10),
            _glyphToggle('I', _italic, () => setState(() => _italic = !_italic), italic: true),
          ],
        ),
      ],
    );
  }

  Widget _styleTab() {
    const presets = ['Plain', 'Outline', 'Boxed', 'Shadow', 'Yellow', 'Pop'];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('PRESETS',
            style: TextStyle(color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
        const SizedBox(height: 10),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (int i = 0; i < presets.length; i++)
              GestureDetector(
                onTap: () => setState(() => _preset = i),
                child: Container(
                  width: 82,
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF101014),
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: _preset == i ? const Color(0xFF7C5CFF) : Ec.border),
                  ),
                  child: Column(
                    children: [
                      const Text('Aa',
                          style: TextStyle(color: Colors.white, fontSize: 20, fontWeight: FontWeight.w800)),
                      const SizedBox(height: 6),
                      Text(presets[i], style: const TextStyle(color: Ec.textDim, fontSize: 11)),
                    ],
                  ),
                ),
              ),
          ],
        ),
        const SizedBox(height: 16),
        _card('Text colour',
            child: Row(
              children: [
                for (final c in [Colors.white, Colors.black, const Color(0xFFFFD84D), const Color(0xFFFF5D6C), Ec.indigo])
                  Padding(
                    padding: const EdgeInsets.only(right: 10),
                    child: GestureDetector(
                      onTap: () => setState(() => _color = c),
                      child: Container(
                        width: 30,
                        height: 30,
                        decoration: BoxDecoration(
                          color: c,
                          borderRadius: BorderRadius.circular(8),
                          border: Border.all(color: _color == c ? Ec.indigo : Ec.border, width: 2),
                        ),
                      ),
                    ),
                  ),
              ],
            )),
        const SizedBox(height: 12),
        _card('Background',
            child: EcRow(
              label: 'Show background',
              trailing: EcToggle(value: _bg, onChanged: (v) => setState(() => _bg = v)),
            )),
      ],
    );
  }

  // ---- helpers ----
  Widget _segmented(List<String> labels, int active, ValueChanged<int> onTap) {
    return Container(
      padding: const EdgeInsets.all(4),
      decoration: BoxDecoration(
        color: const Color(0xFF101014),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Ec.border),
      ),
      child: Row(
        children: [
          for (int i = 0; i < labels.length; i++)
            Expanded(
              child: GestureDetector(
                onTap: () => onTap(i),
                child: Container(
                  padding: const EdgeInsets.symmetric(vertical: 9),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: active == i ? Ec.gradient : null,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Text(labels[i],
                      style: TextStyle(
                          color: active == i ? Colors.white : const Color(0xFFB9B9C0),
                          fontSize: 13,
                          fontWeight: FontWeight.w600)),
                ),
              ),
            ),
        ],
      ),
    );
  }

  Widget _card(String title, {required Widget child}) {
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(color: Ec.card2, borderRadius: BorderRadius.circular(14), border: Border.all(color: Ec.hair)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title.toUpperCase(),
              style: const TextStyle(color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  Widget _glyphToggle(String label, bool on, VoidCallback onTap, {bool bold = false, bool italic = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 44,
        height: 44,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? const Color(0xFF7C5CFF).withValues(alpha: 0.18) : Ec.card2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: on ? const Color(0xFF7C5CFF) : Ec.border),
        ),
        child: Text(label,
            style: TextStyle(
                color: on ? const Color(0xFFC9B8FF) : Ec.textDim,
                fontSize: 18,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
                fontStyle: italic ? FontStyle.italic : FontStyle.normal)),
      ),
    );
  }
}
