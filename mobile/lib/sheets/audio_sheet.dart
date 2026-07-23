import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Audio sheet (MobileEditor.tsx MusicSheet) — import music/voiceover onto an audio
/// track. Import + timeline placement wire in the next build.
class AudioSheet extends StatelessWidget {
  const AudioSheet({super.key});

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Audio',
      trailing: GestureDetector(
        onTap: () => ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Audio import wires in the next build'), backgroundColor: Ec.card),
        ),
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
      child: const Padding(
        padding: EdgeInsets.fromLTRB(24, 32, 24, 24),
        child: Text(
          'No audio yet — tap ＋ Import audio to add music or a voiceover. It drops onto an audio track.',
          textAlign: TextAlign.center,
          style: TextStyle(color: Ec.textFaint, fontSize: 13, height: 1.6),
        ),
      ),
    );
  }
}
