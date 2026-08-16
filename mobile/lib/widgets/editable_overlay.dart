import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import '../editor/text_overlay.dart';
import '../theme.dart';

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
      final codec = await ui.instantiateImageCodec(widget.o.bytes);
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
            child: Image.memory(o.bytes, fit: BoxFit.contain, gaplessPlayback: true),
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
