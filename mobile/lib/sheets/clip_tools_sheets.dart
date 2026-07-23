import 'package:flutter/material.dart';

import '../theme.dart';
import 'sheet_scaffold.dart';

/// Per-clip Speed. Live-updates via [onChanged] (preview reloads on the editor side).
class SpeedSheet extends StatefulWidget {
  final double initial;
  final ValueChanged<double> onChanged;
  const SpeedSheet({super.key, required this.initial, required this.onChanged});

  @override
  State<SpeedSheet> createState() => _SpeedSheetState();
}

class _SpeedSheetState extends State<SpeedSheet> {
  static const _presets = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 4.0];
  late double _v = widget.initial;

  void _set(double v) {
    setState(() => _v = double.parse(v.clamp(0.25, 4.0).toStringAsFixed(2)));
    widget.onChanged(_v);
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Speed',
      heightFactor: 0.5,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Text('${_v.toStringAsFixed(2)}×',
                  style: const TextStyle(color: Ec.text, fontSize: 30, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(height: 8),
            SliderTheme(
              data: SliderTheme.of(context).copyWith(
                activeTrackColor: Ec.accentB,
                inactiveTrackColor: Ec.chip,
                thumbColor: Colors.white,
                overlayShape: SliderComponentShape.noOverlay,
              ),
              child: Slider(min: 0.25, max: 4.0, value: _v, onChanged: _set),
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final p in _presets)
                  GestureDetector(
                    onTap: () => _set(p),
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                      decoration: BoxDecoration(
                        color: (_v - p).abs() < 0.01 ? Ec.indigoTint : Ec.chip,
                        borderRadius: BorderRadius.circular(9),
                        border: Border.all(
                            color: (_v - p).abs() < 0.01 ? Ec.indigo : Colors.white.withValues(alpha: 0.06)),
                      ),
                      child: Text('${p == p.roundToDouble() ? p.toStringAsFixed(0) : p}×',
                          style: TextStyle(
                              color: (_v - p).abs() < 0.01 ? Ec.indigoText : Ec.textDim,
                              fontSize: 13,
                              fontWeight: FontWeight.w600)),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Per-clip Volume / gain (0–200%).
class VolumeSheet extends StatefulWidget {
  final double initial; // 0..4 (unity = 1)
  final ValueChanged<double> onChanged;
  const VolumeSheet({super.key, required this.initial, required this.onChanged});

  @override
  State<VolumeSheet> createState() => _VolumeSheetState();
}

class _VolumeSheetState extends State<VolumeSheet> {
  late double _v = widget.initial.clamp(0.0, 2.0);

  void _set(double v) {
    setState(() => _v = v.clamp(0.0, 2.0));
    widget.onChanged(_v);
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Volume',
      heightFactor: 0.44,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Text('${(_v * 100).round()}%',
                  style: const TextStyle(color: Ec.text, fontSize: 30, fontWeight: FontWeight.w700)),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                GestureDetector(
                  onTap: () => _set(0),
                  child: Icon(_v <= 0 ? Icons.volume_off : Icons.volume_mute,
                      color: _v <= 0 ? const Color(0xFFFF8A9A) : Ec.textMute, size: 22),
                ),
                Expanded(
                  child: SliderTheme(
                    data: SliderTheme.of(context).copyWith(
                      activeTrackColor: Ec.green,
                      inactiveTrackColor: Ec.chip,
                      thumbColor: Colors.white,
                      overlayShape: SliderComponentShape.noOverlay,
                    ),
                    child: Slider(min: 0, max: 2, value: _v, onChanged: _set),
                  ),
                ),
                const Icon(Icons.volume_up, color: Ec.textMute, size: 22),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

/// Per-clip Crop to an aspect (centered). Emits edge fractions via [onPick].
class CropSheet extends StatelessWidget {
  final double sourceAspect; // w / h
  final void Function(double l, double t, double r, double b) onPick;
  const CropSheet({super.key, required this.sourceAspect, required this.onPick});

  static const _presets = <String, double>{
    'Original': 0,
    '1:1': 1.0,
    '4:5': 4 / 5,
    '9:16': 9 / 16,
    '16:9': 16 / 9,
    '3:4': 3 / 4,
  };

  List<double> _cropFor(double ta, double sa) {
    if (ta <= 0 || sa <= 0) return const [0, 0, 0, 0];
    if ((ta - sa).abs() < 0.001) return const [0, 0, 0, 0];
    if (ta < sa) {
      final vw = ta / sa;
      final c = (1 - vw) / 2;
      return [c, 0, c, 0];
    }
    final vh = sa / ta;
    final c = (1 - vh) / 2;
    return [0, c, 0, c];
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Crop / Aspect',
      heightFactor: 0.5,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 18),
        child: Wrap(
          spacing: 10,
          runSpacing: 10,
          children: [
            for (final e in _presets.entries)
              GestureDetector(
                onTap: () {
                  final c = _cropFor(e.value, sourceAspect);
                  onPick(c[0].toDouble(), c[1].toDouble(), c[2].toDouble(), c[3].toDouble());
                  Navigator.of(context).pop();
                },
                child: Container(
                  width: 96,
                  height: 62,
                  decoration: BoxDecoration(
                    color: Ec.chip,
                    borderRadius: BorderRadius.circular(10),
                    border: Border.all(color: Colors.white.withValues(alpha: 0.07)),
                  ),
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Icon(e.value == 0 ? Icons.crop_original : Icons.crop, size: 20, color: Ec.indigoText),
                      const SizedBox(height: 5),
                      Text(e.key,
                          style: const TextStyle(color: Ec.textDim, fontSize: 12, fontWeight: FontWeight.w600)),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
