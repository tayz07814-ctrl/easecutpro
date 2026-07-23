import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Audio sheet (MobileEditor.tsx MusicSheet) — import music/voiceover. Imported
/// tracks are mixed into the export; each shows here with a remove button.
class AudioSheet extends StatelessWidget {
  final List<String> names;
  final void Function(String path, String name) onImport;
  final void Function(int index) onRemove;
  const AudioSheet({super.key, required this.names, required this.onImport, required this.onRemove});

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Audio',
      trailing: GestureDetector(
        onTap: () async {
          final res = await FilePicker.pickFiles(type: FileType.audio);
          final f = res?.files.single;
          if (f?.path != null) {
            onImport(f!.path!, f.name);
            if (context.mounted) Navigator.of(context).pop();
          }
        },
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          decoration: BoxDecoration(
            color: Ec.indigoTint,
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: Ec.indigo.withValues(alpha: 0.3)),
          ),
          child: const Text('＋ Import audio',
              style: TextStyle(color: Ec.indigoText, fontSize: 12.5, fontWeight: FontWeight.w600)),
        ),
      ),
      child: names.isEmpty
          ? const Padding(
              padding: EdgeInsets.fromLTRB(24, 32, 24, 24),
              child: Text(
                'No audio yet — tap ＋ Import audio to add music or a voiceover. It’s mixed into your export.',
                textAlign: TextAlign.center,
                style: TextStyle(color: Ec.textFaint, fontSize: 13, height: 1.6),
              ),
            )
          : ListView.builder(
              padding: const EdgeInsets.fromLTRB(14, 0, 14, 20),
              itemCount: names.length,
              itemBuilder: (_, i) => Container(
                margin: const EdgeInsets.only(bottom: 8),
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.border)),
                child: Row(
                  children: [
                    Container(
                      width: 44,
                      height: 44,
                      decoration: BoxDecoration(color: Ec.chip, borderRadius: BorderRadius.circular(9)),
                      child: const Icon(Icons.music_note, color: Color(0xFF8890A0), size: 20),
                    ),
                    const SizedBox(width: 11),
                    Expanded(
                      child: Text(names[i],
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(color: Ec.text, fontSize: 13, fontWeight: FontWeight.w500)),
                    ),
                    GestureDetector(
                      onTap: () => onRemove(i),
                      child: const Padding(
                        padding: EdgeInsets.all(6),
                        child: Icon(Icons.close, size: 18, color: Ec.textFaint),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }
}
