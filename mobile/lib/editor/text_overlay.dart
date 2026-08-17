import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';

import 'background_mask.dart';

/// A timed text overlay shown over the preview and baked into the export.
class TextOverlay {
  String text;
  double x; // 0..1 (center)
  double y; // 0..1 (center)
  double fontSize; // fraction of frame height
  Color color;
  bool bold;
  bool italic;
  /// 'left' | 'center' | 'right' — how the lines sit within the text block.
  String align;
  bool bg;
  Color bgColor;
  int startMs;
  int endMs;
  bool isCaption; // generated caption line (replaced on regenerate)
  int lane; // vertical lane on its timeline track (0 = first), so same-track items never overlap
  int zIndex; // visual stacking order; timing lanes and visual layers are independent
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
    this.italic = false,
    this.align = 'center',
    this.bg = false,
    this.bgColor = Colors.black,
    required this.startMs,
    required this.endMs,
    this.isCaption = false,
    this.lane = 0,
    this.zIndex = 100,
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
        italic: italic,
        align: align,
        bg: bg,
        bgColor: bgColor,
        startMs: startMs,
        endMs: endMs,
        isCaption: isCaption,
        lane: lane,
        zIndex: zIndex,
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
        'i': italic,
        'al': align,
        'bg': bg,
        'bgc': bgColor.toARGB32(),
        's': startMs,
        'e': endMs,
        'cap': isCaption,
        'lane': lane,
        'z': zIndex,
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
        italic: (j['i'] as bool?) ?? false,
        align: (j['al'] as String?) ?? 'center',
        bg: (j['bg'] as bool?) ?? false,
        bgColor: Color((j['bgc'] as num?)?.toInt() ?? 0xFF000000),
        startMs: (j['s'] as num?)?.toInt() ?? 0,
        endMs: (j['e'] as num?)?.toInt() ?? 0,
        isCaption: (j['cap'] as bool?) ?? false,
        lane: (j['lane'] as num?)?.toInt() ?? 0,
        zIndex: (j['z'] as num?)?.toInt() ?? 100,
        fontFamily: j['ff'] as String?,
        lineWords: (j['lw'] as List?)?.map((e) => e.toString()).toList(),
        highlightWord: (j['hw'] as num?)?.toInt(),
      );

  TextStyle style(double frameH) => TextStyle(
        color: color,
        fontFamily: fontFamily,
        fontSize: fontSize * frameH,
        fontWeight: bold ? FontWeight.w800 : FontWeight.w500,
        fontStyle: italic ? FontStyle.italic : FontStyle.normal,
        height: 1.15,
        shadows: bg
            ? null
            : const [Shadow(color: Colors.black, blurRadius: 3, offset: Offset(0, 1))],
      );

  /// Bright accent for the currently-spoken karaoke word.
  static const Color karaokeHi = Color(0xFFFFE14D);

  /// [align] as a Flutter alignment — used by BOTH the preview and the export
  /// bake, so a left-aligned block reads the same in each.
  TextAlign get textAlign => switch (align) {
        'left' => TextAlign.left,
        'right' => TextAlign.right,
        _ => TextAlign.center,
      };

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
      textAlign: textAlign,
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
/// Common visual overlay model. Images and videos share timing, transforms,
/// timeline lanes and visual z-order; only their media payload differs.
class ImageOverlay {
  final Uint8List? bytes;
  final String? videoPath;
  double x; // 0..1 (center)
  double y; // 0..1 (center)
  double scale; // width as a fraction of the frame width
  double rotation;
  double opacity;
  double volume;
  double speed;
  double cropL, cropT, cropR, cropB;
  /// Background removal: 0 = off, 1 = auto (ML person segmentation), 2 = manual brush.
  int bgMode;
  /// Path to a manual brush mask PNG (white = keep, transparent = remove).
  String? maskPath;
  List<BackgroundMaskFrame> maskFrames;
  int startMs;
  int endMs;
  int lane; // vertical lane on the timeline visual track
  int zIndex;

  ImageOverlay({
    this.bytes,
    this.videoPath,
    this.x = 0.5,
    this.y = 0.5,
    this.scale = 0.45,
    this.rotation = 0,
    this.opacity = 1,
    this.volume = 1,
    this.speed = 1,
    this.cropL = 0,
    this.cropT = 0,
    this.cropR = 0,
    this.cropB = 0,
    this.bgMode = 0,
    this.maskPath,
    this.maskFrames = const [],
    required this.startMs,
    required this.endMs,
    this.lane = 0,
    this.zIndex = 0,
  });

  bool get isVideo => videoPath != null && videoPath!.isNotEmpty;

  String? maskAt(int localMs) => maskFrames.isEmpty ? maskPath : nearestMaskPath(maskFrames, localMs);

  bool activeAt(int ms) => ms >= startMs && ms < endMs;

  ImageOverlay copy() => ImageOverlay(
        bytes: bytes,
        videoPath: videoPath,
        x: x,
        y: y,
        scale: scale,
        rotation: rotation,
        opacity: opacity,
        volume: volume,
        speed: speed,
        cropL: cropL,
        cropT: cropT,
        cropR: cropR,
        cropB: cropB,
        bgMode: bgMode,
        maskPath: maskPath,
        maskFrames: List<BackgroundMaskFrame>.from(maskFrames),
        startMs: startMs,
        endMs: endMs,
        lane: lane,
        zIndex: zIndex,
      );

  /// The pixels ride along base64 — an overlay is picked from the device gallery,
  /// so there is no stable path to point at on reload.
  Map<String, dynamic> toJson() => {
        if (bytes != null) 'img': base64Encode(bytes!),
        if (videoPath != null) 'video': videoPath,
        'x': x,
        'y': y,
        'scale': scale,
        'rotation': rotation,
        'opacity': opacity,
        'volume': volume,
        'speed': speed,
        'cropL': cropL,
        'cropT': cropT,
        'cropR': cropR,
        'cropB': cropB,
        'bg': bgMode,
        if (maskPath != null) 'mask': maskPath,
        if (maskFrames.isNotEmpty) 'masks': maskFrames.map((m) => m.toJson()).toList(),
        'start': startMs,
        'end': endMs,
        'lane': lane,
        'z': zIndex,
      };

  factory ImageOverlay.fromJson(Map j) => ImageOverlay(
        bytes: (j['img'] as String?) == null ? null : base64Decode(j['img'] as String),
        videoPath: j['video'] as String?,
        x: (j['x'] as num?)?.toDouble() ?? 0.5,
        y: (j['y'] as num?)?.toDouble() ?? 0.5,
        scale: (j['scale'] as num?)?.toDouble() ?? 0.45,
        rotation: (j['rotation'] as num?)?.toDouble() ?? 0,
        opacity: (j['opacity'] as num?)?.toDouble() ?? 1,
        volume: (j['volume'] as num?)?.toDouble() ?? 1,
        speed: (j['speed'] as num?)?.toDouble() ?? 1,
        cropL: (j['cropL'] as num?)?.toDouble() ?? 0,
        cropT: (j['cropT'] as num?)?.toDouble() ?? 0,
        cropR: (j['cropR'] as num?)?.toDouble() ?? 0,
        cropB: (j['cropB'] as num?)?.toDouble() ?? 0,
        bgMode: (j['bg'] as num?)?.toInt() ?? 0,
        maskPath: j['mask'] as String?,
        maskFrames: maskFramesFromJson(j['masks']),
        startMs: (j['start'] as num?)?.toInt() ?? 0,
        endMs: (j['end'] as num?)?.toInt() ?? 0,
        lane: (j['lane'] as num?)?.toInt() ?? 0,
        zIndex: (j['z'] as num?)?.toInt() ?? 0,
      );

  /// Bake to a full-frame transparent PNG at the OUTPUT resolution (base64, no prefix).
  Future<String> bakePngBase64(int width, int height) async {
    if (bytes == null) return '';
    final codec = await ui.instantiateImageCodec(bytes!);
    final img = (await codec.getNextFrame()).image;
    final iw = img.width.toDouble();
    final ih = img.height.toDouble();
    final drawW = scale * width;
    final drawH = iw > 0 ? drawW * ih / iw : drawW;
    final recorder = ui.PictureRecorder();
    final canvas = Canvas(recorder, Rect.fromLTWH(0, 0, width.toDouble(), height.toDouble()));
    // Keep export placement inside the same composition bounds used by the
    // interactive preview. This also normalises projects saved before the stage
    // started clamping overlay centres.
    final cx = x.clamp(drawW / (2 * width), 1.0 - drawW / (2 * width)).toDouble();
    final cy = y.clamp(drawH / (2 * height), 1.0 - drawH / (2 * height)).toDouble();
    final source = Rect.fromLTRB(
      iw * cropL.clamp(0.0, 0.88),
      ih * cropT.clamp(0.0, 0.88),
      iw * (1 - cropR.clamp(0.0, 0.88)),
      ih * (1 - cropB.clamp(0.0, 0.88)),
    );
    final centre = Offset(cx * width, cy * height);
    canvas.save();
    canvas.translate(centre.dx, centre.dy);
    canvas.rotate(rotation);
    canvas.drawImageRect(
      img,
      source,
      Rect.fromCenter(center: Offset.zero, width: drawW, height: drawH),
      Paint()..color = Color.fromARGB((opacity.clamp(0.0, 1.0) * 255).round(), 255, 255, 255),
    );
    canvas.restore();
    // Apply background removal mask: draw the mask with [BlendMode.dstIn] so
    // only pixels where the mask is opaque survive — the rest becomes transparent.
    if (bgMode > 0 && maskPath != null) {
      try {
        final maskBytes = await File(maskPath!).readAsBytes();
        final maskCodec = await ui.instantiateImageCodec(maskBytes);
        final maskImg = (await maskCodec.getNextFrame()).image;
        canvas.save();
        canvas.translate(centre.dx, centre.dy);
        canvas.rotate(rotation);
        canvas.drawImageRect(
          maskImg,
          Rect.fromLTWH(0, 0, maskImg.width.toDouble(), maskImg.height.toDouble()),
          Rect.fromCenter(center: Offset.zero, width: drawW, height: drawH),
          Paint()..blendMode = BlendMode.dstIn,
        );
        canvas.restore();
        maskImg.dispose();
      } catch (_) {}
    }
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
    final child = Text.rich(t.textSpan(frame.height), textAlign: t.textAlign);
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
