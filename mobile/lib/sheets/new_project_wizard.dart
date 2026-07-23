import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// New Project wizard (NewProjectWizard.tsx) — pick file(s) + choose enhancements.
/// UI + navigation only for now; the actual import/processing wires in next.
class NewProjectWizard extends StatefulWidget {
  final VoidCallback onCreate;
  const NewProjectWizard({super.key, required this.onCreate});

  @override
  State<NewProjectWizard> createState() => _NewProjectWizardState();
}

class _NewProjectWizardState extends State<NewProjectWizard> {
  final List<String> _files = [];
  bool _cutSilence = true;
  bool _autoCaptions = false;

  Future<void> _pick() async {
    final res = await FilePicker.pickFiles(type: FileType.video, allowMultiple: true);
    if (res == null) return;
    setState(() {
      _files
        ..clear()
        ..addAll(res.files.map((f) => f.name));
    });
  }

  @override
  Widget build(BuildContext context) {
    final ready = _files.isNotEmpty;
    return SheetScaffold(
      title: 'New project',
      heightFactor: 0.72,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
        children: [
          const Text('Pick your clips and we’ll set up the timeline.',
              style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
          const SizedBox(height: 16),
          // Dashed file picker
          GestureDetector(
            onTap: _pick,
            child: Container(
              padding: const EdgeInsets.all(16),
              decoration: BoxDecoration(
                color: Ec.indigo.withValues(alpha: 0.08),
                borderRadius: BorderRadius.circular(12),
                border: Border.all(
                    color: Ec.indigo.withValues(alpha: 0.5), width: 1.5, style: BorderStyle.solid),
              ),
              child: Center(
                child: Text(
                  _files.isEmpty ? '＋ Select video file(s)' : 'Add more video files',
                  style: const TextStyle(color: Ec.indigoText, fontSize: 14, fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ),
          if (_files.isNotEmpty) ...[
            const SizedBox(height: 10),
            ..._files.asMap().entries.map((e) => Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Row(
                    children: [
                      Text('${e.key + 1}.',
                          style: const TextStyle(color: Ec.textFaint, fontSize: 12.5)),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(e.value,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(color: Ec.textDim, fontSize: 12.5)),
                      ),
                    ],
                  ),
                )),
            if (_files.length > 1)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text('${_files.length} clips will be placed on one timeline, in this order.',
                    style: const TextStyle(color: Ec.textFaint, fontSize: 12)),
              ),
          ],
          const SizedBox(height: 20),
          const Text('ENHANCE ON IMPORT',
              style: TextStyle(
                  color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
          const SizedBox(height: 10),
          _option('✂️', 'Cut silences & bad takes', 'Trim dead air and retakes automatically.',
              _cutSilence, () => setState(() => _cutSilence = !_cutSilence)),
          const SizedBox(height: 8),
          _option('💬', 'Auto captions', 'Add styled subtitles from your speech.', _autoCaptions,
              () => setState(() => _autoCaptions = !_autoCaptions)),
          const SizedBox(height: 8),
          _option('🔍', 'Auto zoom', 'Punch-in on emphasis. Coming soon.', false, null, soon: true),
          const SizedBox(height: 22),
          Row(
            children: [
              GestureDetector(
                onTap: () => Navigator.of(context).pop(),
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8, vertical: 12),
                  child: Text('Cancel', style: TextStyle(color: Ec.textMute, fontSize: 14)),
                ),
              ),
              const Spacer(),
              GestureDetector(
                onTap: ready ? widget.onCreate : null,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                  decoration: BoxDecoration(
                    color: ready ? Ec.indigo : const Color(0xFF2A2B33),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    _cutSilence || _autoCaptions ? 'Enhance & open editor →' : 'Create project →',
                    style: TextStyle(
                        color: ready ? Colors.white : const Color(0xFF6B6F79),
                        fontSize: 14,
                        fontWeight: FontWeight.w600),
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _option(String emoji, String title, String sub, bool on, VoidCallback? onTap, {bool soon = false}) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF191A20),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: on ? Ec.indigo : Ec.border,
            width: on ? 1.5 : 1,
          ),
          boxShadow: on
              ? [BoxShadow(color: Ec.indigo.withValues(alpha: 0.18), blurRadius: 0, spreadRadius: 3)]
              : null,
        ),
        child: Row(
          children: [
            Text(emoji, style: const TextStyle(fontSize: 20)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Text(title,
                          style: const TextStyle(color: Ec.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                      if (soon) ...[
                        const SizedBox(width: 8),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                          decoration: BoxDecoration(
                            color: Ec.chip,
                            borderRadius: BorderRadius.circular(5),
                          ),
                          child: const Text('Soon',
                              style: TextStyle(color: Ec.textMute, fontSize: 9, fontWeight: FontWeight.w600)),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(sub, style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 11.5)),
                ],
              ),
            ),
            const SizedBox(width: 10),
            Container(
              width: 22,
              height: 22,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: on ? Ec.indigo : Colors.transparent,
                border: Border.all(color: on ? Ec.indigo : Ec.textFaint, width: 1.5),
              ),
              child: on ? const Icon(Icons.check, size: 14, color: Colors.white) : null,
            ),
          ],
        ),
      ),
    );
  }
}
