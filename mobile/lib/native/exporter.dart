import 'dart:async';

import 'package:flutter/services.dart';

/// A timed full-frame overlay (caption / text / image) baked to a base64 PNG in Dart.
class ExportOverlay {
  final String base64; // PNG, no data: prefix, baked at the OUTPUT resolution
  final int startMs;
  final int endMs;
  const ExportOverlay({required this.base64, required this.startMs, required this.endMs});
  Map<String, dynamic> toMap() => {'base64': base64, 'startMs': startMs, 'endMs': endMs};
}

/// A base-video or audio segment for the export composition.
class ExportSegment {
  final String uri;
  final int startMs;
  final int endMs;
  const ExportSegment({required this.uri, required this.startMs, required this.endMs});
  Map<String, dynamic> toMap() => {'uri': uri, 'startMs': startMs, 'endMs': endMs};
}

class ExportSpec {
  final List<ExportSegment> segments;
  final List<ExportOverlay> captions;
  final List<ExportOverlay> images;
  final List<ExportSegment> audioTracks;
  final int width;
  final int height;
  final String filename;

  const ExportSpec({
    required this.segments,
    this.captions = const [],
    this.images = const [],
    this.audioTracks = const [],
    required this.width,
    required this.height,
    required this.filename,
  });

  Map<String, dynamic> toMap() => {
        'segments': segments.map((s) => s.toMap()).toList(),
        'captions': captions.map((o) => o.toMap()).toList(),
        'images': images.map((o) => o.toMap()).toList(),
        'audioTracks': audioTracks.map((s) => s.toMap()).toList(),
        'width': width,
        'height': height,
        'filename': filename,
      };
}

class ExportResult {
  final String path;
  final String? savedTo;
  final int? durationMs;
  const ExportResult(this.path, this.savedTo, this.durationMs);
}

/// Dart side of the native Media3 Transformer export (see EcExport.kt).
class NativeExporter {
  static const MethodChannel _m = MethodChannel('ec/export');
  static const EventChannel _e = EventChannel('ec/export/events');

  Future<bool> ping() async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('ping');
      return r?['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  Future<ExportResult> export(ExportSpec spec, {void Function(double pct)? onProgress}) async {
    StreamSubscription<dynamic>? sub;
    if (onProgress != null) {
      sub = _e.receiveBroadcastStream().listen((ev) {
        final p = ((ev as Map)['percent'] as num?)?.toDouble() ?? 0;
        onProgress(p);
      });
    }
    try {
      final res = await _m.invokeMethod<Map<dynamic, dynamic>>('export', spec.toMap());
      final map = (res ?? {}).cast<String, dynamic>();
      return ExportResult(
        map['path'] as String? ?? '',
        map['savedTo'] as String?,
        (map['durationMs'] as num?)?.toInt(),
      );
    } finally {
      await sub?.cancel();
    }
  }
}
