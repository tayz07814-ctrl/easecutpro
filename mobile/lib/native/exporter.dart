import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

/// A timeline filmstrip frame: a small JPEG at a source-time (ms).
class ThumbFrame {
  final int ms;
  final Uint8List jpeg;
  ThumbFrame(this.ms, this.jpeg);
}

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
  final double speed; // 1 = normal
  final double volume; // 1 = unity gain, 0 = mute
  final double cropL, cropT, cropR, cropB; // fractions cropped from each edge
  final int timelineStartMs; // audio: lead-in offset before the track plays
  const ExportSegment({
    required this.uri,
    required this.startMs,
    required this.endMs,
    this.speed = 1.0,
    this.volume = 1.0,
    this.cropL = 0,
    this.cropT = 0,
    this.cropR = 0,
    this.cropB = 0,
    this.timelineStartMs = 0,
  });
  Map<String, dynamic> toMap() => {
        'uri': uri,
        'startMs': startMs,
        'endMs': endMs,
        'speed': speed,
        'volume': volume,
        'cropL': cropL,
        'cropT': cropT,
        'cropR': cropR,
        'cropB': cropB,
        'timelineStartMs': timelineStartMs,
      };
}

class ExportSpec {
  final List<ExportSegment> segments;
  final List<ExportOverlay> captions;
  final List<ExportOverlay> images;
  final List<ExportSegment> audioTracks;
  final int width;
  final int height;
  final int fps; // 0 = source
  final int bitrate; // bps, 0 = auto
  final String filename;

  const ExportSpec({
    required this.segments,
    this.captions = const [],
    this.images = const [],
    this.audioTracks = const [],
    required this.width,
    required this.height,
    this.fps = 0,
    this.bitrate = 0,
    required this.filename,
  });

  Map<String, dynamic> toMap() => {
        'segments': segments.map((s) => s.toMap()).toList(),
        'captions': captions.map((o) => o.toMap()).toList(),
        'images': images.map((o) => o.toMap()).toList(),
        'audioTracks': audioTracks.map((s) => s.toMap()).toList(),
        'width': width,
        'height': height,
        'fps': fps,
        'bitrate': bitrate,
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

  /// Extract the clip's audio to a compact .m4a for transcription (Cut Lord).
  Future<String> extractAudio(String uri) async {
    final r = await _m.invokeMethod<Map<dynamic, dynamic>>('extractAudio', {'uri': uri});
    final path = r?['path'] as String?;
    if (path == null) throw Exception('audio extract returned no path');
    return path;
  }

  /// Extract [count] evenly-spaced filmstrip frames from the source.
  Future<List<ThumbFrame>> thumbnails(String uri, int count) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('thumbnails', {'uri': uri, 'count': count});
      final frames = (r?['frames'] as List?) ?? [];
      return frames.map((f) {
        final m = f as Map;
        return ThumbFrame((m['ms'] as num).toInt(), base64Decode(m['jpeg'] as String));
      }).toList();
    } catch (_) {
      return [];
    }
  }

  /// Probe a media file's duration (ms), 0 if unknown.
  Future<int> duration(String uri) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('duration', {'uri': uri});
      return (r?['durationMs'] as num?)?.toInt() ?? 0;
    } catch (_) {
      return 0;
    }
  }

  /// Decode the source's audio into [buckets] normalized (0..1) amplitude peaks.
  Future<List<double>> waveform(String uri, {int buckets = 400}) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('waveform', {'uri': uri, 'buckets': buckets});
      final peaks = (r?['peaks'] as List?) ?? [];
      return peaks.map((p) => (p as num).toDouble()).toList();
    } catch (_) {
      return [];
    }
  }

  /// Render a FLAT low-res preview proxy of [segments] (the export's pass-1 base —
  /// trim + concat + crop/speed/size/volume baked, NO overlays, NO extra audio) to a
  /// temp file. [segments] are export-shaped maps (uri/startMs/endMs/speed/volume/
  /// cropL..cropB). Returns the proxy path + its timeline duration (ms), or null on
  /// any failure so callers can fall back to live segment playback.
  Future<({String path, int durationMs})?> renderProxy(
    List<Map<String, dynamic>> segments, {
    int height = 540,
    double aspect = 16 / 9,
  }) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('proxy', {
        'segments': segments,
        'height': height,
        'aspect': aspect,
      });
      final path = r?['path'] as String?;
      if (path == null || path.isEmpty) return null;
      final dur = (r?['durationMs'] as num?)?.toInt() ?? 0;
      return (path: path, durationMs: dur);
    } catch (_) {
      return null;
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
