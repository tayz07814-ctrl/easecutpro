import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../editor/text_overlay.dart';
import '../local/fonts_store.dart';
import '../local/text_presets_store.dart';
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
  String? _fontFamily; // null = the app default font (InstrumentSans)

  // Built-in Style presets. Tapping one applies its colour/weight/background to
  // the text being built (font + size are left as-is). [_preset] records which
  // one is active, so a custom preset can remember what it derived from.
  static const List<Map<String, Object>> _builtins = [
    {'name': 'Plain', 'color': 0xFFFFFFFF, 'bold': true, 'bg': false},
    {'name': 'Outline', 'color': 0xFFFFFFFF, 'bold': true, 'bg': false},
    {'name': 'Boxed', 'color': 0xFFFFFFFF, 'bold': true, 'bg': true},
    {'name': 'Shadow', 'color': 0xFFFFFFFF, 'bold': true, 'bg': false},
    {'name': 'Yellow', 'color': 0xFFFFD84D, 'bold': true, 'bg': false},
    {'name': 'Pop', 'color': 0xFF7C5CFF, 'bold': true, 'bg': false},
  ];

  @override
  void initState() {
    super.initState();
    // Load saved presets + register user fonts so both pickers are populated.
    TextPresets.instance.load().then((_) {
      if (mounted) setState(() {});
    });
    EcFonts.instance.ensureLoaded().then((_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Text',
      heightFactor: 0.5,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: _segmented(['Text', 'Font', 'Style'], _tab, (i) => setState(() => _tab = i)),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
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
            maxLines: 3,
            style: const TextStyle(color: Ec.text, fontSize: 15),
            decoration: const InputDecoration(
              contentPadding: EdgeInsets.all(12),
              border: InputBorder.none,
              hintText: 'Type your text…',
              hintStyle: TextStyle(color: Ec.textFaint),
            ),
          ),
        ),
        const SizedBox(height: 12),
        GestureDetector(
          onTap: () {
            if (_text.text.trim().isEmpty) return;
            widget.onAdd(TextOverlay(
              text: _text.text.trim(),
              fontSize: _size,
              color: _color,
              bold: _bold,
              italic: _italic,
              align: _align,
              bg: _bg,
              fontFamily: _fontFamily,
              startMs: 0,
              endMs: 0,
            ));
            Navigator.of(context).pop();
          },
          child: Container(
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              gradient: Ec.gradient,
              borderRadius: BorderRadius.circular(12),
            ),
            child: const Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(Icons.add, color: Colors.white, size: 16),
                SizedBox(width: 6),
                Text('Add to timeline',
                    style: TextStyle(color: Colors.white, fontSize: 13.5, fontWeight: FontWeight.w700)),
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
        _card('Font', child: _fontPicker()),
        const SizedBox(height: 10),
        _card('Alignment',
            child: _segmented(['Left', 'Center', 'Right'], ['left', 'center', 'right'].indexOf(_align),
                (i) => setState(() => _align = ['left', 'center', 'right'][i]))),
        const SizedBox(height: 10),
        _card('Size',
            child: EcSliderRow(
              label: 'Font size',
              valueLabel: (_size * 300).round().toString(),
              value: _size * 300,
              min: 6,
              max: 180,
              onChanged: (v) => setState(() => _size = v / 300),
            )),
        const SizedBox(height: 10),
        Row(
          children: [
            _glyphToggle('B', _bold, () => setState(() => _bold = !_bold), bold: true),
            const SizedBox(width: 8),
            _glyphToggle('I', _italic, () => setState(() => _italic = !_italic), italic: true),
          ],
        ),
      ],
    );
  }

  Widget _styleTab() {
    final custom = TextPresets.instance.presets;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Text('PRESETS',
                style: TextStyle(
                    color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
            const Spacer(),
            GestureDetector(
              onTap: _saveCurrentPreset,
              behavior: HitTestBehavior.opaque,
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.bookmark_add_outlined, size: 15, color: Ec.indigoText),
                  SizedBox(width: 4),
                  Text('Save current',
                      style: TextStyle(color: Ec.indigoText, fontSize: 11.5, fontWeight: FontWeight.w600)),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (int i = 0; i < _builtins.length; i++) _builtinCard(i),
            for (final p in custom) _customPresetCard(p),
          ],
        ),
        const SizedBox(height: 12),
        _card('Text colour',
            child: Row(
              children: [
                for (final c in [Colors.white, Colors.black, const Color(0xFFFFD84D), const Color(0xFFFF5D6C), Ec.indigo])
                  Padding(
                    padding: const EdgeInsets.only(right: 8),
                    child: GestureDetector(
                      onTap: () => setState(() => _color = c),
                      child: Container(
                        width: 26,
                        height: 26,
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
        const SizedBox(height: 10),
        _card('Background',
            child: EcRow(
              label: 'Show background',
              trailing: EcToggle(value: _bg, onChanged: (v) => setState(() => _bg = v)),
            )),
      ],
    );
  }

  // ---- Font tab: family picker (Task 3) ----
  Widget _fontPicker() {
    final families = EcFonts.instance.families;
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      children: [
        for (final fam in families) _fontChip(fam),
        _addFontChip(),
      ],
    );
  }

  Widget _fontChip(String fam) {
    // The first bundled family is the default, so a null selection shows it active.
    final on = _fontFamily == fam || (_fontFamily == null && fam == EcFonts.bundled.first);
    final removable = EcFonts.instance.isUser(fam);
    return GestureDetector(
      onTap: () => setState(() => _fontFamily = fam),
      onLongPress: removable ? () => _removeFont(fam) : null,
      child: Container(
        width: 96,
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
        decoration: BoxDecoration(
          color: const Color(0xFF101014),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: on ? const Color(0xFF7C5CFF) : Ec.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Preview the family in its own font.
            Text('Aa Sample',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700, fontFamily: fam)),
            const SizedBox(height: 4),
            Text(fam,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(color: on ? const Color(0xFFC9B8FF) : Ec.textDim, fontSize: 10)),
          ],
        ),
      ),
    );
  }

  Widget _addFontChip() {
    return GestureDetector(
      onTap: _addFont,
      behavior: HitTestBehavior.opaque,
      child: Container(
        height: 51,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: Ec.card2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Ec.border),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.add, size: 15, color: Ec.indigoText),
            SizedBox(width: 5),
            Text('Add font', style: TextStyle(color: Ec.indigoText, fontSize: 11.5, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Future<void> _addFont() async {
    FilePickerResult? res;
    try {
      res = await FilePicker.pickFiles(
        type: FileType.custom,
        allowedExtensions: ['ttf', 'otf'],
        withData: true,
      );
    } catch (_) {
      _snack('Couldn’t open the file picker');
      return;
    }
    final f = (res != null && res.files.isNotEmpty) ? res.files.first : null;
    if (f == null) return;
    var bytes = f.bytes;
    if (bytes == null && f.path != null) {
      try {
        bytes = await File(f.path!).readAsBytes();
      } catch (_) {}
    }
    if (bytes == null) {
      _snack('Couldn’t read that font file');
      return;
    }
    final family = await EcFonts.instance.addFont(f.name, bytes);
    if (!mounted) return;
    setState(() => _fontFamily = family);
  }

  Future<void> _removeFont(String fam) async {
    await EcFonts.instance.remove(fam);
    if (!mounted) return;
    setState(() {
      if (_fontFamily == fam) _fontFamily = null;
    });
  }

  void _snack(String m) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: Ec.card));
  }

  // ---- Style tab: built-in + saved presets (Task 5) ----
  Widget _builtinCard(int i) {
    final b = _builtins[i];
    final col = Color(b['color'] as int);
    final boxed = b['bg'] as bool;
    final on = _preset == i;
    return GestureDetector(
      onTap: () => _applyBuiltin(i),
      child: Container(
        width: 76,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: const Color(0xFF101014),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: on ? const Color(0xFF7C5CFF) : Ec.border),
        ),
        child: Column(
          children: [
            Container(
              padding: boxed ? const EdgeInsets.symmetric(horizontal: 6, vertical: 1) : null,
              decoration:
                  boxed ? BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(4)) : null,
              child: Text('Aa', style: TextStyle(color: col, fontSize: 17, fontWeight: FontWeight.w800)),
            ),
            const SizedBox(height: 5),
            Text(b['name'] as String, style: const TextStyle(color: Ec.textDim, fontSize: 10.5)),
          ],
        ),
      ),
    );
  }

  Widget _customPresetCard(TextPreset p) {
    final col = Color(p.colorValue);
    return GestureDetector(
      onTap: () => _applyPreset(p),
      onLongPress: () => _deletePreset(p),
      child: Container(
        width: 76,
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          color: const Color(0xFF101014),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Ec.border),
        ),
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Column(
              children: [
                Container(
                  padding: p.bg ? const EdgeInsets.symmetric(horizontal: 6, vertical: 1) : null,
                  decoration:
                      p.bg ? BoxDecoration(color: Colors.black, borderRadius: BorderRadius.circular(4)) : null,
                  child: Text('Aa',
                      style: TextStyle(
                          color: col,
                          fontSize: 17,
                          fontFamily: p.fontFamily,
                          fontWeight: p.bold ? FontWeight.w800 : FontWeight.w500)),
                ),
                const SizedBox(height: 5),
                SizedBox(
                  width: 58,
                  child: Text(p.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Ec.textDim, fontSize: 10.5)),
                ),
              ],
            ),
            Positioned(
              top: 0,
              right: 0,
              child: GestureDetector(
                onTap: () => _deletePreset(p),
                child: Container(
                  width: 17,
                  height: 17,
                  alignment: Alignment.center,
                  decoration: const BoxDecoration(color: Ec.card, shape: BoxShape.circle),
                  child: const Icon(Icons.close, size: 11, color: Ec.textDim),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  void _applyBuiltin(int i) {
    final b = _builtins[i];
    setState(() {
      _preset = i;
      _color = Color(b['color'] as int);
      _bold = b['bold'] as bool;
      _bg = b['bg'] as bool;
      _tab = 0; // jump back to the Text tab to type
    });
  }

  void _applyPreset(TextPreset p) {
    setState(() {
      _color = Color(p.colorValue);
      _bold = p.bold;
      _bg = p.bg;
      _fontFamily = p.fontFamily;
      _size = p.size;
      _align = p.align;
      _preset = p.base;
    });
    _snack('Applied “${p.name}”');
  }

  Future<void> _deletePreset(TextPreset p) async {
    await TextPresets.instance.delete(p.id);
    if (mounted) setState(() {});
  }

  Future<void> _saveCurrentPreset() async {
    final name = await _promptPresetName();
    if (name == null) return;
    await TextPresets.instance.add(
      name: name,
      colorValue: _color.toARGB32(),
      bold: _bold,
      bg: _bg,
      fontFamily: _fontFamily,
      size: _size,
      align: _align,
      base: _preset,
    );
    if (mounted) setState(() {});
  }

  Future<String?> _promptPresetName() {
    final ctrl = TextEditingController();
    return showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        title: const Text('Save preset', style: TextStyle(color: Ec.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(color: Ec.text),
          decoration: const InputDecoration(hintText: 'Preset name', hintStyle: TextStyle(color: Ec.textFaint)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          TextButton(
            onPressed: () {
              final t = ctrl.text.trim();
              Navigator.of(context).pop(t.isEmpty ? 'Preset' : t);
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  // ---- helpers ----
  Widget _segmented(List<String> labels, int active, ValueChanged<int> onTap) {
    return Container(
      padding: const EdgeInsets.all(3),
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
                  padding: const EdgeInsets.symmetric(vertical: 7),
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: active == i ? Ec.gradient : null,
                    borderRadius: BorderRadius.circular(9),
                  ),
                  child: Text(labels[i],
                      style: TextStyle(
                          color: active == i ? Colors.white : const Color(0xFFB9B9C0),
                          fontSize: 12.5,
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
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(color: Ec.card2, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.hair)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(title.toUpperCase(),
              style: const TextStyle(color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
          const SizedBox(height: 8),
          child,
        ],
      ),
    );
  }

  Widget _glyphToggle(String label, bool on, VoidCallback onTap, {bool bold = false, bool italic = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        width: 40,
        height: 40,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? const Color(0xFF7C5CFF).withValues(alpha: 0.18) : Ec.card2,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: on ? const Color(0xFF7C5CFF) : Ec.border),
        ),
        child: Text(label,
            style: TextStyle(
                color: on ? const Color(0xFFC9B8FF) : Ec.textDim,
                fontSize: 16,
                fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
                fontStyle: italic ? FontStyle.italic : FontStyle.normal)),
      ),
    );
  }
}
