import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../editor/background_mask.dart';
import '../editor/text_overlay.dart';
import '../native/exporter.dart';
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Background removal tool with two modes:
/// - Auto: ML Kit person segmentation (one tap, works for people)
/// - Manual: paint a brush mask over the foreground to keep
///
/// The resulting mask is saved as a PNG file; [onApply] receives its path
/// (auto) or the path written by the manual painter. For video overlays the
/// mask is derived from a representative frame but applies to the whole clip.
class CutoutSheet extends StatefulWidget {
  final ImageOverlay overlay;
  final NativeExporter exporter;
  /// Source time range used for a main-track trim. Overlay videos use 0..duration.
  final int sourceStartMs;
  final int sourceEndMs;

  /// Called with (mode, masks) when the user applies the cutout.
  /// mode: 1 = auto, 2 = manual.
  final void Function(int mode, List<BackgroundMaskFrame> masks) onApply;

  const CutoutSheet({
    super.key,
    required this.overlay,
    required this.exporter,
    this.sourceStartMs = 0,
    this.sourceEndMs = 0,
    required this.onApply,
  });

  @override
  State<CutoutSheet> createState() => _CutoutSheetState();
}

class _CutoutSheetState extends State<CutoutSheet> {
  int _tab = 0; // 0 = auto, 1 = manual
  bool _processing = false;
  String? _autoMaskPath;
  List<({int timeMs, String path})> _autoMaskRows = const [];
  String? _error;

  // Video sequence progress
  double _progress = 0;
  int _currentFrame = 0;
  int _totalFrames = 0;

  // Manual brush state
  Uint8List? _frameBytes;
  ui.Image? _frameImage;
  double _frameAspect = 1;
  final List<_Stroke> _strokes = [];
  _BrushMode _brushMode = _BrushMode.keep;
  double _brushSize = 40;

  @override
  void initState() {
    super.initState();
    _loadFrame();
  }

  Future<void> _loadFrame() async {
    final o = widget.overlay;
    if (o.isVideo && o.videoPath != null) {
      final sourceMs = widget.sourceStartMs +
          ((widget.sourceEndMs - widget.sourceStartMs).clamp(0, 1 << 30) ~/ 2);
      final bytes = await widget.exporter.frame('file://${o.videoPath}', sourceMs);
      if (bytes != null) _setFrameBytes(bytes);
    } else if (o.bytes != null) {
      _setFrameBytes(o.bytes!);
    }
  }

  void _setFrameBytes(Uint8List bytes) {
    ui.decodeImageFromList(bytes, (img) {
      if (mounted) {
        setState(() {
          _frameBytes = bytes;
          _frameImage = img;
          _frameAspect = img.width / img.height;
        });
      }
    });
  }

  Future<void> _runAuto() async {
    setState(() {
      _processing = true;
      _error = null;
      _progress = 0;
      _currentFrame = 0;
      _totalFrames = 0;
    });
    final o = widget.overlay;
    final uri = o.isVideo ? 'file://${o.videoPath}' : 'file://${_overlayImagePath(o)}';
    List<({int timeMs, String path})> rows;
    if (o.isVideo) {
      final end = widget.sourceEndMs > widget.sourceStartMs
          ? widget.sourceEndMs
          : widget.sourceStartMs + 1;
      rows = await widget.exporter.removeBackgroundSequence(
          uri, widget.sourceStartMs, end,
          stepMs: 400,
          onProgress: (pct, cur, total) {
            if (mounted) {
              setState(() {
                _progress = pct;
                _currentFrame = cur;
                _totalFrames = total;
              });
            }
          });
    } else {
      final path = await widget.exporter.removeBackground(uri, 0);
      rows = path == null ? const [] : [(timeMs: 0, path: path)];
    }
    if (!mounted) return;
    setState(() {
      _processing = false;
      if (rows.isNotEmpty) {
        _autoMaskPath = rows.first.path;
        _autoMaskRows = rows;
      } else {
        _error = 'Could not remove background. Try manual brush mode.';
      }
    });
  }

  void _cancelAuto() {
    widget.exporter.cancelBackground();
    if (mounted) {
      setState(() {
        _processing = false;
        _error = 'Cancelled.';
      });
    }
  }

  String _overlayImagePath(ImageOverlay o) {
    // For image overlays the bytes are in memory; write a temp file so the
    // native side can read them. This is only needed for the auto path.
    final tmp = File('${Directory.systemTemp.path}/ec_cutout_src_${DateTime.now().millisecondsSinceEpoch}.jpg');
    if (o.bytes != null) tmp.writeAsBytesSync(o.bytes!);
    return tmp.path;
  }

  void _applyAuto() {
    if (_autoMaskPath == null) return;
    widget.onApply(1, [
      for (final row in _autoMaskRows) BackgroundMaskFrame(row.timeMs, row.path),
    ]);
    Navigator.of(context).pop();
  }

  Future<void> _applyManual() async {
    if (_frameImage == null) return;
    final w = _frameImage!.width;
    final h = _frameImage!.height;
    final pw = _previewW;
    final ph = _previewH;
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder, ui.Rect.fromLTWH(0, 0, w.toDouble(), h.toDouble()));
    // Scale the canvas from preview coords to source resolution so strokes are
    // saved at full image quality.
    canvas.scale(w / pw, h / ph);
    canvas.saveLayer(ui.Rect.fromLTWH(0, 0, pw, ph), ui.Paint());
    for (final s in _strokes) {
      final paint = ui.Paint()
        ..style = ui.PaintingStyle.stroke
        ..strokeCap = ui.StrokeCap.round
        ..strokeJoin = ui.StrokeJoin.round
        ..strokeWidth = s.size;
      if (s.mode == _BrushMode.keep) {
        paint.color = const ui.Color(0xFFFFFFFF);
        canvas.drawPath(s.toPath(), paint);
      } else {
        paint.color = const ui.Color(0xFFFFFFFF);
        paint.blendMode = ui.BlendMode.clear;
        canvas.drawPath(s.toPath(), paint);
      }
    }
    canvas.restore();
    final picture = recorder.endRecording();
    final img = await picture.toImage(w, h);
    final bd = await img.toByteData(format: ui.ImageByteFormat.png);
    if (bd == null) return;
    final path = '${Directory.systemTemp.path}/ec_cutout_manual_${DateTime.now().millisecondsSinceEpoch}.png';
    await File(path).writeAsBytes(bd.buffer.asUint8List());
    img.dispose();
    if (!mounted) return;
    widget.onApply(2, [BackgroundMaskFrame(0, path)]);
    Navigator.of(context).pop();
  }

  double get _previewW => MediaQuery.of(context).size.width - 32;
  double get _previewH => _previewW / (_frameAspect > 0 ? _frameAspect : 1);

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      title: 'Remove Background',
      heightFactor: 0.72,
      trailing: _tab == 0
          ? GradientButton(
              label: 'Apply',
              onTap: _autoMaskPath != null ? _applyAuto : null,
            )
          : GradientButton(
              label: 'Apply',
              onTap: _frameImage != null ? _applyManual : null,
            ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 0, 16, 14),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Mode tabs
            Row(
              children: [
                _tabButton('Auto', 0),
                const SizedBox(width: 8),
                _tabButton('Manual Brush', 1),
              ],
            ),
            const SizedBox(height: 12),
            Expanded(child: _tab == 0 ? _autoTab() : _manualTab()),
          ],
        ),
      ),
    );
  }

  Widget _tabButton(String label, int index) {
    final active = _tab == index;
    return GestureDetector(
      onTap: () => setState(() => _tab = index),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 9),
        decoration: BoxDecoration(
          color: active ? Ec.indigo : Ec.card,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: active ? Ec.indigo : Ec.border),
        ),
        child: Text(label,
            style: TextStyle(
                color: active ? Colors.white : Ec.textDim,
                fontSize: 13,
                fontWeight: FontWeight.w600)),
      ),
    );
  }

  Widget _autoTab() {
    if (_processing) {
      return Center(child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircularProgressIndicator(color: Ec.indigo),
          SizedBox(height: 12),
          Text(
            _totalFrames > 0
                ? 'Background removal  ${_progress.round()}%  ($_currentFrame / $_totalFrames frames)'
                : 'Detecting person…',
            style: const TextStyle(color: Ec.textDim, fontSize: 13),
          ),
          if (_totalFrames > 0) ...[
            SizedBox(height: 8),
            SizedBox(
              width: 200,
              child: LinearProgressIndicator(
                value: _progress / 100.0,
                backgroundColor: Ec.chip,
                color: Ec.indigo,
                minHeight: 4,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
          ],
          SizedBox(height: 16),
          GestureDetector(
            onTap: _cancelAuto,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 10),
              decoration: BoxDecoration(
                color: Ec.card,
                borderRadius: BorderRadius.circular(8),
                border: Border.all(color: Ec.border),
              ),
              child: const Text('Cancel', style: TextStyle(color: Ec.textDim, fontSize: 13)),
            ),
          ),
        ],
      ));
    }
    if (_error != null) {
      return Center(child: Padding(
        padding: const EdgeInsets.all(20),
        child: Text(_error!, textAlign: TextAlign.center,
            style: const TextStyle(color: Color(0xFFD9686E), fontSize: 13)),
      ));
    }
    if (_autoMaskPath != null) {
      return Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          const Icon(Icons.check_circle, color: Color(0xFF4FD1C5), size: 40),
          const SizedBox(height: 10),
          const Text('Background removed!',
              style: TextStyle(color: Ec.text, fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          const Text('The person stays visible throughout the clip.\nTap Apply to confirm.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Ec.textFaint, fontSize: 12)),
        ],
      );
    }
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.face_retouching_natural, size: 48, color: Ec.indigoText),
          const SizedBox(height: 12),
          const Text('Auto background removal',
              style: TextStyle(color: Ec.text, fontSize: 15, fontWeight: FontWeight.w600)),
          const SizedBox(height: 6),
          const Text('Detects the person and removes everything else.\nWorks best for people facing the camera.',
              textAlign: TextAlign.center,
              style: TextStyle(color: Ec.textFaint, fontSize: 12)),
          const SizedBox(height: 18),
          GradientButton(label: 'Remove Background', onTap: _runAuto),
        ],
      ),
    );
  }

  Widget _manualTab() {
    if (_frameImage == null) {
      return const Center(child: CircularProgressIndicator(color: Ec.indigo));
    }
    return Column(
      children: [
        // Brush controls
        Row(
          children: [
            _brushToggle('Keep', _BrushMode.keep, const Color(0xFF4FD1C5)),
            const SizedBox(width: 8),
            _brushToggle('Erase', _BrushMode.erase, const Color(0xFFD9686E)),
            const Spacer(),
            Text('${_brushSize.round()}',
                style: const TextStyle(color: Ec.textDim, fontSize: 12)),
          ],
        ),
        Slider(
          value: _brushSize,
          min: 10,
          max: 80,
          onChanged: (v) => setState(() => _brushSize = v),
        ),
        const SizedBox(height: 4),
        Expanded(child: _paintCanvas()),
      ],
    );
  }

  Widget _brushToggle(String label, _BrushMode mode, Color color) {
    final active = _brushMode == mode;
    return GestureDetector(
      onTap: () => setState(() => _brushMode = mode),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
        decoration: BoxDecoration(
          color: active ? color.withValues(alpha: 0.2) : Ec.card,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(color: active ? color : Ec.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(mode == _BrushMode.keep ? Icons.brush : Icons.auto_fix_high,
                size: 14, color: color),
            const SizedBox(width: 5),
            Text(label, style: TextStyle(color: color, fontSize: 12.5, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _paintCanvas() {
    return ClipRRect(
      borderRadius: BorderRadius.circular(10),
      child: Container(
        color: Ec.chip,
        width: _previewW,
        height: _previewH,
        child: GestureDetector(
          onPanStart: (d) {
            setState(() {
              _strokes.add(_Stroke(_brushMode, _brushSize));
              _strokes.last.points.add(d.localPosition);
            });
          },
          onPanUpdate: (d) {
            setState(() => _strokes.last.points.add(d.localPosition));
          },
          child: CustomPaint(
            size: Size(_previewW, _previewH),
            painter: _CutoutPainter(
              frameImage: _frameImage!,
              strokes: _strokes,
              brushMode: _brushMode,
              brushSize: _brushSize,
            ),
          ),
        ),
      ),
    );
  }
}

enum _BrushMode { keep, erase }

class _Stroke {
  final _BrushMode mode;
  final double size;
  final List<Offset> points = [];
  _Stroke(this.mode, this.size);

  ui.Path toPath() {
    final path = ui.Path();
    if (points.isEmpty) return path;
    path.moveTo(points[0].dx, points[0].dy);
    for (var i = 1; i < points.length; i++) {
      path.lineTo(points[i].dx, points[i].dy);
    }
    if (points.length == 1) {
      path.addOval(ui.Rect.fromCircle(center: points[0], radius: size / 2));
    }
    return path;
  }
}

class _CutoutPainter extends CustomPainter {
  final ui.Image frameImage;
  final List<_Stroke> strokes;
  final _BrushMode brushMode;
  final double brushSize;

  _CutoutPainter({
    required this.frameImage,
    required this.strokes,
    required this.brushMode,
    required this.brushSize,
  });

  @override
  void paint(Canvas canvas, Size size) {
    // Draw the preview frame
    canvas.drawImageRect(
      frameImage,
      ui.Rect.fromLTWH(0, 0, frameImage.width.toDouble(), frameImage.height.toDouble()),
      ui.Rect.fromLTWH(0, 0, size.width, size.height),
      ui.Paint(),
    );

    // Draw existing strokes
    for (final s in strokes) {
      final paint = Paint()
        ..style = PaintingStyle.stroke
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round
        ..strokeWidth = s.size;
      if (s.mode == _BrushMode.keep) {
        paint.color = const Color(0x8800FFCC);
      } else {
        paint.color = const Color(0x88FF4444);
      }
      canvas.drawPath(s.toPath(), paint);
    }
  }

  @override
  bool shouldRepaint(_CutoutPainter old) {
    // Compare total point count — changes every time a point is added
    final oldCount = old.strokes.fold<int>(0, (s, st) => s + st.points.length);
    final newCount = strokes.fold<int>(0, (s, st) => s + st.points.length);
    return oldCount != newCount || old.brushMode != brushMode || old.brushSize != brushSize;
  }
}