import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../editor/variations.dart';
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Variations (VariationsPanel.tsx) — recut the source into a different edit:
/// either let the AI cast the transcript into short-form arrangements, or hand it
/// a JSON file of source ranges. Array ORDER is the edit; ranges may repeat and
/// overlap, so a "hook first" cut can reuse a line the body also contains.
class VariationsSheet extends StatefulWidget {
  /// Ask the judge for [count] arrangements (the editor owns the transcript).
  final Future<VariationParse> Function(int count) onGenerate;

  /// Parse hand-written JSON against the source duration.
  final VariationParse Function(String text, String? name) onParse;

  /// Apply one arrangement to the timeline.
  final void Function(Variation v) onApply;

  const VariationsSheet({
    super.key,
    required this.onGenerate,
    required this.onParse,
    required this.onApply,
  });

  @override
  State<VariationsSheet> createState() => _VariationsSheetState();
}

class _VariationsSheetState extends State<VariationsSheet> {
  final List<Variation> _variations = [];
  final List<String> _warnings = [];
  final TextEditingController _json = TextEditingController();
  int _count = 3;
  bool _busy = false;
  String? _error;
  bool _showPaste = false;

  @override
  void dispose() {
    _json.dispose();
    super.dispose();
  }

  void _take(VariationParse r) {
    setState(() {
      _error = r.error;
      _warnings
        ..clear()
        ..addAll(r.warnings);
      if (r.variations.isNotEmpty) {
        _variations
          ..clear()
          ..addAll(r.variations);
      }
    });
  }

  Future<void> _generate() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      _take(await widget.onGenerate(_count));
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _importFile() async {
    final res = await FilePicker.pickFiles(type: FileType.any, withData: true);
    final f = (res != null && res.files.isNotEmpty) ? res.files.first : null;
    if (f?.bytes == null) return;
    try {
      _take(widget.onParse(String.fromCharCodes(f!.bytes!), f.name));
    } catch (e) {
      setState(() => _error = 'Couldn’t read that file ($e)');
    }
  }

  void _applyPasted() {
    if (_json.text.trim().isEmpty) return;
    _take(widget.onParse(_json.text, 'Pasted'));
  }

  String _fmt(double s) {
    final m = s ~/ 60;
    final sec = (s % 60).round();
    return m > 0 ? '${m}m ${sec}s' : '${sec}s';
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Variations',
      heightFactor: 0.86,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
        children: [
          const Text(
              'Recut the same footage into a different edit — the AI casts your transcript into hook / intro / problem / selling / CTA, or you can hand it a JSON file of source ranges.',
              style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 12.5, height: 1.5)),
          const SizedBox(height: 16),
          Row(
            children: [
              const Text('How many', style: TextStyle(color: Ec.textDim, fontSize: 13)),
              const SizedBox(width: 10),
              for (final n in [1, 2, 3, 4, 5])
                GestureDetector(
                  onTap: _busy ? null : () => setState(() => _count = n),
                  child: Container(
                    margin: const EdgeInsets.only(right: 6),
                    width: 32,
                    height: 32,
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: _count == n ? Ec.indigo : Ec.chip,
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: _count == n ? Ec.indigo : Ec.border),
                    ),
                    child: Text('$n',
                        style: TextStyle(
                            color: _count == n ? Colors.white : Ec.textDim,
                            fontSize: 12.5,
                            fontWeight: FontWeight.w600)),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 12),
          GestureDetector(
            onTap: _busy ? null : _generate,
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: _busy ? const Color(0xFF2A2B33) : Ec.indigo,
                borderRadius: BorderRadius.circular(11),
                boxShadow: _busy
                    ? null
                    : [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 16, offset: const Offset(0, 4))],
              ),
              child: Text(_busy ? 'Casting…' : 'Generate with AI',
                  style: TextStyle(
                      color: _busy ? const Color(0xFF6B6F79) : Colors.white,
                      fontSize: 14,
                      fontWeight: FontWeight.w600)),
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              Expanded(child: _ghostBtn('Import JSON', _busy ? null : _importFile)),
              const SizedBox(width: 10),
              Expanded(
                  child: _ghostBtn(_showPaste ? 'Hide paste' : 'Paste JSON',
                      _busy ? null : () => setState(() => _showPaste = !_showPaste))),
            ],
          ),
          if (_showPaste) ...[
            const SizedBox(height: 10),
            TextField(
              controller: _json,
              maxLines: 7,
              style: const TextStyle(color: Ec.text, fontSize: 12, fontFamily: 'IBMPlexMono'),
              decoration: InputDecoration(
                hintText: variationExample,
                hintStyle: const TextStyle(color: Ec.textFaint, fontSize: 11, fontFamily: 'IBMPlexMono'),
                filled: true,
                fillColor: const Color(0xFF141418),
                border: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Ec.border)),
                enabledBorder: OutlineInputBorder(
                    borderRadius: BorderRadius.circular(10), borderSide: const BorderSide(color: Ec.border)),
                contentPadding: const EdgeInsets.all(12),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Expanded(child: _ghostBtn('Use this JSON', _applyPasted)),
                const SizedBox(width: 10),
                Expanded(
                    child: _ghostBtn('Copy example', () {
                  Clipboard.setData(const ClipboardData(text: variationExample));
                  ScaffoldMessenger.of(context)
                      .showSnackBar(const SnackBar(content: Text('Example copied'), duration: Duration(seconds: 2)));
                })),
              ],
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(11),
              decoration: BoxDecoration(
                color: const Color(0xFF2A1618),
                borderRadius: BorderRadius.circular(10),
                border: Border.all(color: const Color(0xFFD9686E).withValues(alpha: 0.5)),
              ),
              child: Text(_error!, style: const TextStyle(color: Color(0xFFE59BA0), fontSize: 12)),
            ),
          ],
          if (_warnings.isNotEmpty) ...[
            const SizedBox(height: 10),
            for (final w in _warnings.take(6))
              Padding(
                padding: const EdgeInsets.only(bottom: 3),
                child: Text('• $w', style: const TextStyle(color: Ec.textFaint, fontSize: 11.5, height: 1.4)),
              ),
          ],
          if (_variations.isNotEmpty) ...[
            const SizedBox(height: 18),
            const Text('ARRANGEMENTS',
                style: TextStyle(color: Ec.textMute, fontSize: 11, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
            const SizedBox(height: 10),
            for (final v in _variations) _card(v),
          ],
        ],
      ),
    );
  }

  Widget _card(Variation v) {
    return Container(
      margin: const EdgeInsets.only(bottom: 10),
      padding: const EdgeInsets.fromLTRB(13, 12, 13, 12),
      decoration: BoxDecoration(
        color: Ec.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Ec.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(v.name ?? 'Variation',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(color: Ec.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
              ),
              Text('${v.clips.length} clips · ${_fmt(v.durationS)}',
                  style: const TextStyle(color: Ec.textFaint, fontSize: 11.5)),
            ],
          ),
          const SizedBox(height: 9),
          Wrap(
            spacing: 5,
            runSpacing: 5,
            children: [
              for (final c in v.clips)
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 3),
                  decoration: BoxDecoration(color: Ec.chip, borderRadius: BorderRadius.circular(6)),
                  child: Text('${c.name ?? '—'} · ${_fmt(c.end - c.start)}',
                      style: const TextStyle(color: Ec.textDim, fontSize: 10.5)),
                ),
            ],
          ),
          const SizedBox(height: 11),
          GestureDetector(
            onTap: () {
              Navigator.of(context).pop();
              widget.onApply(v);
            },
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 10),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Ec.indigo.withValues(alpha: 0.14),
                borderRadius: BorderRadius.circular(9),
                border: Border.all(color: Ec.indigo.withValues(alpha: 0.5)),
              ),
              child: Text('Apply ${v.clips.length} clips',
                  style: const TextStyle(color: Ec.indigoText, fontSize: 12.5, fontWeight: FontWeight.w600)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _ghostBtn(String label, VoidCallback? onTap) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 12),
        alignment: Alignment.center,
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: Ec.border)),
        child: Text(label,
            style: TextStyle(color: onTap == null ? Ec.disabled : Ec.textDim, fontSize: 12.5)),
      ),
    );
  }
}
