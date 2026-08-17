import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:video_player/video_player.dart';

import '../editor/text_overlay.dart';
import '../theme.dart';

Widget _cropOverlay(ImageOverlay o, Widget child) {
  final visibleW = (1 - o.cropL - o.cropR).clamp(0.12, 1.0).toDouble();
  final visibleH = (1 - o.cropT - o.cropB).clamp(0.12, 1.0).toDouble();
  if (visibleW >= .999 && visibleH >= .999) return child;
  final scale = (1 / visibleW) > (1 / visibleH) ? 1 / visibleW : 1 / visibleH;
  final ax = ((o.cropL + visibleW / 2) * 2 - 1).clamp(-1.0, 1.0).toDouble();
  final ay = ((o.cropT + visibleH / 2) * 2 - 1).clamp(-1.0, 1.0).toDouble();
  return ClipRect(child: Transform.scale(scale: scale, alignment: Alignment(ax, ay), child: child));
}

/// Wraps any child with a background-removal mask (PNG with alpha: white = keep,
/// transparent = remove). Uses [ShaderMask] with [BlendMode.dstIn] so it works for
/// both image and video overlay widgets.
class MaskedMedia extends StatefulWidget {
  final String? maskPath;
  final Widget child;
  const MaskedMedia({super.key, this.maskPath, required this.child});

  @override
  State<MaskedMedia> createState() => _MaskedMediaState();
}

class _MaskedMediaState extends State<MaskedMedia> {
  ui.Image? _mask;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(MaskedMedia old) {
    super.didUpdateWidget(old);
    if (old.maskPath != widget.maskPath) _load();
  }

  void _load() async {
    if (widget.maskPath == null || widget.maskPath!.isEmpty) {
      if (mounted && _mask != null) setState(() => _mask = null);
      return;
    }
    try {
      final bytes = await File(widget.maskPath!).readAsBytes();
      ui.decodeImageFromList(bytes, (img) {
        if (mounted) setState(() => _mask = img);
      });
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    if (_mask == null) return widget.child;
    return ShaderMask(
      shaderCallback: (rect) {
        // ImageShader maps local widget coordinates into source-image
        // coordinates, so this is source/display (the previous code used the
        // inverse and sampled only a small corner of most masks).
        final sx = _mask!.width / rect.width;
        final sy = _mask!.height / rect.height;
        return ui.ImageShader(
          _mask!,
          TileMode.clamp,
          TileMode.clamp,
          (Matrix4.identity()..scale(sx, sy)).storage,
        );
      },
      blendMode: BlendMode.dstIn,
      child: widget.child,
    );
  }
}

/// An image overlay on the preview: drag to move, pinch to resize, tap to select.
class EditableImageOverlay extends StatefulWidget {
  final ImageOverlay o;
  final Size frame;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onChange;
  final VoidCallback? onDeselect;
  const EditableImageOverlay({
    super.key,
    required this.o,
    required this.frame,
    required this.selected,
    required this.onSelect,
    required this.onChange,
    this.onDeselect,
  });

  @override
  State<EditableImageOverlay> createState() => _EditableImageOverlayState();
}

class _EditableImageOverlayState extends State<EditableImageOverlay> {
  double _baseScale = 0.45;
  double _imageAspect = 1.0;

  @override
  void initState() {
    super.initState();
    _loadImageAspect();
  }

  @override
  void didUpdateWidget(EditableImageOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.o.bytes, widget.o.bytes)) _loadImageAspect();
  }

  Future<void> _loadImageAspect() async {
    try {
      final codec = await ui.instantiateImageCodec(widget.o.bytes!);
      final frame = await codec.getNextFrame();
      final image = frame.image;
      final aspect = image.width > 0 && image.height > 0 ? image.width / image.height : 1.0;
      image.dispose();
      codec.dispose();
      if (mounted) setState(() => _imageAspect = aspect);
    } catch (_) {
      // Keep the square fallback; the stage clip still protects the composition.
    }
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.o;
    final w = (o.scale * widget.frame.width).clamp(24.0, widget.frame.width).toDouble();
    final halfW = (w / (2 * widget.frame.width)).clamp(0.0, 0.5).toDouble();
    final halfH = (w / _imageAspect / (2 * widget.frame.height)).clamp(0.0, 0.5).toDouble();
    final cx = o.x.clamp(halfW, 1.0 - halfW).toDouble();
    final cy = o.y.clamp(halfH, 1.0 - halfH).toDouble();
    // Position the CENTRE at (x,y)·frame via a top-left Positioned + half-size
    // translate, so a finger-drag maps 1:1 to movement (Align maps x→position by
    // child size, so overlays don't track the finger and pile up).
    return Positioned(
      left: cx * widget.frame.width,
      top: cy * widget.frame.height,
      child: FractionalTranslation(
        translation: const Offset(-0.5, -0.5),
        child: GestureDetector(
          // deferToChild → this only claims taps where the image actually paints,
          // so taps on empty preview area fall through to the background deselect.
          behavior: HitTestBehavior.deferToChild,
          onTap: () => widget.selected ? widget.onDeselect?.call() : widget.onSelect(),
          onScaleStart: (_) {
            // Normalise legacy/out-of-bounds positions before the first drag so
            // the gesture starts at the same point that is actually painted.
            o.x = cx;
            o.y = cy;
            widget.onSelect();
            _baseScale = o.scale;
          },
          onScaleUpdate: (d) {
            if (d.scale != 1.0) o.scale = (_baseScale * d.scale).clamp(0.05, 1.0);
            final nextW = (o.scale * widget.frame.width).clamp(24.0, widget.frame.width).toDouble();
            final nextHalfW = (nextW / (2 * widget.frame.width)).clamp(0.0, 0.5).toDouble();
            final nextHalfH = (nextW / _imageAspect / (2 * widget.frame.height)).clamp(0.0, 0.5).toDouble();
            o.x = (o.x + d.focalPointDelta.dx / widget.frame.width)
                .clamp(nextHalfW, 1.0 - nextHalfW)
                .toDouble();
            o.y = (o.y + d.focalPointDelta.dy / widget.frame.height)
                .clamp(nextHalfH, 1.0 - nextHalfH)
                .toDouble();
            widget.onChange();
          },
          child: Container(
            width: w,
            decoration: widget.selected
                ? BoxDecoration(border: Border.all(color: Ec.accentB, width: 1.5))
                : null,
            child: Opacity(
              opacity: o.opacity.clamp(0.0, 1.0).toDouble(),
              child: Transform.rotate(
                angle: o.rotation,
                child: _cropOverlay(o, MaskedMedia(maskPath: o.bgMode > 0 ? o.maskAt(0) : null, child: Image.memory(o.bytes!, fit: BoxFit.contain, gaplessPlayback: true))),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Native video overlay. The controller is intentionally owned by the overlay
/// widget: it gives every video its own hardware decoder while the editor keeps
/// one shared timing/layer model for all visual media.
class EditableVideoOverlay extends StatefulWidget {
  final ImageOverlay o;
  final Size frame;
  final bool selected;
  final bool playing;
  final int positionMs;
  final VoidCallback onSelect;
  final VoidCallback onChange;
  final VoidCallback? onDeselect;

  const EditableVideoOverlay({
    super.key,
    required this.o,
    required this.frame,
    required this.selected,
    required this.playing,
    required this.positionMs,
    required this.onSelect,
    required this.onChange,
    this.onDeselect,
  });

  @override
  State<EditableVideoOverlay> createState() => _EditableVideoOverlayState();
}

class _EditableVideoOverlayState extends State<EditableVideoOverlay> {
  VideoPlayerController? _controller;
  double _baseScale = 0.45;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    _open();
  }

  Future<void> _open() async {
    final path = widget.o.videoPath;
    if (path == null || path.isEmpty) return;
    final c = VideoPlayerController.file(File(path));
    _controller = c;
    try {
      await c.initialize();
      await c.setLooping(false);
      await c.setPlaybackSpeed(widget.o.speed.clamp(0.1, 4.0).toDouble());
      await c.setVolume(widget.o.volume.clamp(0.0, 4.0).toDouble());
      if (!mounted) {
        await c.dispose();
        return;
      }
      setState(() {});
      await _sync(force: true);
    } catch (_) {
      await c.dispose();
      if (identical(_controller, c)) _controller = null;
      if (mounted) setState(() {});
    }
  }

  @override
  void didUpdateWidget(EditableVideoOverlay oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.o.videoPath != widget.o.videoPath) {
      _controller?.dispose();
      _controller = null;
      _open();
      return;
    }
    _sync();
  }

  Future<void> _sync({bool force = false}) async {
    final c = _controller;
    if (c == null || !c.value.isInitialized || _syncing) return;
    _syncing = true;
    try {
      final localMs = (widget.positionMs - widget.o.startMs).clamp(0, widget.o.endMs - widget.o.startMs);
      final sourceMs = (localMs * widget.o.speed.clamp(0.1, 4.0)).round();
      if (force || (c.value.position.inMilliseconds - sourceMs).abs() > 180) {
        await c.seekTo(Duration(milliseconds: sourceMs));
      }
      await c.setPlaybackSpeed(widget.o.speed.clamp(0.1, 4.0).toDouble());
      await c.setVolume(widget.o.volume.clamp(0.0, 4.0).toDouble());
      if (widget.playing && !c.value.isPlaying) {
        await c.play();
      } else if (!widget.playing && c.value.isPlaying) {
        await c.pause();
      }
    } catch (_) {
      // A disposed/temporarily unavailable controller must not interrupt the base preview.
    } finally {
      _syncing = false;
    }
  }

  @override
  void dispose() {
    _controller?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final o = widget.o;
    final w = (o.scale * widget.frame.width).clamp(24.0, widget.frame.width).toDouble();
    final cx = o.x.clamp(o.scale / 2, 1 - o.scale / 2).toDouble();
    final c = _controller;
    final child = c == null || !c.value.isInitialized
        ? SizedBox(width: w, height: w, child: const Center(child: CircularProgressIndicator(strokeWidth: 1.5)))
        : SizedBox(
            width: w,
            child: AspectRatio(
              aspectRatio: c.value.aspectRatio <= 0 ? 1 : c.value.aspectRatio,
              child: VideoPlayer(c),
            ),
          );
    return Positioned(
      left: cx * widget.frame.width,
      top: o.y.clamp(0.0, 1.0).toDouble() * widget.frame.height,
      child: FractionalTranslation(
        translation: const Offset(-0.5, -0.5),
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: () => widget.selected ? widget.onDeselect?.call() : widget.onSelect(),
          onScaleStart: (_) {
            o.x = cx;
            widget.onSelect();
            _baseScale = o.scale;
          },
          onScaleUpdate: (d) {
            if (d.scale != 1.0) o.scale = (_baseScale * d.scale).clamp(0.05, 1.0).toDouble();
            o.x = (o.x + d.focalPointDelta.dx / widget.frame.width)
                .clamp(o.scale / 2, 1 - o.scale / 2)
                .toDouble();
            o.y = (o.y + d.focalPointDelta.dy / widget.frame.height).clamp(0.0, 1.0).toDouble();
            widget.onChange();
          },
          child: Container(
            width: w,
            decoration: widget.selected
                ? BoxDecoration(border: Border.all(color: Ec.accentB, width: 1.5))
                : null,
            child: Opacity(
              opacity: o.opacity.clamp(0.0, 1.0).toDouble(),
              child: Transform.rotate(angle: o.rotation, child: _cropOverlay(o, MaskedMedia(maskPath: o.bgMode > 0 ? o.maskAt(widget.positionMs - o.startMs) : null, child: child))),
            ),
          ),
        ),
      ),
    );
  }
}

/// A text overlay on the preview that can be dragged (move), pinched (resize),
/// and tapped (select). Mutates the [TextOverlay] in place and calls [onChange].
class EditableOverlay extends StatefulWidget {
  final TextOverlay t;
  final Size frame;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onChange;
  final VoidCallback? onDeselect;

  const EditableOverlay({
    super.key,
    required this.t,
    required this.frame,
    required this.selected,
    required this.onSelect,
    required this.onChange,
    this.onDeselect,
  });

  @override
  State<EditableOverlay> createState() => _EditableOverlayState();
}

class _EditableOverlayState extends State<EditableOverlay> {
  double _baseFont = 0.06;

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    // Text.rich(t.textSpan(...)) so the live preview honours t.fontFamily and the
    // karaoke word-highlight, matching the export rasterizer exactly.
    final label = Text.rich(t.textSpan(widget.frame.height), textAlign: t.textAlign);
    final content = t.bg
        ? Container(
            padding: EdgeInsets.symmetric(
                horizontal: t.fontSize * widget.frame.height * 0.25,
                vertical: t.fontSize * widget.frame.height * 0.1),
            decoration: BoxDecoration(
              color: t.bgColor.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(t.fontSize * widget.frame.height * 0.14),
            ),
            child: label,
          )
        : label;

    // Centre the text box on (x,y)·frame via a top-left Positioned + half-size
    // translate. A finger-drag then maps 1:1 to movement and matches the export
    // bake (text centred at x·width) — Align mapped x→position by the box's own
    // width, so overlays refused to move apart and stacked at centre.
    return Positioned(
      left: t.x * widget.frame.width,
      top: t.y * widget.frame.height,
      child: FractionalTranslation(
        translation: const Offset(-0.5, -0.5),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: widget.frame.width * 0.92),
          child: GestureDetector(
            // opaque, but only over the text's own (padded) bounds — so taps on
            // empty preview area miss it and reach the background deselect. Tapping
            // an already-selected overlay toggles it off.
            behavior: HitTestBehavior.opaque,
            onTap: () => widget.selected ? widget.onDeselect?.call() : widget.onSelect(),
            onScaleStart: (_) {
              widget.onSelect();
              _baseFont = t.fontSize;
            },
            onScaleUpdate: (d) {
              // Pan (focal delta) moves; pinch (scale) resizes.
              t.x = (t.x + d.focalPointDelta.dx / widget.frame.width).clamp(0.04, 0.96);
              t.y = (t.y + d.focalPointDelta.dy / widget.frame.height).clamp(0.04, 0.96);
              if (d.scale != 1.0) {
                t.fontSize = (_baseFont * d.scale).clamp(0.02, 0.32);
              }
              widget.onChange();
            },
            child: Container(
              padding: const EdgeInsets.all(4),
              decoration: widget.selected
                  ? BoxDecoration(
                      border: Border.all(color: Ec.accentB, width: 1.5),
                      borderRadius: BorderRadius.circular(6),
                    )
                  : null,
              child: content,
            ),
          ),
        ),
      ),
    );
  }
}
