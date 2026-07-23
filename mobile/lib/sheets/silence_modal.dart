import 'package:flutter/material.dart';

import '../editor/silence_settings.dart';
import '../theme.dart';
import '../widgets/controls.dart';

/// Silence Settings (SilenceSettingsModal.tsx) — a centered modal card with presets
/// + custom sliders. Shown via showDialog. Values are local until wired to the store.
class SilenceModal extends StatefulWidget {
  const SilenceModal({super.key});

  @override
  State<SilenceModal> createState() => _SilenceModalState();
}

class _SilenceModalState extends State<SilenceModal> {
  String _preset = 'Balanced';
  double _trim = SilenceSettings.trimS;
  double _keep = SilenceSettings.keepS;
  double _strict = 0.7;
  bool _breaths = true;
  bool _blend = false;
  double _overlap = 20;

  static const _presets = ['Gentle', 'Balanced', 'Aggressive', 'Custom'];

  @override
  Widget build(BuildContext context) {
    return Dialog(
      backgroundColor: Ec.card,
      insetPadding: const EdgeInsets.symmetric(horizontal: 20, vertical: 40),
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(10),
        side: BorderSide(color: Colors.white.withValues(alpha: 0.1)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(22),
        child: SingleChildScrollView(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  const Text('Silence Settings',
                      style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600, color: Ec.text)),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => Navigator.of(context).pop(),
                    child: const Icon(Icons.close, size: 20, color: Ec.textMute),
                  ),
                ],
              ),
              const SizedBox(height: 4),
              const Text('Controls silence detection only — retake detection is unaffected.',
                  style: TextStyle(color: Ec.textMute, fontSize: 12)),
              const SizedBox(height: 16),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final p in _presets)
                    EcChip(label: p, active: _preset == p, onTap: () => setState(() => _preset = p)),
                ],
              ),
              const SizedBox(height: 16),
              EcSliderRow(
                label: 'Trim pauses longer than',
                valueLabel: '${_trim.toStringAsFixed(2)}s',
                value: _trim,
                min: 0.05,
                max: 2,
                onChanged: (v) => setState(() { _trim = v; _preset = 'Custom'; }),
              ),
              EcSliderRow(
                label: 'Pause to keep at each cut',
                valueLabel: '${_keep.toStringAsFixed(2)}s',
                value: _keep,
                min: 0,
                max: 0.4,
                onChanged: (v) => setState(() { _keep = v; _preset = 'Custom'; }),
              ),
              EcSliderRow(
                label: 'Silence detection strictness',
                valueLabel: _strict < 0.62 ? 'Gentle' : _strict < 0.74 ? 'Standard' : _strict < 0.85 ? 'Strict' : 'Very strict',
                value: _strict,
                min: 0.5,
                max: 0.9,
                onChanged: (v) => setState(() { _strict = v; _preset = 'Custom'; }),
              ),
              EcRow(label: 'Remove breaths', trailing: EcToggle(value: _breaths, onChanged: (v) => setState(() => _breaths = v))),
              EcRow(label: 'Blend audio at cuts (overlap)', trailing: EcToggle(value: _blend, onChanged: (v) => setState(() => _blend = v))),
              if (_blend)
                EcSliderRow(
                  label: 'Overlap amount',
                  valueLabel: '${_overlap.round()}ms',
                  value: _overlap,
                  min: 0,
                  max: 60,
                  onChanged: (v) => setState(() => _overlap = v),
                ),
              const SizedBox(height: 16),
              Row(
                children: [
                  GestureDetector(
                    onTap: () => setState(() { _preset = 'Balanced'; _trim = 0.35; _keep = 0.08; _strict = 0.7; }),
                    child: const Text('Reset to default', style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
                  ),
                  const Spacer(),
                  GestureDetector(
                    onTap: () => Navigator.of(context).pop(),
                    child: const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                      child: Text('Cancel', style: TextStyle(color: Ec.textMute, fontSize: 13)),
                    ),
                  ),
                  GestureDetector(
                    onTap: () {
                      SilenceSettings.apply(trimS: _trim, keepS: _keep);
                      Navigator.of(context).pop();
                    },
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 9),
                      decoration: BoxDecoration(color: Ec.indigo, borderRadius: BorderRadius.circular(9)),
                      child: const Text('Apply', style: TextStyle(color: Colors.white, fontSize: 13, fontWeight: FontWeight.w600)),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
