import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/controls.dart';
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
  /// Current Ken Burns framing of the clip (scale + focus at both ends).
  final double fromScale, toScale, fromCx, fromCy, toCx, toCy;

  /// Live preview: every change reports the whole framing so the stage animates
  /// as the user drags.
  final void Function({
    required double fromScale,
    required double toScale,
    required double fromCx,
    required double fromCy,
    required double toCx,
    required double toCy,
  }) onChanged;

  const ZoomSheet({
    super.key,
    required this.fromScale,
    required this.toScale,
    required this.fromCx,
    required this.fromCy,
    required this.toCx,
    required this.toCy,
    required this.onChanged,
  });

  @override
  State<ZoomSheet> createState() => _ZoomSheetState();
}

/// Zoom is a MOVE, not a punch: the clip is framed at a start scale + focus and
/// glides to an end scale + focus over its own length. Equal start/end values
/// give the old static punch-in, so nothing is lost.
class _ZoomSheetState extends State<ZoomSheet> {
  late double _fs = widget.fromScale.clamp(1.0, 4.0);
  late double _ts = widget.toScale.clamp(1.0, 4.0);
  late double _fx = widget.fromCx.clamp(0.0, 1.0);
  late double _fy = widget.fromCy.clamp(0.0, 1.0);
  late double _tx = widget.toCx.clamp(0.0, 1.0);
  late double _ty = widget.toCy.clamp(0.0, 1.0);

  void _emit() => widget.onChanged(
        fromScale: _fs,
        toScale: _ts,
        fromCx: _fx,
        fromCy: _fy,
        toCx: _tx,
        toCy: _ty,
      );

  /// Preset moves, written as (startScale, endScale).
  static const _moves = <String, List<double>>{
    'None': [1.0, 1.0],
    'Punch in': [1.0, 1.6],
    'Punch out': [1.6, 1.0],
    'Slow push': [1.05, 1.35],
    'Slow pull': [1.35, 1.05],
  };

  void _applyMove(String id) {
    final v = _moves[id]!;
    setState(() {
      _fs = v[0];
      _ts = v[1];
    });
    _emit();
  }

  String get _activeMove {
    for (final e in _moves.entries) {
      if ((e.value[0] - _fs).abs() < 0.001 && (e.value[1] - _ts).abs() < 0.001) return e.key;
    }
    return '';
  }

  Widget _slider(String label, double v, ValueChanged<double> onChanged) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(label, style: const TextStyle(color: Ec.textDim, fontSize: 12.5)),
            const Spacer(),
            Text('${v.toStringAsFixed(2)}×',
                style: const TextStyle(
                    color: Ec.text, fontSize: 12.5, fontWeight: FontWeight.w700, fontFamily: Ec.mono)),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            activeTrackColor: Ec.accentB,
            inactiveTrackColor: Ec.chip,
            thumbColor: Colors.white,
            overlayShape: SliderComponentShape.noOverlay,
          ),
          child: Slider(min: 1.0, max: 4.0, value: v, onChanged: onChanged),
        ),
      ],
    );
  }

  /// A draggable focus pad — where in the frame that end of the move is centred.
  Widget _focusPad(String label, double cx, double cy, double scale, void Function(double, double) onMove) {
    return Expanded(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(label,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Ec.textDim, fontSize: 11.5, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          AspectRatio(
            aspectRatio: 9 / 16,
            child: LayoutBuilder(
              builder: (_, bc) {
                void handle(Offset local) {
                  onMove(
                    (local.dx / bc.maxWidth).clamp(0.0, 1.0),
                    (local.dy / bc.maxHeight).clamp(0.0, 1.0),
                  );
                }

                // The visible window at this scale, as a fraction of the frame.
                final vis = (1.0 / scale).clamp(0.05, 1.0);
                final w = bc.maxWidth * vis;
                final h = bc.maxHeight * vis;
                final left = (cx * bc.maxWidth - w / 2).clamp(0.0, bc.maxWidth - w);
                final top = (cy * bc.maxHeight - h / 2).clamp(0.0, bc.maxHeight - h);
                return GestureDetector(
                  behavior: HitTestBehavior.opaque,
                  onTapDown: (d) => handle(d.localPosition),
                  onPanUpdate: (d) => handle(d.localPosition),
                  child: Container(
                    decoration: BoxDecoration(
                      color: const Color(0xFF101015),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: Ec.hair),
                    ),
                    child: Stack(
                      children: [
                        Positioned(
                          left: left,
                          top: top,
                          width: w,
                          height: h,
                          child: Container(
                            decoration: BoxDecoration(
                              border: Border.all(color: Ec.accentB, width: 2),
                              borderRadius: BorderRadius.circular(4),
                              color: Ec.accentB.withValues(alpha: 0.14),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final move = _activeMove;
    return SheetScaffold(
      title: 'Zoom',
      heightFactor: 0.82,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 6, 18, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final id in _moves.keys)
                  EcChip(label: id, active: move == id, onTap: () => _applyMove(id)),
              ],
            ),
            const SizedBox(height: 14),
            _slider('Start zoom', _fs, (v) {
              setState(() => _fs = v);
              _emit();
            }),
            _slider('End zoom', _ts, (v) {
              setState(() => _ts = v);
              _emit();
            }),
            const SizedBox(height: 6),
            const Text('FOCUS — drag to choose what stays in frame',
                style: TextStyle(
                    color: Ec.textFaint, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.5)),
            const SizedBox(height: 8),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                _focusPad('Start', _fx, _fy, _fs, (x, y) {
                  setState(() {
                    _fx = x;
                    _fy = y;
                  });
                  _emit();
                }),
                const SizedBox(width: 12),
                _focusPad('End', _tx, _ty, _ts, (x, y) {
                  setState(() {
                    _tx = x;
                    _ty = y;
                  });
                  _emit();
                }),
              ],
            ),
            const SizedBox(height: 12),
            Text(
              (_fs - _ts).abs() < 0.001 && (_fx - _tx).abs() < 0.001 && (_fy - _ty).abs() < 0.001
                  ? (_fs <= 1.001
                      ? 'No zoom — the clip plays at full frame.'
                      : 'Static punch-in: the framing holds still for the whole clip.')
                  : 'The framing glides from Start to End across this clip.',
              style: const TextStyle(color: Ec.textFaint, fontSize: 11.5, height: 1.45),
            ),
          ],
        ),
      ),
    );
  }
}

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

/// ADJUST — per-clip brightness / contrast / saturation. Live in the preview,
/// baked on export (Media3 Contrast + HslAdjustment + RgbAdjustment).
class AdjustSheet extends StatefulWidget {
  final double brightness, contrast, saturation;
  final void Function({
    required double brightness,
    required double contrast,
    required double saturation,
  }) onChanged;
  const AdjustSheet({
    super.key,
    required this.brightness,
    required this.contrast,
    required this.saturation,
    required this.onChanged,
  });

  @override
  State<AdjustSheet> createState() => _AdjustSheetState();
}

class _AdjustSheetState extends State<AdjustSheet> {
  late double _b = widget.brightness.clamp(-1.0, 1.0);
  late double _c = widget.contrast.clamp(-1.0, 1.0);
  late double _s = widget.saturation.clamp(0.0, 2.0);

  void _emit() => widget.onChanged(brightness: _b, contrast: _c, saturation: _s);

  Widget _row(String label, double v, double min, double max, String display, ValueChanged<double> on) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(label, style: const TextStyle(color: Ec.textDim, fontSize: 12.5)),
            const Spacer(),
            Text(display,
                style: const TextStyle(
                    color: Ec.text, fontSize: 12.5, fontWeight: FontWeight.w700, fontFamily: Ec.mono)),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            activeTrackColor: Ec.accentB,
            inactiveTrackColor: Ec.chip,
            thumbColor: Colors.white,
            overlayShape: SliderComponentShape.noOverlay,
          ),
          child: Slider(min: min, max: max, value: v, onChanged: on),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Adjust',
      heightFactor: 0.58,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _row('Brightness', _b, -1, 1, '${(_b * 100).round()}', (v) {
              setState(() => _b = v);
              _emit();
            }),
            _row('Contrast', _c, -1, 1, '${(_c * 100).round()}', (v) {
              setState(() => _c = v);
              _emit();
            }),
            _row('Saturation', _s, 0, 2, '${(_s * 100).round()}%', (v) {
              setState(() => _s = v);
              _emit();
            }),
            const SizedBox(height: 10),
            Center(
              child: GestureDetector(
                onTap: () {
                  setState(() {
                    _b = 0;
                    _c = 0;
                    _s = 1;
                  });
                  _emit();
                },
                child: const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 14, vertical: 8),
                  child: Text('Reset', style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// ANIMATION — fade from / to black at this clip's own edges.
class AnimationSheet extends StatefulWidget {
  final int fadeInMs, fadeOutMs, maxMs;
  final void Function({required int fadeInMs, required int fadeOutMs}) onChanged;
  const AnimationSheet({
    super.key,
    required this.fadeInMs,
    required this.fadeOutMs,
    required this.maxMs,
    required this.onChanged,
  });

  @override
  State<AnimationSheet> createState() => _AnimationSheetState();
}

class _AnimationSheetState extends State<AnimationSheet> {
  // A fade can never exceed half the clip, or in and out would overlap.
  late final double _cap = (widget.maxMs / 2).clamp(100, 3000).toDouble();
  late double _in = widget.fadeInMs.toDouble().clamp(0, _cap);
  late double _out = widget.fadeOutMs.toDouble().clamp(0, _cap);

  void _emit() => widget.onChanged(fadeInMs: _in.round(), fadeOutMs: _out.round());

  Widget _row(String label, double v, ValueChanged<double> on) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Text(label, style: const TextStyle(color: Ec.textDim, fontSize: 12.5)),
            const Spacer(),
            Text(v < 1 ? 'Off' : '${v.round()}ms',
                style: const TextStyle(
                    color: Ec.text, fontSize: 12.5, fontWeight: FontWeight.w700, fontFamily: Ec.mono)),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            activeTrackColor: Ec.accentB,
            inactiveTrackColor: Ec.chip,
            thumbColor: Colors.white,
            overlayShape: SliderComponentShape.noOverlay,
          ),
          child: Slider(min: 0, max: _cap, value: v, onChanged: on),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Animation',
      heightFactor: 0.5,
      trailing: GradientButton(label: 'Done', onTap: () => Navigator.of(context).pop()),
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(18, 8, 18, 20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _row('Fade in', _in, (v) {
              setState(() => _in = v);
              _emit();
            }),
            _row('Fade out', _out, (v) {
              setState(() => _out = v);
              _emit();
            }),
            const SizedBox(height: 8),
            const Text('Fades from and to black at this clip’s own edges. Capped at half '
                'the clip so the two can never overlap.',
                style: TextStyle(color: Ec.textFaint, fontSize: 11.5, height: 1.45)),
          ],
        ),
      ),
    );
  }
}
