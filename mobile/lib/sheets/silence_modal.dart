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

  static const _presets = ['Conservative', 'Balanced', 'Aggressive'];
  static const _blurbs = {
    'Conservative': 'Only trims longer pauses; keeps a natural, relaxed rhythm.',
    'Balanced': 'Trims most dead air while keeping a little breathing room.',
    'Aggressive': 'Gapless jump cuts — the next word starts the instant the last ends.',
    'Custom': 'Your own mix of the settings below.',
  };

  bool _eq(double a, double b) => (a - b).abs() < 1e-6;
  String get _preset {
    if (_eq(_thr, 0.65) && _eq(_gap, 0.6) && _eq(_padBefore, 0.15) && _eq(_padAfter, 0.2) && _eq(_edge, 0) && !_breaths) return 'Conservative';
    if (_eq(_thr, 0.75) && _eq(_gap, 0.05) && _eq(_padBefore, 0) && _eq(_padAfter, 0) && _eq(_edge, 0.05) && _breaths) return 'Aggressive';
    if (_eq(_thr, 0.75) && _eq(_gap, 0.3) && _eq(_padBefore, 0.1) && _eq(_padAfter, 0.12) && _eq(_edge, 0) && !_breaths) return 'Balanced';
    return 'Custom';
  }

  void _applyPreset(String id) {
    setState(() {
      switch (id) {
        case 'Conservative':
          _thr = 0.65; _gap = 0.6; _padBefore = 0.15; _padAfter = 0.2; _edge = 0; _breaths = false;
          break;
        case 'Aggressive':
          _thr = 0.75; _gap = 0.05; _padBefore = 0; _padAfter = 0; _edge = 0.05; _breaths = true;
          break;
        default: // Balanced
          _thr = 0.75; _gap = 0.3; _padBefore = 0.1; _padAfter = 0.12; _edge = 0; _breaths = false;
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
                  if (cur == 'Custom') EcChip(label: 'Custom', active: true, onTap: () {}),
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
              const Text('Strictness, breaths and edge trim match the desktop app; the on-device cut uses the pause and pad values now, the rest when on-device voice detection lands.',
                  style: TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.4)),
              const SizedBox(height: 16),
              Row(
                children: [
                  GestureDetector(
                    onTap: () => _applyPreset('Balanced'),
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
