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
  const EditableImageOverlay({
    super.key,
    required this.o,
    required this.frame,
    required this.selected,
    required this.onSelect,
    required this.onChange,
  });

  @override
  State<EditableImageOverlay> createState() => _EditableImageOverlayState();
}

class _EditableImageOverlayState extends State<EditableImageOverlay> {
  double _baseScale = 0.45;

  @override
  Widget build(BuildContext context) {
    final o = widget.o;
    final w = (o.scale * widget.frame.width).clamp(24.0, widget.frame.width);
    return Align(
      alignment: Alignment(o.x * 2 - 1, o.y * 2 - 1),
      child: GestureDetector(
        behavior: HitTestBehavior.deferToChild,
        onTap: widget.onSelect,
        onScaleStart: (_) {
          widget.onSelect();
          _baseScale = o.scale;
        },
        onScaleUpdate: (d) {
          o.x = (o.x + d.focalPointDelta.dx / widget.frame.width).clamp(0.0, 1.0);
          o.y = (o.y + d.focalPointDelta.dy / widget.frame.height).clamp(0.0, 1.0);
          if (d.scale != 1.0) o.scale = (_baseScale * d.scale).clamp(0.05, 1.0);
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

  const EditableOverlay({
    super.key,
    required this.t,
    required this.frame,
    required this.selected,
    required this.onSelect,
    required this.onChange,
  });

  @override
  State<EditableOverlay> createState() => _EditableOverlayState();
}

class _EditableOverlayState extends State<EditableOverlay> {
  double _baseFont = 0.06;

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    final content = t.bg
        ? Container(
            padding: EdgeInsets.symmetric(
                horizontal: t.fontSize * widget.frame.height * 0.25,
                vertical: t.fontSize * widget.frame.height * 0.1),
            decoration: BoxDecoration(
              color: t.bgColor.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(t.fontSize * widget.frame.height * 0.14),
            ),
            child: Text(t.text, textAlign: TextAlign.center, style: t.style(widget.frame.height)),
          )
        : Text(t.text, textAlign: TextAlign.center, style: t.style(widget.frame.height));

    return Align(
      alignment: Alignment(t.x * 2 - 1, t.y * 2 - 1),
      child: FractionallySizedBox(
        widthFactor: 0.96,
        child: Center(
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.onSelect,
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
