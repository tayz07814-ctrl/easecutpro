import 'package:flutter/material.dart';

import '../editor/cutlord.dart';
import '../editor/silence_settings.dart';
import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// EaseTools — the single panel every AI/automation tool lives under:
/// Speech Cleaner, Zoom, Overlays and Variations. (Replaces the old "Cut Lord"
/// sheet; the judge model constant keeps its name internally.)
class EaseToolsSheet extends StatefulWidget {
  final VoidCallback onOpenSilence;

  /// Speech Cleaner — transcribe, judge, then cut (review sheet in between).
  final void Function(CutLordModel model, bool cutSilence) onRun;

  /// Silence-only pass (Silero), no transcription / judge.
  final VoidCallback onCleanSilence;
  final VoidCallback onZoom;
  final VoidCallback onOverlays;
  final VoidCallback onVariations;

  const EaseToolsSheet({
    super.key,
    required this.onOpenSilence,
    required this.onRun,
    required this.onCleanSilence,
    required this.onZoom,
    required this.onOverlays,
    required this.onVariations,
  });

  @override
  State<EaseToolsSheet> createState() => _EaseToolsSheetState();
}

class _EaseToolsSheetState extends State<EaseToolsSheet> {
  bool _autoApply = SilenceSettings.autoApplyCuts;

  void _run() {
    SilenceSettings.autoApplyCuts = _autoApply;
    Navigator.of(context).pop();
    widget.onRun(cutLordRetake, true);
  }

  void _cleanSilence() {
    SilenceSettings.autoApplyCuts = _autoApply;
    Navigator.of(context).pop();
    widget.onCleanSilence();
  }

  /// One tool row: icon tile + title//blurb + chevron.
  Widget _tool(IconData icon, String title, String blurb, VoidCallback onTap, {bool accent = false}) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        margin: const EdgeInsets.only(bottom: 10),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          color: const Color(0xFF101015),
          borderRadius: BorderRadius.circular(12),
          border: Border.all(
            color: accent ? Ec.indigo.withValues(alpha: 0.45) : Colors.white.withValues(alpha: 0.07),
          ),
        ),
        child: Row(
          children: [
            Container(
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: (accent ? Ec.indigo : Colors.white).withValues(alpha: accent ? 0.16 : 0.06),
                borderRadius: BorderRadius.circular(10),
              ),
              child: Icon(icon, size: 19, color: accent ? Ec.indigoText : Ec.text),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title,
                      style: const TextStyle(color: Ec.text, fontSize: 13.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 2),
                  Text(blurb,
                      style: const TextStyle(color: Ec.textFaint, fontSize: 11.5, height: 1.35)),
                ],
              ),
            ),
            const Icon(Icons.chevron_right, size: 18, color: Ec.textFaint),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      heightFactor: 0.72,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
            child: Row(
              children: [
                const Icon(Icons.bolt, size: 18, color: Ec.indigoText),
                const SizedBox(width: 7),
                const Text('EaseTools',
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
                  // --- Speech Cleaner ---------------------------------------
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: Text('SPEECH CLEANER',
                        style: TextStyle(
                            color: Ec.textFaint, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.6)),
                  ),
                  GestureDetector(
                    onTap: _run,
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 14),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Ec.indigo,
                        borderRadius: BorderRadius.circular(11),
                        boxShadow: [
                          BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 16, offset: const Offset(0, 4))
                        ],
                      ),
                      child: const Text('Clean speech — silences, fillers & bad takes',
                          style: TextStyle(color: Colors.white, fontSize: 13.5, fontWeight: FontWeight.w600)),
                    ),
                  ),
                  const SizedBox(height: 10),
                  GestureDetector(
                    onTap: _cleanSilence,
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 13),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        borderRadius: BorderRadius.circular(11),
                        color: const Color(0xFF123331),
                        border: Border.all(color: const Color(0xFF4FD1C5).withValues(alpha: 0.5)),
                      ),
                      child: const Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Icon(Icons.volume_off, size: 16, color: Color(0xFF4FD1C5)),
                          SizedBox(width: 7),
                          Text('Clean Silence only (Silero)',
                              style: TextStyle(color: Color(0xFFCDEFEB), fontSize: 13, fontWeight: FontWeight.w600)),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 6),
                  // Noise removal toggle for Silero VAD.
                  EcRow(
                    label: 'Noise removal +40 dB gain',
                    trailing: EcToggle(
                      value: SilenceSettings.noiseRemoval,
                      onChanged: (v) => setState(() => SilenceSettings.noiseRemoval = v),
                    ),
                  ),
                  Text(
                    'Removes stationary noise then boosts the signal before Silero VAD. '
                    'Disable for raw VAD on the original audio.',
                    style: const TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.4),
                  ),
                  const SizedBox(height: 8),
                  // Review-before-apply. Default OFF = cuts are staged on the
                  // timeline for inspection instead of committing straight away.
                  EcRow(
                    label: 'Apply cuts immediately',
                    trailing: EcToggle(value: _autoApply, onChanged: (v) => setState(() => _autoApply = v)),
                  ),
                  Text(
                    _autoApply
                        ? 'Cuts commit as soon as they are found.'
                        : 'Cuts are previewed on the timeline first — inspect them, then Apply or Discard.',
                    style: const TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.4),
                  ),
                  const SizedBox(height: 8),
                  GestureDetector(
                    onTap: widget.onOpenSilence,
                    child: Container(
                      padding: const EdgeInsets.symmetric(vertical: 11),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                          borderRadius: BorderRadius.circular(10), border: Border.all(color: Ec.border)),
                      child: const Text('Silence Settings', style: TextStyle(color: Ec.textDim, fontSize: 13)),
                    ),
                  ),
                  const SizedBox(height: 18),
                  // --- The rest of the toolbox ------------------------------
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: Text('MORE TOOLS',
                        style: TextStyle(
                            color: Ec.textFaint, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.6)),
                  ),
                  _tool(Icons.zoom_in, 'Zoom', 'Auto punch-ins on the strongest moments.', () {
                    Navigator.of(context).pop();
                    widget.onZoom();
                  }),
                  _tool(Icons.photo_library_outlined, 'Overlays', 'Drop images / B-roll over the video.', () {
                    Navigator.of(context).pop();
                    widget.onOverlays();
                  }),
                  _tool(Icons.shuffle, 'Variations', 'Recut the same footage into a new edit.', () {
                    Navigator.of(context).pop();
                    widget.onVariations();
                  }),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
