import 'dart:async';
import 'dart:convert';

import 'package:flutter/services.dart';

/// A timeline filmstrip frame: a small JPEG at a source-time (ms).
class ThumbFrame {
  final int ms;
  final Uint8List jpeg;
  ThumbFrame(this.ms, this.jpeg);
}

/// Everything the timeline needs to DRAW one media source: its filmstrip frames,
/// its amplitude peaks, and the duration those were sampled over (so a clip's
/// [in,out] window can be sliced out of them). Cached per source — every appended
/// video and every imported audio track gets its own, not just the base clip.
class MediaPeaks {
  final List<double> peaks; // normalized 0..1, spanning the whole source
  final int durMs; // the source's real duration, 0 while unknown
  final List<ThumbFrame> thumbs; // empty for audio-only sources
  const MediaPeaks({this.peaks = const [], this.durMs = 0, this.thumbs = const []});

  MediaPeaks copyWith({List<double>? peaks, int? durMs, List<ThumbFrame>? thumbs}) => MediaPeaks(
        peaks: peaks ?? this.peaks,
        durMs: durMs ?? this.durMs,
        thumbs: thumbs ?? this.thumbs,
      );
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
  // Ken Burns moving pan/zoom (baked by the native compositor as a time-varying
  // transform). When [kb], framing lerps (kbFromScale @ kbFromCx,kbFromCy) →
  // (kbToScale @ kbToCx,kbToCy) across the clip. scale ≥1; centres 0..1 (.5=mid).
  final bool kb;
  final double kbFromScale, kbToScale, kbFromCx, kbFromCy, kbToCx, kbToCy;
  /// Colour adjust: brightness/contrast -1..1 (0 = off), saturation 0..2 (1 = off).
  final double brightness, contrast, saturation;
  /// Fade from / to black at this clip's own edges (ms).
  final int fadeInMs, fadeOutMs;
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
    this.kb = false,
    this.kbFromScale = 1.0,
    this.kbToScale = 1.0,
    this.kbFromCx = 0.5,
    this.kbFromCy = 0.5,
    this.kbToCx = 0.5,
    this.kbToCy = 0.5,
    this.brightness = 0.0,
    this.contrast = 0.0,
    this.saturation = 1.0,
    this.fadeInMs = 0,
    this.fadeOutMs = 0,
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
        'kb': kb,
        'kbFromScale': kbFromScale,
        'kbToScale': kbToScale,
        'kbFromCx': kbFromCx,
        'kbFromCy': kbFromCy,
        'kbToCx': kbToCx,
        'kbToCy': kbToCy,
        'brightness': brightness,
        'contrast': contrast,
        'saturation': saturation,
        'fadeInMs': fadeInMs,
        'fadeOutMs': fadeOutMs,
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

  /// Decode a sharp source still for crop editing (native caps only extreme 4K
  /// sources to keep the UI process safe). Null means the sheet uses its fallback.
  Future<Uint8List?> frame(String uri, int timeMs) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('frame', {'uri': uri, 'timeMs': timeMs});
      final jpeg = r?['jpeg'] as String?;
      return jpeg == null ? null : base64Decode(jpeg);
    } catch (_) {
      return null;
    }
  }

  /// Auto background removal via ML Kit. Returns a mask PNG path (white =
  /// person, transparent = background) at source resolution.
  Future<String?> removeBackground(String uri, int timeMs) async {
    try {
      final r = await _m.invokeMethod<Map<dynamic, dynamic>>('removeBackground', {'uri': uri, 'timeMs': timeMs});
      return r?['path'] as String?;
    } catch (_) {
      return null;
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
