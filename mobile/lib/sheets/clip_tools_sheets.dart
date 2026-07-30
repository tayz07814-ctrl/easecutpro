import 'dart:typed_data';

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

/// Per-clip Zoom — a centred punch-in. Implemented on the editor side as a
/// symmetric crop so it reuses the existing crop preview + export path. Emits the
/// zoom level (≥1.0); 1.0× = no crop.
class ZoomSheet extends StatefulWidget {
  final double initial;
  final ValueChanged<double> onChanged;
  const ZoomSheet({super.key, required this.initial, required this.onChanged});

  @override
  State<ZoomSheet> createState() => _ZoomSheetState();
}

class _ZoomSheetState extends State<ZoomSheet> {
  static const _presets = [1.0, 1.2, 1.5, 2.0, 2.5, 3.0];
  late double _v = widget.initial.clamp(1.0, 3.0);

  void _set(double v) {
    setState(() => _v = double.parse(v.clamp(1.0, 3.0).toStringAsFixed(2)));
    widget.onChanged(_v);
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Zoom',
      heightFactor: 0.52,
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
              child: Slider(min: 1.0, max: 3.0, value: _v, onChanged: _set),
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
            const SizedBox(height: 12),
            const Text('A centred punch-in on this clip. Replaces any aspect crop set here.',
                style: TextStyle(color: Ec.textFaint, fontSize: 11.5)),
          ],
        ),
      ),
    );
  }
}

/// Per-clip visual Crop — drag the corners of a live crop box over a frame of the
/// clip (rule-of-thirds grid), or snap to an aspect preset. Emits edge fractions
/// live via [onChange] as the box is dragged; the editor applies them to the
/// preview immediately. Free-form by default; presets centre a fixed aspect.
class CropSheet extends StatefulWidget {
  final double sourceAspect; // w / h of the source frame
  final Uint8List? frame; // optional preview JPEG (nearest thumbnail)
  final double initL, initT, initR, initB;
  final void Function(double l, double t, double r, double b) onChange;
  const CropSheet({
    super.key,
    required this.sourceAspect,
    this.frame,
    this.initL = 0,
    this.initT = 0,
    this.initR = 0,
    this.initB = 0,
    required this.onChange,
  });

  @override
  State<CropSheet> createState() => _CropSheetState();
}

class _CropSheetState extends State<CropSheet> {
  late double _l = widget.initL, _t = widget.initT, _r = widget.initR, _b = widget.initB;
  static const _minVis = 0.12; // never crop below 12% of a dimension

  // label → target aspect (w/h). -1 = Free (leave the box as-is), 0 = Original.
  static const _presets = <String, double>{
    'Free': -1,
    'Original': 0,
    '1:1': 1.0,
    '9:16': 9 / 16,
    '16:9': 16 / 9,
    '4:5': 4 / 5,
    '3:4': 3 / 4,
  };

  void _emit() => widget.onChange(_l, _t, _r, _b);
  void _apply(VoidCallback f) {
    setState(f);
    _emit();
  }

  void _snap(double ta) {
    if (ta < 0) return; // Free
    final sa = widget.sourceAspect > 0 ? widget.sourceAspect : 16 / 9;
    List<double> c;
    if (ta == 0 || (ta - sa).abs() < 0.001) {
      c = const [0, 0, 0, 0];
    } else if (ta < sa) {
      final vw = ta / sa;
      final m = (1 - vw) / 2;
      c = [m, 0, m, 0];
    } else {
      final vh = sa / ta;
      final m = (1 - vh) / 2;
      c = [0, m, 0, m];
    }
    _apply(() {
      _l = c[0];
      _t = c[1];
      _r = c[2];
      _b = c[3];
    });
  }

  void _dragCorner(bool left, bool top, Offset delta, double mw, double mh) {
    _apply(() {
      final dx = delta.dx / mw, dy = delta.dy / mh;
      if (left) {
        _l = (_l + dx).clamp(0.0, 1 - _r - _minVis).toDouble();
      } else {
        _r = (_r - dx).clamp(0.0, 1 - _l - _minVis).toDouble();
      }
      if (top) {
        _t = (_t + dy).clamp(0.0, 1 - _b - _minVis).toDouble();
      } else {
        _b = (_b - dy).clamp(0.0, 1 - _t - _minVis).toDouble();
      }
    });
  }

  void _move(Offset delta, double mw, double mh) {
    _apply(() {
      final dx = (delta.dx / mw).clamp(-_l, _r).toDouble();
      final dy = (delta.dy / mh).clamp(-_t, _b).toDouble();
      _l += dx;
      _r -= dx;
      _t += dy;
      _b -= dy;
    });
  }

  Widget _handle(Offset c, bool left, bool top, double mw, double mh) {
    const s = 30.0;
    return Positioned(
      left: c.dx - s / 2,
      top: c.dy - s / 2,
      width: s,
      height: s,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onPanUpdate: (d) => _dragCorner(left, top, d.delta, mw, mh),
        child: Center(
          child: Container(
            width: 16,
            height: 16,
            decoration: BoxDecoration(
              color: Ec.indigo,
              shape: BoxShape.circle,
              border: Border.all(color: Colors.white, width: 2),
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Crop',
      heightFactor: 0.64,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              child: LayoutBuilder(
                builder: (_, bc) {
                  final aw = bc.maxWidth, ah = bc.maxHeight;
                  final aspect = widget.sourceAspect > 0 ? widget.sourceAspect : 16 / 9;
                  double mw = aw, mh = aw / aspect;
                  if (mh > ah) {
                    mh = ah;
                    mw = ah * aspect;
                  }
                  final ox = (aw - mw) / 2, oy = (ah - mh) / 2;
                  final media = Rect.fromLTWH(ox, oy, mw, mh);
                  final crop = Rect.fromLTRB(
                    ox + _l * mw,
                    oy + _t * mh,
                    ox + (1 - _r) * mw,
                    oy + (1 - _b) * mh,
                  );
                  return Stack(
                    children: [
                      Positioned.fromRect(
                        rect: media,
                        child: widget.frame != null
                            ? Image.memory(widget.frame!, fit: BoxFit.fill, gaplessPlayback: true)
                            : Container(
                                color: Ec.chip,
                                alignment: Alignment.center,
                                child: const Icon(Icons.crop, size: 34, color: Ec.textFaint),
                              ),
                      ),
                      Positioned.fill(child: CustomPaint(painter: _CropPainter(media, crop))),
                      // move the whole box
                      Positioned.fromRect(
                        rect: crop,
                        child: GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onPanUpdate: (d) => _move(d.delta, mw, mh),
                        ),
                      ),
                      _handle(crop.topLeft, true, true, mw, mh),
                      _handle(crop.topRight, false, true, mw, mh),
                      _handle(crop.bottomLeft, true, false, mw, mh),
                      _handle(crop.bottomRight, false, false, mw, mh),
                    ],
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
            SizedBox(
              height: 40,
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  for (final e in _presets.entries)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: GestureDetector(
                        onTap: () => _snap(e.value),
                        child: Container(
                          padding: const EdgeInsets.symmetric(horizontal: 14),
                          alignment: Alignment.center,
                          decoration: BoxDecoration(
                            color: Ec.chip,
                            borderRadius: BorderRadius.circular(9),
                            border: Border.all(color: Colors.white.withValues(alpha: 0.07)),
                          ),
                          child: Text(e.key,
                              style: const TextStyle(
                                  color: Ec.textDim, fontSize: 12.5, fontWeight: FontWeight.w600)),
                        ),
                      ),
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            const Text('Drag the corners to crop, or tap an aspect. Applies to this clip.',
                style: TextStyle(color: Ec.textFaint, fontSize: 11.5)),
          ],
        ),
      ),
    );
  }
}

/// Paints the dim mask outside the crop box plus its border + rule-of-thirds grid.
class _CropPainter extends CustomPainter {
  final Rect media;
  final Rect crop;
  _CropPainter(this.media, this.crop);

  @override
  void paint(Canvas canvas, Size size) {
    final dim = Paint()..color = Colors.black.withValues(alpha: 0.5);
    canvas.drawPath(
      Path()
        ..addRect(media)
        ..addRect(crop)
        ..fillType = PathFillType.evenOdd,
      dim,
    );
    canvas.drawRect(
      crop,
      Paint()
        ..color = Colors.white
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2,
    );
    final grid = Paint()
      ..color = Colors.white.withValues(alpha: 0.35)
      ..strokeWidth = 1;
    for (var i = 1; i < 3; i++) {
      final x = crop.left + crop.width * i / 3;
      canvas.drawLine(Offset(x, crop.top), Offset(x, crop.bottom), grid);
      final y = crop.top + crop.height * i / 3;
      canvas.drawLine(Offset(crop.left, y), Offset(crop.right, y), grid);
    }
  }

  @override
  bool shouldRepaint(covariant _CropPainter old) => old.crop != crop || old.media != media;
}
