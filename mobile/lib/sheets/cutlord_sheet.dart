import 'package:flutter/material.dart';

import '../editor/cutlord.dart';
import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// Cut Lord / Retake Cleaner (RetakeCleanerPanel.tsx) — pick a model to clean the
/// clip. Runs the real pipeline (extract audio → transcribe → judge → cut) via [onRun].
class CutLordSheet extends StatefulWidget {
  final VoidCallback onOpenSilence;
  final void Function(CutLordModel model, bool cutSilence) onRun;
  const CutLordSheet({super.key, required this.onOpenSilence, required this.onRun});

  @override
  State<CutLordSheet> createState() => _CutLordSheetState();
}

class _CutLordSheetState extends State<CutLordSheet> {
  bool _smartSilence = true;

  void _run(CutLordModel m) {
    Navigator.of(context).pop();
    widget.onRun(m, _smartSilence);
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      heightFactor: 0.62,
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
                  const Text('Cleans up your video — removes silences, filler and bad takes. Pick a brain:',
                      style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13, height: 1.5)),
                  const SizedBox(height: 16),
                  Row(
                    children: [
                      _model(cutLordRetake, const Color(0xFF6E6AE8)),
                      const SizedBox(width: 8),
                      _model(cutLordUltra, const Color(0xFFE8843A)),
                      const SizedBox(width: 8),
                      _model(cutLordPremium, const Color(0xFF2E9C6A)),
                    ],
                  ),
                  const SizedBox(height: 10),
                  const Text('Retake = Llama · Ultracut = DeepSeek · Premium = Claude',
                      textAlign: TextAlign.center, style: TextStyle(color: Ec.textFaint, fontSize: 11)),
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

  Widget _model(CutLordModel m, Color c) {
    return Expanded(
      child: GestureDetector(
        onTap: () => _run(m),
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: c,
            borderRadius: BorderRadius.circular(10),
            boxShadow: [BoxShadow(color: c.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 4))],
          ),
          child: Text(m.label,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }
}
