import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Captions sheet (MobileEditor.tsx CaptionsSheet). Style cards + Generate button.
/// Generation wires to the transcript/captions backend in the next build.
class CaptionsSheet extends StatefulWidget {
  final void Function(String style) onGenerate;
  const CaptionsSheet({super.key, required this.onGenerate});

  @override
  State<CaptionsSheet> createState() => _CaptionsSheetState();
}

class _CaptionsSheetState extends State<CaptionsSheet> {
  String _style = 'clean';

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Captions',
      heightFactor: 0.62,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 2, 16, 20),
        children: [
          const Text('STYLE',
              style: TextStyle(
                  color: Ec.textMute, fontSize: 11.5, fontWeight: FontWeight.w700, letterSpacing: 0.3)),
          const SizedBox(height: 10),
          Row(
            children: [
              _styleCard('clean', 'Clean', 'White text, black outline'),
              const SizedBox(width: 10),
              _styleCard('boxed', 'Boxed', 'White text on a black bar'),
            ],
          ),
          const SizedBox(height: 18),
          GestureDetector(
            onTap: () {
              Navigator.of(context).pop();
              widget.onGenerate(_style);
            },
            child: Container(
              height: 50,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: Ec.gradient,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [BoxShadow(color: Ec.accentA.withValues(alpha: 0.32), blurRadius: 18, offset: const Offset(0, 6))],
              ),
              child: const Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(Icons.closed_caption, color: Colors.white, size: 19),
                  SizedBox(width: 8),
                  Text('Generate captions',
                      style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w700)),
                ],
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Adds subtitle clips from your speech. If you’ve run Cut Lord it reuses that transcript — otherwise it transcribes first, then captions.',
            style: TextStyle(color: Ec.textMute, fontSize: 12.5, height: 1.6),
          ),
        ],
      ),
    );
  }

  Widget _styleCard(String id, String label, String hint) {
    final on = _style == id;
    return Expanded(
      child: GestureDetector(
        onTap: () => setState(() => _style = id),
        child: Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: on ? const Color(0xFF7C5CFF).withValues(alpha: 0.14) : Ec.card2,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: on ? const Color(0xFF7C5CFF) : Ec.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                height: 34,
                decoration: BoxDecoration(
                  color: id == 'boxed' ? Colors.black : const Color(0xFF201F28),
                  borderRadius: BorderRadius.circular(8),
                ),
                alignment: Alignment.center,
                child: Container(
                  padding: id == 'boxed' ? const EdgeInsets.symmetric(horizontal: 7, vertical: 1) : null,
                  color: id == 'boxed' ? Colors.black : null,
                  child: const Text('Aa',
                      style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w800)),
                ),
              ),
              const SizedBox(height: 9),
              Text(label,
                  style: TextStyle(
                      color: on ? const Color(0xFFC9B8FF) : Ec.text,
                      fontSize: 13,
                      fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Text(hint, style: const TextStyle(color: Ec.textMute, fontSize: 11)),
            ],
          ),
        ),
      ),
    );
  }
}
