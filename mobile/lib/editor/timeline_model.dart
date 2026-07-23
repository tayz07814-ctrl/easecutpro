import 'package:flutter/foundation.dart';

import '../native/exporter.dart';
import '../native/player.dart';

/// A trimmed slice of the source video placed on the base track.
///
/// Two time domains: SOURCE ([inMs]..[outMs], [lengthMs]) is the untouched media,
/// while TIMELINE ([timelineLenMs]) is what the editor shows — the source length
/// divided by [speed] (a 2× clip occupies half the timeline). [volume] and the
/// [cropL]/[cropT]/[cropR]/[cropB] edge fractions are applied on export/preview.
class EcClip {
  final String sourcePath; // absolute file path (no file:// prefix)
  int inMs; // source in-point
  int outMs; // source out-point (exclusive)
  double speed;
  double volume;
  double cropL, cropT, cropR, cropB; // fractions cropped from each edge (0..~0.9)
  EcClip(
    this.sourcePath,
    this.inMs,
    this.outMs, {
    this.speed = 1.0,
    this.volume = 1.0,
    this.cropL = 0,
    this.cropT = 0,
    this.cropR = 0,
    this.cropB = 0,
  });

  int get lengthMs => (outMs - inMs) < 0 ? 0 : (outMs - inMs); // source span
  int get timelineLenMs {
    final s = speed <= 0 ? 1.0 : speed;
    return (lengthMs / s).round();
  }

  bool get hasCrop => cropL > 0 || cropT > 0 || cropR > 0 || cropB > 0;

  EcClip copy() => EcClip(sourcePath, inMs, outMs,
      speed: speed, volume: volume, cropL: cropL, cropT: cropT, cropR: cropR, cropB: cropB);

  Map<String, dynamic> toJson() => {
        'src': sourcePath,
        'in': inMs,
        'out': outMs,
        'speed': speed,
        'vol': volume,
        'cl': cropL,
        'ct': cropT,
        'cr': cropR,
        'cb': cropB,
      };

  factory EcClip.fromJson(Map j) => EcClip(
        j['src'] as String,
        (j['in'] as num).toInt(),
        (j['out'] as num).toInt(),
        speed: (j['speed'] as num?)?.toDouble() ?? 1.0,
        volume: (j['vol'] as num?)?.toDouble() ?? 1.0,
        cropL: (j['cl'] as num?)?.toDouble() ?? 0,
        cropT: (j['ct'] as num?)?.toDouble() ?? 0,
        cropR: (j['cr'] as num?)?.toDouble() ?? 0,
        cropB: (j['cb'] as num?)?.toDouble() ?? 0,
      );
}

/// The editor's base-video timeline: an ordered list of [Clip]s. This is the
/// single model behind preview, export, manual edits (split/trim/delete) AND
/// Cut Lord (which replaces the clips with the kept ranges).
class TimelineModel extends ChangeNotifier {
  final List<EcClip> clips = [];
  String? sourcePath;
  int sourceDurationMs = 0;
  int selected = -1; // selected clip index, -1 = none

  bool get hasBase => clips.isNotEmpty;

  /// One full clip covering the whole source. durationMs may be 0 (unknown) until
  /// the player reports it; [setDuration] fills it in.
  void setBase(String path, int durationMs) {
    sourcePath = path;
    sourceDurationMs = durationMs;
    clips
      ..clear()
      ..add(EcClip(path, 0, durationMs));
    selected = -1;
    notifyListeners();
  }

  /// Fill in the real source duration once the player knows it (import loads a
  /// single "to-end" segment first). Only widens the initial full clip.
  void setDuration(int durationMs) {
    if (durationMs <= 0) return;
    sourceDurationMs = durationMs;
    if (clips.length == 1 && clips[0].outMs <= 0) {
      clips[0].outMs = durationMs;
      notifyListeners();
    }
  }

  int get totalMs => clips.fold(0, (a, c) => a + c.timelineLenMs);

  List<PlayerSegment> playerSegments() {
    final out = <PlayerSegment>[];
    int t = 0;
    for (final c in clips) {
      final len = c.timelineLenMs > 0 ? c.timelineLenMs : 0;
      out.add(PlayerSegment(
        uri: 'file://${c.sourcePath}',
        startMs: c.inMs,
        endMs: c.outMs, // 0 = to end (unknown duration)
        timelineStartMs: t,
        timelineEndMs: t + len,
        speed: c.speed,
        volume: c.volume,
      ));
      t += len;
    }
    return out;
  }

  List<ExportSegment> exportSegments() => clips
      .map((c) => ExportSegment(
            uri: 'file://${c.sourcePath}',
            startMs: c.inMs,
            endMs: c.outMs,
            speed: c.speed,
            volume: c.volume,
            cropL: c.cropL,
            cropT: c.cropT,
            cropR: c.cropR,
            cropB: c.cropB,
          ))
      .toList();

  /// Clip index containing the given timeline position.
  int clipIndexAt(int timelineMs) {
    int t = 0;
    for (int i = 0; i < clips.length; i++) {
      if (timelineMs >= t && timelineMs < t + clips[i].timelineLenMs) return i;
      t += clips[i].timelineLenMs;
    }
    return clips.isEmpty ? -1 : clips.length - 1;
  }

  /// Timeline start (ms) of a clip.
  int clipStartMs(int index) {
    int t = 0;
    for (int i = 0; i < index && i < clips.length; i++) {
      t += clips[i].timelineLenMs;
    }
    return t;
  }

  /// Map a SOURCE-time (ms) to the EDITED timeline position; null if it lies in a
  /// removed region (used to place captions correctly after Cut Lord).
  int? sourceToEdited(int sourceMs) {
    int t = 0;
    for (final c in clips) {
      if (sourceMs >= c.inMs && sourceMs < c.outMs) {
        final s = c.speed <= 0 ? 1.0 : c.speed;
        return t + ((sourceMs - c.inMs) / s).round();
      }
      t += c.timelineLenMs;
    }
    return null;
  }

  void select(int index) {
    selected = (index >= 0 && index < clips.length) ? index : -1;
    notifyListeners();
  }

  /// Split the clip that contains [timelineMs] into two at that point.
  bool splitAt(int timelineMs) {
    int t = 0;
    for (int i = 0; i < clips.length; i++) {
      final c = clips[i];
      if (timelineMs > t && timelineMs < t + c.timelineLenMs) {
        final s = c.speed <= 0 ? 1.0 : c.speed;
        final srcCut = c.inMs + ((timelineMs - t) * s).round();
        final left = c.copy()..outMs = srcCut;
        final right = c.copy()..inMs = srcCut;
        clips
          ..removeAt(i)
          ..insert(i, right)
          ..insert(i, left);
        selected = i;
        notifyListeners();
        return true;
      }
      t += c.timelineLenMs;
    }
    return false;
  }

  /// Per-clip tools (Speed / Volume / Crop).
  void setSpeed(int index, double speed) {
    if (index < 0 || index >= clips.length) return;
    clips[index].speed = speed.clamp(0.1, 8.0);
    notifyListeners();
  }

  void setVolume(int index, double volume) {
    if (index < 0 || index >= clips.length) return;
    clips[index].volume = volume.clamp(0.0, 4.0);
    notifyListeners();
  }

  void setCrop(int index, {double? l, double? t, double? r, double? b}) {
    if (index < 0 || index >= clips.length) return;
    final c = clips[index];
    if (l != null) c.cropL = l.clamp(0.0, 0.9);
    if (t != null) c.cropT = t.clamp(0.0, 0.9);
    if (r != null) c.cropR = r.clamp(0.0, 0.9);
    if (b != null) c.cropB = b.clamp(0.0, 0.9);
    notifyListeners();
  }

  void deleteClip(int index) {
    if (index < 0 || index >= clips.length || clips.length <= 1) return;
    clips.removeAt(index);
    selected = -1;
    notifyListeners();
  }

  /// Nudge a clip's trim in/out (source ms), keeping at least 100ms.
  void trim(int index, {int? inMs, int? outMs}) {
    if (index < 0 || index >= clips.length) return;
    final c = clips[index];
    if (inMs != null) c.inMs = inMs.clamp(0, c.outMs - 100);
    if (outMs != null) c.outMs = outMs.clamp(c.inMs + 100, sourceDurationMs > 0 ? sourceDurationMs : outMs);
    notifyListeners();
  }

  /// Append another source as a clip at the end of the timeline (multi-clip sequencing).
  void appendClip(String path, int durationMs) {
    if (durationMs <= 0) return;
    clips.add(EcClip(path, 0, durationMs));
    notifyListeners();
  }

  /// Replace the whole clip list (undo/redo, restore a snapshot).
  void restore(List<EcClip> next) {
    clips
      ..clear()
      ..addAll(next);
    selected = -1;
    notifyListeners();
  }

  /// Cut Lord: replace the base with only these kept source ranges (in order).
  void applyKeepRanges(List<List<int>> rangesMs) {
    if (sourcePath == null) return;
    final next = <EcClip>[];
    for (final r in rangesMs) {
      if (r.length == 2 && r[1] > r[0]) next.add(EcClip(sourcePath!, r[0], r[1]));
    }
    if (next.isEmpty) return; // never wipe the timeline to nothing
    clips
      ..clear()
      ..addAll(next);
    selected = -1;
    notifyListeners();
  }
}
