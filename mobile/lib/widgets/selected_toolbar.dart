import 'package:flutter/material.dart';

import '../theme.dart';

/// Selected-clip toolbar (MobileTools.tsx video-clip toolbar) — a collapse chevron
/// then a horizontally-scrollable row of clip tools. Actions are stubbed with a note
/// for now (Split/Crop/Speed/… wire to the timeline engine in the next build).
class SelectedToolbar extends StatelessWidget {
  final VoidCallback onCollapse;
  final void Function(String tool) onTool;
  final VoidCallback onDelete;
  const SelectedToolbar({
    super.key,
    required this.onCollapse,
    required this.onTool,
    required this.onDelete,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: const BoxDecoration(
        color: Ec.bg,
        border: Border(top: BorderSide(color: Ec.hair)),
      ),
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 10),
      child: Row(
        children: [
          GestureDetector(
            onTap: onCollapse,
            child: Container(
              width: 50,
              height: 62,
              decoration: BoxDecoration(color: const Color(0xFF1D1D22), borderRadius: BorderRadius.circular(13)),
              child: const Icon(Icons.keyboard_arrow_down, color: Color(0xFFCFCFD4), size: 22),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: Row(
                children: [
                  _tool(Icons.content_cut, 'Split', () => onTool('Split')), // ]|[ approximated
                  _tool(Icons.crop, 'Crop', () => onTool('Crop')),
                  _tool(Icons.speed, 'Speed', () => onTool('Speed')),
                  _tool(Icons.volume_up, 'Volume', () => onTool('Volume')),
                  _tool(Icons.tune, 'Adjust', () => onTool('Adjust')),
                  _tool(Icons.animation, 'Animation', () => onTool('Animation')),
                  _tool(Icons.graphic_eq, 'Extract', () => onTool('Extract')),
                  _tool(Icons.picture_in_picture_alt, 'Overlay', () => onTool('Overlay')),
                  _tool(Icons.delete_outline, 'Delete', onDelete, danger: true),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _tool(IconData icon, String label, VoidCallback onTap, {bool danger = false}) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 58,
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 22, color: danger ? const Color(0xFFFF8A9A) : const Color(0xFFF1F1F4)),
            const SizedBox(height: 6),
            Text(label,
                style: TextStyle(
                    fontSize: 11,
                    fontWeight: FontWeight.w500,
                    color: danger ? const Color(0xFFFF8A9A) : const Color(0xFFD9D9DE))),
          ],
        ),
      ),
    );
  }
}
