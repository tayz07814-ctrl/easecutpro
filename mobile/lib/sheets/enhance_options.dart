import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// The "enhance on import" choices, shared by the New Project wizard and Batch
/// cleaning so both ask for exactly the same things in exactly the same way.
class EnhanceOptions {
  final bool cutSilence;
  final bool autoCaptions;
  final bool autoZoom;
  const EnhanceOptions({
    this.cutSilence = true,
    this.autoCaptions = false,
    this.autoZoom = false,
  });

  bool get any => cutSilence || autoCaptions || autoZoom;

  EnhanceOptions copyWith({bool? cutSilence, bool? autoCaptions, bool? autoZoom}) => EnhanceOptions(
        cutSilence: cutSilence ?? this.cutSilence,
        autoCaptions: autoCaptions ?? this.autoCaptions,
        autoZoom: autoZoom ?? this.autoZoom,
      );

  /// Short "Cut silences · Auto zoom" line for a queue row / confirm button.
  String get summary {
    final on = [
      if (cutSilence) 'Cut silences',
      if (autoCaptions) 'Captions',
      if (autoZoom) 'Auto zoom',
    ];
    return on.isEmpty ? 'No enhancements' : on.join(' · ');
  }
}

/// One selectable enhancement card (emoji + title + blurb + check circle).
class EnhanceOptionCard extends StatelessWidget {
  final String emoji;
  final String title;
  final String subtitle;
  final bool on;
  final VoidCallback? onTap;
  const EnhanceOptionCard({
    super.key,
    required this.emoji,
    required this.title,
    required this.subtitle,
    required this.on,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF191A20),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(color: on ? Ec.indigo : Ec.border, width: on ? 1.5 : 1),
          boxShadow:
              on ? [BoxShadow(color: Ec.indigo.withValues(alpha: 0.18), blurRadius: 0, spreadRadius: 3)] : null,
        ),
        child: Row(
          children: [
            Text(emoji, style: const TextStyle(fontSize: 20)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(color: Ec.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(subtitle, style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 11.5)),
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

/// The three enhancement cards as a column — the shared body of the wizard's
/// "ENHANCE ON IMPORT" block and the batch options sheet.
class EnhanceOptionList extends StatelessWidget {
  final EnhanceOptions value;
  final ValueChanged<EnhanceOptions> onChanged;
  const EnhanceOptionList({super.key, required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        EnhanceOptionCard(
          emoji: '✂️',
          title: 'Cut silences & bad takes',
          subtitle: 'Trim dead air and retakes automatically.',
          on: value.cutSilence,
          onTap: () => onChanged(value.copyWith(cutSilence: !value.cutSilence)),
        ),
        const SizedBox(height: 8),
        EnhanceOptionCard(
          emoji: '💬',
          title: 'Auto captions',
          subtitle: 'Add styled subtitles from your speech.',
          on: value.autoCaptions,
          onTap: () => onChanged(value.copyWith(autoCaptions: !value.autoCaptions)),
        ),
        const SizedBox(height: 8),
        EnhanceOptionCard(
          emoji: '🔍',
          title: 'Auto zoom',
          subtitle: 'Punch in on the moments that matter.',
          on: value.autoZoom,
          onTap: () => onChanged(value.copyWith(autoZoom: !value.autoZoom)),
        ),
      ],
    );
  }
}

/// Ask which enhancements to run. Returns null if the user backs out.
Future<EnhanceOptions?> showEnhanceOptions(
  BuildContext context, {
  EnhanceOptions initial = const EnhanceOptions(),
  String title = 'Enhance these clips',
  String subtitle = 'Pick what runs automatically on every video in the queue.',
  String confirmLabel = 'Save',
}) {
  return showModalBottomSheet<EnhanceOptions>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => _EnhanceOptionsSheet(
      initial: initial,
      title: title,
      subtitle: subtitle,
      confirmLabel: confirmLabel,
    ),
  );
}

class _EnhanceOptionsSheet extends StatefulWidget {
  final EnhanceOptions initial;
  final String title;
  final String subtitle;
  final String confirmLabel;
  const _EnhanceOptionsSheet({
    required this.initial,
    required this.title,
    required this.subtitle,
    required this.confirmLabel,
  });

  @override
  State<_EnhanceOptionsSheet> createState() => _EnhanceOptionsSheetState();
}

class _EnhanceOptionsSheetState extends State<_EnhanceOptionsSheet> {
  late EnhanceOptions _v = widget.initial;

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: widget.title,
      heightFactor: 0.56,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
        children: [
          Text(widget.subtitle, style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
          const SizedBox(height: 16),
          EnhanceOptionList(value: _v, onChanged: (n) => setState(() => _v = n)),
          const SizedBox(height: 20),
          GestureDetector(
            onTap: () => Navigator.of(context).pop(_v),
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 15),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Ec.indigo,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [
                  BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6))
                ],
              ),
              child: Text(widget.confirmLabel,
                  style: const TextStyle(color: Colors.white, fontSize: 14.5, fontWeight: FontWeight.w600)),
            ),
          ),
          const SizedBox(height: 10),
          Center(
            child: Text(_v.summary, style: const TextStyle(color: Ec.textFaint, fontSize: 12)),
          ),
        ],
      ),
    );
  }
}
