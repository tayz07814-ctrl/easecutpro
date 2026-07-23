import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Settings sheet (SettingsModal.tsx). Basic rows for now; wired in the next build.
class SettingsSheet extends StatelessWidget {
  const SettingsSheet({super.key});

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Settings',
      heightFactor: 0.5,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 20),
        children: [
          _row(Icons.person_outline, 'Account', 'tayz07814@gmail.com'),
          _row(Icons.high_quality_outlined, 'Default export quality', '720p'),
          _row(Icons.bolt_outlined, 'Cut Lord model', 'Retake Beta'),
          _row(Icons.info_outline, 'About EaseCut', 'v0.1.0 · native'),
        ],
      ),
    );
  }

  Widget _row(IconData icon, String title, String value) {
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
      decoration: BoxDecoration(color: Ec.card2, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.hair)),
      child: Row(
        children: [
          Icon(icon, size: 19, color: Ec.textMute),
          const SizedBox(width: 12),
          Text(title, style: const TextStyle(color: Ec.text, fontSize: 13.5)),
          const Spacer(),
          Text(value, style: const TextStyle(color: Ec.textFaint, fontSize: 12.5)),
        ],
      ),
    );
  }
}
