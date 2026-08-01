import 'package:flutter/material.dart';

import '../editor/silence_settings.dart';
import '../theme.dart';
import '../widgets/controls.dart';

/// Silence Settings — mirrors web 0.01's redesigned sheet: three named presets
/// (Conservative / Balanced / Aggressive) that bundle the real fields, plus
/// custom sliders. Values persist to SilenceSettings on Apply.
class SilenceModal extends StatefulWidget {
  const SilenceModal({super.key});

  @override
  State<SilenceModal> createState() => _SilenceModalState();
}

class _SilenceModalState extends State<SilenceModal> {
  double _thr = SilenceSettings.speechThreshold;
  double _gap = SilenceSettings.minGapS;
  double _padBefore = SilenceSettings.padBeforeS;
  double _padAfter = SilenceSettings.padAfterS;
  double _edge = SilenceSettings.edgeTrimS;
  bool _breaths = SilenceSettings.removeBreaths;
  double _overlap = SilenceSettings.seamOverlapMs.toDouble();

  // The desktop Retake Final Boss FSMN presets (shared/retakefinalboss.ts). These map
  // to the padding / edge-trim / tail-trim (remove breaths) / overlap the native VAD
  // uses; the FSMN detector itself runs at fixed strictness, so the strictness + min-gap
  // sliders below only tune the transcript word-gap FALLBACK.
  static const _presets = ['Chill Talker', 'Just Right', 'No Chill', 'Espresso Shot', 'Mad Scientist'];
  static const _blurbs = {
    'Chill Talker': 'Leaves generous breathing room — relaxed, natural pacing.',
    'Just Right': 'Trims dead air but keeps a comfortable rhythm. (Default)',
    'No Chill': 'Tight cuts with a quiet-tail trim — punchy without clipping words.',
    'Espresso Shot': 'The tightest — gapless jump cuts, dead air removed.',
    'Mad Scientist': 'Your own mix of the settings below.',
  };

  bool _eq(double a, double b) => (a - b).abs() < 1e-6;
  String get _preset {
    final o = _overlap;
    if (_eq(_padBefore, 0.4) && _eq(_padAfter, 0.8) && _eq(_edge, 0) && !_breaths && _eq(o, 50)) return 'Chill Talker';
    if (_eq(_padBefore, 0.1) && _eq(_padAfter, 0.3) && _eq(_edge, 0) && !_breaths && _eq(o, 50)) return 'Just Right';
    if (_eq(_padBefore, 0.05) && _eq(_padAfter, 0.1) && _eq(_edge, 0) && _breaths && _eq(o, 50)) return 'No Chill';
    if (_eq(_padBefore, 0) && _eq(_padAfter, 0) && _eq(_edge, 0.05) && _breaths && _eq(o, 50)) return 'Espresso Shot';
    return 'Mad Scientist'; // the editable preset
  }

  void _applyPreset(String id) {
    setState(() {
      switch (id) {
        case 'Chill Talker':
          _padBefore = 0.4; _padAfter = 0.8; _edge = 0; _breaths = false; _overlap = 50;
          break;
        case 'No Chill':
          _padBefore = 0.05; _padAfter = 0.1; _edge = 0; _breaths = true; _overlap = 50;
          break;
        case 'Espresso Shot':
          _padBefore = 0; _padAfter = 0; _edge = 0.05; _breaths = true; _overlap = 50;
          break;
        case 'Mad Scientist':
          _padBefore = 0.1; _padAfter = 0.3; _edge = 0; _breaths = false; _overlap = 0;
          break;
        default: // Just Right
          _padBefore = 0.1; _padAfter = 0.3; _edge = 0; _breaths = false; _overlap = 50;
      }
    });
  }

  String get _strictLabel => _thr < 0.6 ? 'Gentle' : _thr < 0.72 ? 'Standard' : _thr < 0.85 ? 'Strict' : 'Very strict';

  @override
  Widget build(BuildContext context) {
    final cur = _preset;
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
                  for (final p in _presets) EcChip(label: p, active: cur == p, onTap: () => _applyPreset(p)),
                ],
              ),
              const SizedBox(height: 8),
              Text(_blurbs[cur] ?? '', style: const TextStyle(color: Ec.textMute, fontSize: 12, height: 1.4)),
              const SizedBox(height: 14),
              EcSliderRow(
                label: 'Trim pauses longer than',
                valueLabel: '${_gap.toStringAsFixed(2)}s',
                value: _gap,
                min: 0.05,
                max: 2,
                onChanged: (v) => setState(() => _gap = v),
              ),
              EcSliderRow(
                label: 'Pause kept at each cut',
                valueLabel: '${_padAfter.toStringAsFixed(2)}s',
                value: _padAfter,
                min: 0,
                max: 0.4,
                onChanged: (v) => setState(() => _padAfter = v),
              ),
              EcSliderRow(
                label: 'Lead into the next word',
                valueLabel: '${_padBefore.toStringAsFixed(2)}s',
                value: _padBefore,
                min: 0,
                max: 0.4,
                onChanged: (v) => setState(() => _padBefore = v),
              ),
              EcSliderRow(
                label: 'Silence detection strictness',
                valueLabel: _strictLabel,
                value: _thr,
                min: 0.5,
                max: 0.9,
                onChanged: (v) => setState(() => _thr = v),
              ),
              EcSliderRow(
                label: 'Tighten cut joins (edge trim)',
                valueLabel: '${(_edge * 1000).round()}ms',
                value: _edge,
                min: 0,
                max: 0.2,
                onChanged: (v) => setState(() => _edge = v),
              ),
              EcRow(label: 'Remove breaths', trailing: EcToggle(value: _breaths, onChanged: (v) => setState(() => _breaths = v))),
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
              const Text('Presets, padding, edge trim, remove-breaths and overlap match the desktop Retake Final Boss and drive the on-device FSMN voice detection. Strictness and min-gap tune the word-gap fallback used if the VAD can’t run.',
                  style: TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.4)),
              const SizedBox(height: 16),
              Row(
                children: [
                  GestureDetector(
                    onTap: () => _applyPreset('Just Right'),
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
                      SilenceSettings.speechThreshold = _thr;
                      SilenceSettings.minGapS = _gap;
                      SilenceSettings.padBeforeS = _padBefore;
                      SilenceSettings.padAfterS = _padAfter;
                      SilenceSettings.edgeTrimS = _edge;
                      SilenceSettings.removeBreaths = _breaths;
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
