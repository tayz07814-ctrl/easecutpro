import 'package:flutter/foundation.dart';

import '../native/exporter.dart';
import '../native/player.dart';

/// A trimmed slice of the source video placed on the base track.
class EcClip {
  final String sourcePath; // absolute file path (no file:// prefix)
  int inMs; // source in-point
  int outMs; // source out-point (exclusive)
  EcClip(this.sourcePath, this.inMs, this.outMs);
  int get lengthMs => (outMs - inMs) < 0 ? 0 : (outMs - inMs);
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

  int get totalMs => clips.fold(0, (a, c) => a + c.lengthMs);

  List<PlayerSegment> playerSegments() {
    final out = <PlayerSegment>[];
    int t = 0;
    for (final c in clips) {
      final len = c.lengthMs > 0 ? c.lengthMs : 0;
      out.add(PlayerSegment(
        uri: 'file://${c.sourcePath}',
        startMs: c.inMs,
        endMs: c.outMs, // 0 = to end (unknown duration)
        timelineStartMs: t,
        timelineEndMs: t + len,
      ));
      t += len;
    }
    return out;
  }

  List<ExportSegment> exportSegments() => clips
      .map((c) => ExportSegment(uri: 'file://${c.sourcePath}', startMs: c.inMs, endMs: c.outMs))
      .toList();

  /// Clip index containing the given timeline position.
  int clipIndexAt(int timelineMs) {
    int t = 0;
    for (int i = 0; i < clips.length; i++) {
      if (timelineMs >= t && timelineMs < t + clips[i].lengthMs) return i;
      t += clips[i].lengthMs;
    }
    return clips.isEmpty ? -1 : clips.length - 1;
  }

  /// Timeline start (ms) of a clip.
  int clipStartMs(int index) {
    int t = 0;
    for (int i = 0; i < index && i < clips.length; i++) {
      t += clips[i].lengthMs;
    }
    return t;
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
      if (timelineMs > t && timelineMs < t + c.lengthMs) {
        final srcCut = c.inMs + (timelineMs - t);
        clips
          ..removeAt(i)
          ..insert(i, EcClip(c.sourcePath, srcCut, c.outMs))
          ..insert(i, EcClip(c.sourcePath, c.inMs, srcCut));
        selected = i;
        notifyListeners();
        return true;
      }
      t += c.lengthMs;
    }
    return false;
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
