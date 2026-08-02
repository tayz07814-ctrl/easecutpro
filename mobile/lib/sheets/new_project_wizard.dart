import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'enhance_options.dart';
import 'sheet_scaffold.dart';

/// New Project wizard (NewProjectWizard.tsx) — pick file(s) + choose enhancements.
/// UI + navigation only for now; the actual import/processing wires in next.
class NewProjectWizard extends StatefulWidget {
  /// Called with the first picked clip (path + name) plus the chosen "enhance on
  /// import" toggles, so the editor can auto-load and clean/caption/zoom it.
  final void Function(String? path, String? name, EnhanceOptions opts) onCreate;
  const NewProjectWizard({super.key, required this.onCreate});

  @override
  State<NewProjectWizard> createState() => _NewProjectWizardState();
}

class _NewProjectWizardState extends State<NewProjectWizard> {
  final List<PlatformFile> _files = [];
  EnhanceOptions _opts = const EnhanceOptions();

  Future<void> _pick() async {
    final res = await FilePicker.pickFiles(type: FileType.video, allowMultiple: true);
    if (res == null) return;
    setState(() {
      _files
        ..clear()
        ..addAll(res.files);
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
                        child: Text(e.value.name,
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
          EnhanceOptionList(value: _opts, onChanged: (n) => setState(() => _opts = n)),
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
                onTap: ready ? () => widget.onCreate(_files.first.path, _files.first.name, _opts) : null,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
                  decoration: BoxDecoration(
                    color: ready ? Ec.indigo : const Color(0xFF2A2B33),
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Text(
                    _opts.any ? 'Enhance & open editor →' : 'Create project →',
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

}
