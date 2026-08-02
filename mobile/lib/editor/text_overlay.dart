import 'dart:convert';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

/// A timed text overlay shown over the preview and baked into the export.
class TextOverlay {
  String text;
  double x; // 0..1 (center)
  double y; // 0..1 (center)
  double fontSize; // fraction of frame height
  Color color;
  bool bold;
  bool bg;
  Color bgColor;
  int startMs;
  int endMs;
  bool isCaption; // generated caption line (replaced on regenerate)
  int lane; // vertical lane on its timeline track (0 = first), so same-track items never overlap
  String? fontFamily; // null = the app's default font (InstrumentSans)
  // Karaoke captions: when both are set, the overlay renders [lineWords] joined
  // with the word at [highlightWord] drawn in an accent colour (the rest dimmed)
  // instead of the plain [text]. Null on every ordinary overlay.
  List<String>? lineWords;
  int? highlightWord;

  TextOverlay({
    required this.text,
    this.x = 0.5,
    this.y = 0.82,
    this.fontSize = 0.06,
    this.color = Colors.white,
    this.bold = true,
    this.bg = false,
    this.bgColor = Colors.black,
    required this.startMs,
    required this.endMs,
    this.isCaption = false,
    this.lane = 0,
    this.fontFamily,
    this.lineWords,
    this.highlightWord,
  });

  bool activeAt(int ms) => ms >= startMs && ms < endMs;

  TextOverlay copy() => TextOverlay(
        text: text,
        x: x,
        y: y,
        fontSize: fontSize,
        color: color,
        bold: bold,
        bg: bg,
        bgColor: bgColor,
        startMs: startMs,
        endMs: endMs,
        isCaption: isCaption,
        lane: lane,
        fontFamily: fontFamily,
        lineWords: lineWords == null ? null : List<String>.from(lineWords!),
        highlightWord: highlightWord,
      );

  Map<String, dynamic> toJson() => {
        't': text,
        'x': x,
        'y': y,
        'fs': fontSize,
        'c': color.toARGB32(),
        'b': bold,
        'bg': bg,
        'bgc': bgColor.toARGB32(),
        's': startMs,
        'e': endMs,
        'cap': isCaption,
        'lane': lane,
        if (fontFamily != null) 'ff': fontFamily,
        if (lineWords != null) 'lw': lineWords,
        if (highlightWord != null) 'hw': highlightWord,
      };

  factory TextOverlay.fromJson(Map j) => TextOverlay(
        text: (j['t'] as String?) ?? '',
        x: (j['x'] as num?)?.toDouble() ?? 0.5,
        y: (j['y'] as num?)?.toDouble() ?? 0.82,
        fontSize: (j['fs'] as num?)?.toDouble() ?? 0.06,
        color: Color((j['c'] as num?)?.toInt() ?? 0xFFFFFFFF),
        bold: (j['b'] as bool?) ?? true,
        bg: (j['bg'] as bool?) ?? false,
        bgColor: Color((j['bgc'] as num?)?.toInt() ?? 0xFF000000),
        startMs: (j['s'] as num?)?.toInt() ?? 0,
        endMs: (j['e'] as num?)?.toInt() ?? 0,
        isCaption: (j['cap'] as bool?) ?? false,
        lane: (j['lane'] as num?)?.toInt() ?? 0,
        fontFamily: j['ff'] as String?,
        lineWords: (j['lw'] as List?)?.map((e) => e.toString()).toList(),
        highlightWord: (j['hw'] as num?)?.toInt(),
      );

  TextStyle style(double frameH) => TextStyle(
        color: color,
        fontFamily: fontFamily,
        fontSize: fontSize * frameH,
        fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
        height: 1.15,
        shadows: bg
            ? null
            : const [Shadow(color: Colors.black, blurRadius: 3, offset: Offset(0, 1))],
      );

  /// Bright accent for the currently-spoken karaoke word.
  static const Color karaokeHi = Color(0xFFFFE14D);

  /// The inline span(s) for this overlay's text — the single source of truth for
  /// BOTH the live preview (EditableOverlay) and the export rasterizer
  /// (bakePngBase64), so they always match. Normally one plain span; for a
  /// karaoke overlay ([lineWords] + [highlightWord] set) it draws the full line
  /// with the spoken word in [karaokeHi] and the others dimmed.
  TextSpan textSpan(double frameH) {
    final base = style(frameH);
    final lw = lineWords;
    final hw = highlightWord;
    if (lw == null || hw == null || lw.isEmpty) {
      return TextSpan(text: text.isEmpty ? ' ' : text, style: base);
    }
    final dim = base.copyWith(color: color.withValues(alpha: 0.5));
    final hi = base.copyWith(color: karaokeHi);
    final children = <TextSpan>[];
    for (int i = 0; i < lw.length; i++) {
      children.add(TextSpan(text: lw[i], style: i == hw ? hi : dim));
      if (i != lw.length - 1) children.add(TextSpan(text: ' ', style: base));
    }
    return TextSpan(style: base, children: children);
  }

  /// Bake to a full-frame transparent PNG at the OUTPUT resolution, returned as
  /// base64 (no data: prefix) — the shape the native Media3 OverlayEffect wants.
  Future<String> bakePngBase64(int width, int height) async {
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()));
    final tp = TextPainter(
      text: textSpan(height.toDouble()),
      textDirection: TextDirection.ltr,
      textAlign: TextAlign.center,
    );
    tp.layout(maxWidth: width * 0.9);
    final cx = x * width;
    final cy = y * height;
    final left = cx - tp.width / 2;
    final top = cy - tp.height / 2;
    if (bg) {
      final pad = tp.height * 0.14;
      final rect = RRect.fromRectAndRadius(
        Rect.fromLTWH(left - pad, top - pad, tp.width + pad * 2, tp.height + pad * 2),
        Radius.circular(tp.height * 0.14),
      );
      canvas.drawRRect(rect, Paint()..color = bgColor.withValues(alpha: 0.85));
    }
    tp.paint(canvas, Offset(left, top));
    final picture = recorder.endRecording();
    final img = await picture.toImage(width, height);
    final bytes = await img.toByteData(format: ui.ImageByteFormat.png);
    img.dispose();
    picture.dispose();
    final u8 = bytes!.buffer.asUint8List();
    return base64Encode(u8);
  }
}

/// An image (PiP / sticker) overlay shown over the preview and baked into export.
class ImageOverlay {
  final Uint8List bytes;
  double x; // 0..1 (center)
  double y; // 0..1 (center)
  double scale; // width as a fraction of the frame width
  int startMs;
  int endMs;
  int lane; // vertical lane on the timeline image track (0 = first)

  ImageOverlay({
    required this.bytes,
    this.x = 0.5,
    this.y = 0.5,
    this.scale = 0.45,
    required this.startMs,
    required this.endMs,
    this.lane = 0,
  });

  bool activeAt(int ms) => ms >= startMs && ms < endMs;

  ImageOverlay copy() =>
      ImageOverlay(bytes: bytes, x: x, y: y, scale: scale, startMs: startMs, endMs: endMs, lane: lane);

  /// The pixels ride along base64 — an overlay is picked from the device gallery,
  /// so there is no stable path to point at on reload.
  Map<String, dynamic> toJson() => {
        'img': base64Encode(bytes),
        'x': x,
        'y': y,
        'scale': scale,
        'start': startMs,
        'end': endMs,
        'lane': lane,
      };

  factory ImageOverlay.fromJson(Map j) => ImageOverlay(
        bytes: base64Decode((j['img'] as String?) ?? ''),
        x: (j['x'] as num?)?.toDouble() ?? 0.5,
        y: (j['y'] as num?)?.toDouble() ?? 0.5,
        scale: (j['scale'] as num?)?.toDouble() ?? 0.45,
        startMs: (j['start'] as num?)?.toInt() ?? 0,
        endMs: (j['end'] as num?)?.toInt() ?? 0,
        lane: (j['lane'] as num?)?.toInt() ?? 0,
      );

  /// Bake to a full-frame transparent PNG at the OUTPUT resolution (base64, no prefix).
  Future<String> bakePngBase64(int width, int height) async {
    final codec = await ui.instantiateImageCodec(bytes);
    final img = (await codec.getNextFrame()).image;
    final iw = img.width.toDouble();
    final ih = img.height.toDouble();
    final drawW = scale * width;
    final drawH = iw > 0 ? drawW * ih / iw : drawW;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()));
    final dst = Rect.fromCenter(center: Offset(x * width, y * height), width: drawW, height: drawH);
    canvas.drawImageRect(img, Rect.fromLTWH(0, 0, iw, ih), dst, Paint());
    final picture = recorder.endRecording();
    final out = await picture.toImage(width, height);
    final bd = await out.toByteData(format: ui.ImageByteFormat.png);
    img.dispose();
    out.dispose();
    picture.dispose();
    return base64Encode(bd!.buffer.asUint8List());
  }
}

/// A widget that renders an overlay over the preview at its (x,y) fraction.
class TextOverlayView extends StatelessWidget {
  final TextOverlay t;
  final Size frame;
  const TextOverlayView({super.key, required this.t, required this.frame});

  @override
  Widget build(BuildContext context) {
    final child = Text.rich(t.textSpan(frame.height), textAlign: TextAlign.center);
    final wrapped = t.bg
        ? Container(
            padding: EdgeInsets.symmetric(horizontal: t.fontSize * frame.height * 0.25, vertical: t.fontSize * frame.height * 0.1),
            decoration: BoxDecoration(
              color: t.bgColor.withValues(alpha: 0.85),
              borderRadius: BorderRadius.circular(t.fontSize * frame.height * 0.14),
            ),
            child: child,
          )
        : child;
    return Align(
      alignment: Alignment(t.x * 2 - 1, t.y * 2 - 1),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: frame.width * 0.92),
        child: wrapped,
      ),
    );
  }
}

Uint8List b64(String s) => base64Decode(s);
