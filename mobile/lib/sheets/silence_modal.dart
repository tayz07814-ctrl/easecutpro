import 'package:flutter/material.dart';

import '../editor/silence_settings.dart';
import '../theme.dart';
import '../widgets/controls.dart';

/// Silence Settings — mirrors main's SilenceMasterySettingsModal: four fixed
/// presets (Natural Rhythm / No Chill / Flash / Cut Throat) plus the Mad
/// Scientist lever that unlocks the sliders for hand-tuning. Values persist to
/// SilenceSettings on Apply and drive the native Silero engine — the same
/// engine, presets and semantics as the web app.
class SilenceModal extends StatefulWidget {
  const SilenceModal({super.key});

  @override
  State<SilenceModal> createState() => _SilenceModalState();
}

class _SilenceModalState extends State<SilenceModal> {
  double _minSil = SilenceSettings.minSilenceS;
  double _padL = SilenceSettings.padLeftMs.toDouble();
  double _padR = SilenceSettings.padRightMs.toDouble();
  double _trimL = SilenceSettings.trimLeftMs.toDouble();
  double _trimR = SilenceSettings.trimRightMs.toDouble();
  bool _breath = SilenceSettings.breathRefine;
  bool _mad = SilenceSettings.madScientist;
  double _overlap = SilenceSettings.seamOverlapMs.toDouble();

  // SILENCE_MASTERY_PRESETS, verbatim.
  static const _presets = ['Natural Rhythm', 'No Chill', 'Flash', 'Cut Throat'];
  static const _blurbs = {
    'Natural Rhythm': 'Gentle: keeps a breath at both edges, never trims into speech.',
    'No Chill': 'Tight cuts into the sentence ending and the next onset — no pads.',
    'Flash': 'The default: light trims + breath cleanup at sentence endings.',
    'Cut Throat': 'The hardest: 75ms off every ending, breath cleanup on top.',
    'Mad Scientist': 'Roll your own: unlock the sliders and tune every value by hand.',
  };

  bool _eq(double a, double b) => (a - b).abs() < 1e-9;
  String? get _preset {
    if (_mad) return null;
    if (_eq(_minSil, 0.25) && _padL == 50 && _padR == 100 && _trimL == 0 && _trimR == 0 && !_breath) return 'Natural Rhythm';
    if (_eq(_minSil, 0.15) && _padL == 0 && _padR == 0 && _trimL == 20 && _trimR == 50 && !_breath) return 'No Chill';
    if (_eq(_minSil, 0.15) && _padL == 0 && _padR == 0 && _trimL == 30 && _trimR == 10 && _breath) return 'Flash';
    if (_eq(_minSil, 0.15) && _padL == 0 && _padR == 0 && _trimL == 75 && _trimR == 15 && _breath) return 'Cut Throat';
    return null;
  }

  void _applyPreset(String id) {
    setState(() {
      _mad = false;
      switch (id) {
        case 'Natural Rhythm':
          _minSil = 0.25; _padL = 50; _padR = 100; _trimL = 0; _trimR = 0; _breath = false;
          break;
        case 'No Chill':
          _minSil = 0.15; _padL = 0; _padR = 0; _trimL = 20; _trimR = 50; _breath = false;
          break;
        case 'Cut Throat':
          _minSil = 0.15; _padL = 0; _padR = 0; _trimL = 75; _trimR = 15; _breath = true;
          break;
        default: // Flash — the default
          _minSil = 0.15; _padL = 0; _padR = 0; _trimL = 30; _trimR = 10; _breath = true;
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final cur = _preset;
    final blurbKey = _mad ? 'Mad Scientist' : (cur ?? 'Mad Scientist');
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
              const SizedBox(height: 12),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final p in _presets)
                    EcChip(label: p, active: !_mad && cur == p, onTap: () => _applyPreset(p)),
                ],
              ),
              const SizedBox(height: 8),
              Text(_blurbs[blurbKey] ?? '', style: const TextStyle(color: Ec.textMute, fontSize: 12, height: 1.4)),
              const SizedBox(height: 12),
              // Mad Scientist — the lever that unlocks the sliders.
              EcRow(
                label: 'Mad Scientist 🧪',
                trailing: EcToggle(value: _mad, onChanged: (v) => setState(() => _mad = v)),
              ),
              if (_mad) ...[
                EcSliderRow(
                  label: 'Min silence to remove',
                  valueLabel: '${_minSil.toStringAsFixed(2)}s',
                  value: _minSil,
                  min: 0.1,
                  max: 3,
                  onChanged: (v) => setState(() => _minSil = v),
                ),
                EcSliderRow(
                  label: 'Pad left of the gap',
                  valueLabel: '${_padL.round()}ms',
                  value: _padL,
                  min: 0,
                  max: 500,
                  onChanged: (v) => setState(() => _padL = (v / 10).round() * 10.0),
                ),
                EcSliderRow(
                  label: 'Pad right of the gap',
                  valueLabel: '${_padR.round()}ms',
                  value: _padR,
                  min: 0,
                  max: 500,
                  onChanged: (v) => setState(() => _padR = (v / 10).round() * 10.0),
                ),
                EcSliderRow(
                  label: 'Trim left (sentence ending)',
                  valueLabel: '${_trimL.round()}ms',
                  value: _trimL,
                  min: 0,
                  max: 500,
                  onChanged: (v) => setState(() => _trimL = (v / 5).round() * 5.0),
                ),
                EcSliderRow(
                  label: 'Trim right (next sentence start)',
                  valueLabel: '${_trimR.round()}ms',
                  value: _trimR,
                  min: 0,
                  max: 500,
                  onChanged: (v) => setState(() => _trimR = (v / 5).round() * 5.0),
                ),
                EcRow(
                  label: 'Breath cleanup (sentence endings)',
                  trailing: EcToggle(value: _breath, onChanged: (v) => setState(() => _breath = v)),
                ),
              ],
              EcRow(
                label: 'Blend audio at cuts (overlap)',
                trailing: EcToggle(value: _overlap > 0, onChanged: (v) => setState(() => _overlap = v ? 20 : 0)),
              ),
              if (_overlap > 0)
                EcSliderRow(
                  label: 'Overlap amount',
                  valueLabel: '${_overlap.round()}ms',
                  value: _overlap,
                  min: 0,
                  max: 60,
                  onChanged: (v) => setState(() => _overlap = v),
                ),
              const SizedBox(height: 8),
              const Text(
                  'Silero listens to your audio and finds every silent stretch. Pads KEEP silence at a cut\'s edges; trims cut PAST the detected edge into the sentence ending (left) or the next sentence\'s onset (right). Breath cleanup walks end-of-sentence exhales so cuts land where the voice stops.',
                  style: TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.4)),
              const SizedBox(height: 16),
              Row(
                children: [
                  GestureDetector(
                    onTap: () => _applyPreset('Flash'),
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
                      SilenceSettings.minSilenceS = _minSil;
                      SilenceSettings.padLeftMs = _padL.round();
                      SilenceSettings.padRightMs = _padR.round();
                      SilenceSettings.trimLeftMs = _trimL.round();
                      SilenceSettings.trimRightMs = _trimR.round();
                      SilenceSettings.breathRefine = _breath;
                      SilenceSettings.madScientist = _mad;
                      SilenceSettings.seamOverlapMs = _overlap.round();
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
