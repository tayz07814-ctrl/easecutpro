import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Media sheet (MobileEditor.tsx `MediaSheet`) — import a clip; shows the current one.
class MediaSheet extends StatelessWidget {
  final String? currentName;
  final Future<void> Function() onPick;
  const MediaSheet({super.key, required this.currentName, required this.onPick});

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Media',
      trailing: GestureDetector(
        onTap: onPick,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
          decoration: BoxDecoration(
            color: Ec.indigoTint,
            borderRadius: BorderRadius.circular(9),
            border: Border.all(color: Ec.indigo.withValues(alpha: 0.3)),
          ),
          child: const Text('＋ Import',
              style: TextStyle(color: Ec.indigoText, fontSize: 12.5, fontWeight: FontWeight.w600)),
        ),
      ),
      child: ListView(
        padding: const EdgeInsets.fromLTRB(14, 0, 14, 20),
        children: [
          if (currentName == null)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 32),
              child: Text('No clips yet — tap ＋ Import to add a video.',
                  textAlign: TextAlign.center,
                  style: TextStyle(color: Ec.textFaint, fontSize: 13)),
            )
          else
            Container(
              padding: const EdgeInsets.all(10),
              decoration: BoxDecoration(
                color: Ec.card,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: Ec.indigo.withValues(alpha: 0.55)),
              ),
              child: Row(
                children: [
                  Container(
                    width: 44,
                    height: 56,
                    decoration: BoxDecoration(
                      color: Ec.chip,
                      borderRadius: BorderRadius.circular(7),
                    ),
                    child: const Icon(Icons.videocam, color: Ec.textFaint, size: 20),
                  ),
                  const SizedBox(width: 11),
                  Expanded(
                    child: Text(currentName!,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Ec.text, fontSize: 13, fontWeight: FontWeight.w500)),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                    decoration: BoxDecoration(
                      color: Ec.indigo.withValues(alpha: 0.18),
                      borderRadius: BorderRadius.circular(5),
                    ),
                    child: const Text('Base',
                        style: TextStyle(
                            color: Ec.indigoText, fontSize: 10, fontWeight: FontWeight.w600)),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
