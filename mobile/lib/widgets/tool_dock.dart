import 'package:flutter/material.dart';

import '../theme.dart';

/// Bottom tool dock — the MAIN toolbar from MobileTools.tsx (nothing selected):
/// exactly five tiles — Edit · Music · Text · Cut Lord · Captions — as solid
/// #17171b tiles (70px tall, 13px radius) with a bare icon over a 10.5px label.
/// Cut Lord is the accent tool (purple icon #b79bff).
class ToolDock extends StatelessWidget {
  final bool hasSelection; // reserved for the selected-clip toolbar (next milestone)
  final VoidCallback onEdit; // select main clip, else import
  final VoidCallback onMusic;
  final VoidCallback onText;
  final VoidCallback onCutLord;
  final VoidCallback onCaptions;

  const ToolDock({
    super.key,
    required this.hasSelection,
    required this.onEdit,
    required this.onMusic,
    required this.onText,
    required this.onCutLord,
    required this.onCaptions,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Ec.bg,
        border: Border(top: BorderSide(color: Ec.hair)),
      ),
      padding: const EdgeInsets.fromLTRB(10, 8, 10, 10),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _Tile(icon: Icons.content_cut, label: 'Edit', onTap: onEdit),
          const SizedBox(width: 7),
          _Tile(icon: Icons.music_note, label: 'Music', onTap: onMusic),
          const SizedBox(width: 7),
          _Tile(icon: Icons.text_fields, label: 'Text', onTap: onText),
          const SizedBox(width: 7),
          _Tile(icon: Icons.bolt, label: 'Cut Lord', onTap: onCutLord, accent: true),
          const SizedBox(width: 7),
          _Tile(icon: Icons.closed_caption, label: 'Captions', onTap: onCaptions),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool accent;
  const _Tile({required this.icon, required this.label, required this.onTap, this.accent = false});

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 62),
        child: GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Container(
            height: 70,
            decoration: BoxDecoration(
              color: Ec.card2, // #17171b
              borderRadius: BorderRadius.circular(13),
            ),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                Icon(icon, size: 23, color: accent ? const Color(0xFFB79BFF) : const Color(0xFFF1F1F4)),
                const SizedBox(height: 6),
                Text(
                  label,
                  style: TextStyle(
                    fontSize: 10.5,
                    fontWeight: FontWeight.w500,
                    color: accent ? const Color(0xFFB79BFF) : const Color(0xFFD9D9DE),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
