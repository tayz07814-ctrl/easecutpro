import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Audio sheet (MobileEditor.tsx MusicSheet) — import music/voiceover. Imported
/// tracks are mixed into the export; each shows here with a volume + remove.
class AudioSheet extends StatelessWidget {
  final List<String> names;
  final List<double> volumes; // 0..1 per track (parallel to [names])
  final int selected; // -1 = none (highlighted row)
  final void Function(String path, String name) onImport;
  final void Function(int index) onRemove;
  final void Function(int index, double volume)? onVolume;
  const AudioSheet({
    super.key,
    required this.names,
    this.volumes = const [],
    this.selected = -1,
    required this.onImport,
    required this.onRemove,
    this.onVolume,
  });

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
              itemBuilder: (_, i) {
                final vol = i < volumes.length ? volumes[i] : 1.0;
                return Container(
                  margin: const EdgeInsets.only(bottom: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: Ec.card,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: i == selected ? Ec.green : Ec.border),
                  ),
                  child: Column(
                    children: [
                      Row(
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
                      if (onVolume != null)
                        Row(
                          children: [
                            const Icon(Icons.volume_up, size: 16, color: Ec.textFaint),
                            Expanded(
                              child: SliderTheme(
                                data: SliderTheme.of(context).copyWith(
                                  trackHeight: 3,
                                  overlayShape: SliderComponentShape.noOverlay,
                                  thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
                                ),
                                child: Slider(
                                  value: vol.clamp(0.0, 1.0),
                                  activeColor: Ec.green,
                                  inactiveColor: Ec.chip,
                                  onChanged: (v) => onVolume!(i, v),
                                ),
                              ),
                            ),
                            SizedBox(
                              width: 34,
                              child: Text('${(vol * 100).round()}%',
                                  textAlign: TextAlign.right,
                                  style: const TextStyle(color: Ec.textDim, fontSize: 11)),
                            ),
                          ],
                        ),
                    ],
                  ),
                );
              },
            ),
    );
  }
}
