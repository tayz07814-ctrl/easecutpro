import 'package:flutter/material.dart';

import '../editor/cutlord.dart';
import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// Retake Cleaner — one action (like web 0.01). Finds silences, fillers and bad
/// takes on-device and proposes cuts for review. Runs the real pipeline
/// (extract audio → transcribe → judge → cut) via [onRun].
class CutLordSheet extends StatefulWidget {
  final VoidCallback onOpenSilence;
  final void Function(CutLordModel model, bool cutSilence) onRun;
  const CutLordSheet({super.key, required this.onOpenSilence, required this.onRun});

  @override
  State<CutLordSheet> createState() => _CutLordSheetState();
}

class _CutLordSheetState extends State<CutLordSheet> {
  bool _smartSilence = true;

  void _run() {
    Navigator.of(context).pop();
    widget.onRun(cutLordRetake, _smartSilence);
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      heightFactor: 0.58,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
            child: Row(
              children: [
                const Text('Retake Cleaner',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Ec.text)),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Ec.indigo.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: const Text('BETA',
                      style: TextStyle(color: Ec.indigoText, fontSize: 9, fontWeight: FontWeight.w700)),
                ),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const Text('Cleans up your video — removes silences, filler words and bad takes, then lets you review the cuts before applying.',
                      style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13, height: 1.5)),
                  const SizedBox(height: 18),
                  GestureDetector(
                    onTap: _run,
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Ec.indigo,
                        borderRadius: BorderRadius.circular(11),
                        boxShadow: [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 16, offset: const Offset(0, 4))],
                      ),
                      child: const Text('Find silences & bad takes',
                          style: TextStyle(color: Colors.white, fontSize: 14, fontWeight: FontWeight.w600)),
                    ),
                  ),
                  const SizedBox(height: 16),
                  GestureDetector(
                    onTap: widget.onOpenSilence,
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(borderRadius: BorderRadius.circular(10), border: Border.all(color: Ec.border)),
                      child: const Text('Silence Settings', style: TextStyle(color: Ec.textDim, fontSize: 13.5)),
                    ),
                  ),
                  const SizedBox(height: 6),
                  EcRow(
                    label: 'Smart Silence Cutter',
                    trailing: EcToggle(value: _smartSilence, onChanged: (v) => setState(() => _smartSilence = v)),
                  ),
                  const SizedBox(height: 12),
                  const Text('Runs on your device: extracts the audio, transcribes it, and an AI picks the cuts. Takes ~30–60s.',
                      style: TextStyle(color: Ec.textFaint, fontSize: 11.5, height: 1.5)),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
