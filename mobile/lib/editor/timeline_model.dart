import 'package:flutter/foundation.dart';

import '../native/exporter.dart';
import '../native/player.dart';
import 'background_mask.dart';

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
  /// Duration of this clip's own source. This must not use the project's first
  /// imported source: appended clips may be from entirely different media.
  int mediaDurationMs;
  /// Cutout: 0 = off, 1 = auto, 2 = manual. Masks are local to this clip.
  int bgMode;
  String? maskPath;
  List<BackgroundMaskFrame> maskFrames;
  double speed;
  double volume;
  double cropL, cropT, cropR, cropB; // fractions cropped from each edge (0..~0.9)
  // Ken Burns moving pan/zoom. When [kb] is on, preview + export interpolate the
  // framing from (kbFromScale @ kbFromCx,kbFromCy) to (kbToScale @ kbToCx,kbToCy)
  // linearly across the clip's span. scale ≥1 (1 = whole frame); cx/cy are the
  // visible-window CENTRE in normalized source coords (0..1, .5 = middle). A live
  // pan REPLACES any static crop on the same clip.
  bool kb;
  double kbFromScale, kbToScale, kbFromCx, kbFromCy, kbToCx, kbToCy;

  /// Colour adjust: brightness/contrast are -1..1 (0 = untouched), saturation is
  /// 0..2 (1 = untouched). Applied in the preview and baked on export.
  double brightness, contrast, saturation;

  /// Fade from / to black at this clip's own edges (ms, 0 = none).
  int fadeInMs, fadeOutMs;
  EcClip(
    this.sourcePath,
    this.inMs,
    this.outMs, {
    this.mediaDurationMs = 0,
    this.bgMode = 0,
    this.maskPath,
    this.maskFrames = const [],
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
  });

  int get lengthMs => (outMs - inMs) < 0 ? 0 : (outMs - inMs); // source span
  int get timelineLenMs {
    final s = speed <= 0 ? 1.0 : speed;
    return (lengthMs / s).round();
  }

  bool get hasCrop => cropL > 0 || cropT > 0 || cropR > 0 || cropB > 0;
  bool get hasKenBurns => kb;
  String? maskAt(int localMs) => maskFrames.isEmpty ? maskPath : nearestMaskPath(maskFrames, localMs);

  EcClip copy() => EcClip(sourcePath, inMs, outMs,
      mediaDurationMs: mediaDurationMs,
      bgMode: bgMode,
      maskPath: maskPath,
      maskFrames: List<BackgroundMaskFrame>.from(maskFrames),
      speed: speed,
      volume: volume,
      cropL: cropL,
      cropT: cropT,
      cropR: cropR,
      cropB: cropB,
      kb: kb,
      kbFromScale: kbFromScale,
      kbToScale: kbToScale,
      kbFromCx: kbFromCx,
      kbFromCy: kbFromCy,
      kbToCx: kbToCx,
      kbToCy: kbToCy,
      brightness: brightness,
      contrast: contrast,
      saturation: saturation,
      fadeInMs: fadeInMs,
      fadeOutMs: fadeOutMs);

  Map<String, dynamic> toJson() => {
        'src': sourcePath,
        'in': inMs,
        'out': outMs,
        'dur': mediaDurationMs,
        'bg': bgMode,
        if (maskPath != null) 'mask': maskPath,
        if (maskFrames.isNotEmpty) 'masks': maskFrames.map((m) => m.toJson()).toList(),
        'speed': speed,
        'vol': volume,
        'cl': cropL,
        'cropT': cropT,
        'cr': cropR,
        'cb': cropB,
        'kb': kb,
        'br': brightness,
        'contrast': contrast,
        'sa': saturation,
        'fi': fadeInMs,
        'fo': fadeOutMs,
        'kfs': kbFromScale,
        'kts': kbToScale,
        'kfx': kbFromCx,
        'kfy': kbFromCy,
        'ktx': kbToCx,
        'kty': kbToCy,
      };

  factory EcClip.fromJson(Map j) => EcClip(
        j['src'] as String,
        (j['in'] as num).toInt(),
        (j['out'] as num).toInt(),
        mediaDurationMs: (j['dur'] as num?)?.toInt() ?? (j['out'] as num?)?.toInt() ?? 0,
        bgMode: (j['bg'] as num?)?.toInt() ?? 0,
        maskPath: j['mask'] as String?,
        maskFrames: maskFramesFromJson(j['masks']),
        speed: (j['speed'] as num?)?.toDouble() ?? 1.0,
        volume: (j['vol'] as num?)?.toDouble() ?? 1.0,
        cropL: (j['cl'] as num?)?.toDouble() ?? 0,
        cropT: (j['cropT'] as num?)?.toDouble() ?? 0,
        cropR: (j['cr'] as num?)?.toDouble() ?? 0,
        cropB: (j['cb'] as num?)?.toDouble() ?? 0,
        kb: (j['kb'] as bool?) ?? false,
        brightness: (j['br'] as num?)?.toDouble() ?? 0.0,
        // `ct` was unfortunately shared by crop-top and contrast in old saves;
        // it therefore persisted contrast only. Keep that value for compatibility.
        contrast: (j['contrast'] as num?)?.toDouble() ?? (j['ct'] as num?)?.toDouble() ?? 0.0,
        saturation: (j['sa'] as num?)?.toDouble() ?? 1.0,
        fadeInMs: (j['fi'] as num?)?.toInt() ?? 0,
        fadeOutMs: (j['fo'] as num?)?.toInt() ?? 0,
        kbFromScale: (j['kfs'] as num?)?.toDouble() ?? 1.0,
        kbToScale: (j['kts'] as num?)?.toDouble() ?? 1.0,
        kbFromCx: (j['kfx'] as num?)?.toDouble() ?? 0.5,
        kbFromCy: (j['kfy'] as num?)?.toDouble() ?? 0.5,
        kbToCx: (j['ktx'] as num?)?.toDouble() ?? 0.5,
        kbToCy: (j['kty'] as num?)?.toDouble() ?? 0.5,
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
      ..add(EcClip(path, 0, durationMs, mediaDurationMs: durationMs));
    selected = -1;
    notifyListeners();
  }

  /// Fill in the real source duration once the player knows it (import loads a
  /// single "to-end" segment first). Only widens the initial full clip.
  void setDuration(int durationMs) {
    if (durationMs <= 0) return;
    sourceDurationMs = durationMs;
    if (clips.length == 1 && clips[0].outMs <= 0) {
      clips[0]
        ..outMs = durationMs
        ..mediaDurationMs = durationMs;
      notifyListeners();
    }
  }

  int get totalMs => clips.fold(0, (a, c) => a + c.timelineLenMs);

  /// The only placement authority for the primary track. Base clips deliberately
  /// do not carry independently editable start positions: their list order creates
  /// one contiguous composition, so UI, native preview and export cannot disagree
  /// about where a primary clip belongs or accidentally create a black hole.
  Iterable<({EcClip clip, int startMs, int endMs})> get primarySpans sync* {
    var start = 0;
    for (final clip in clips) {
      final end = start + clip.timelineLenMs;
      yield (clip: clip, startMs: start, endMs: end);
      start = end;
    }
  }

  List<PlayerSegment> playerSegments() {
    final out = <PlayerSegment>[];
    for (final span in primarySpans) {
      final c = span.clip;
      out.add(PlayerSegment(
        uri: 'file://${c.sourcePath}',
        startMs: c.inMs,
        endMs: c.outMs, // 0 = to end (unknown duration)
        timelineStartMs: span.startMs,
        timelineEndMs: span.endMs,
        speed: c.speed,
        volume: c.volume,
        maskFrames: c.maskFrames.map((m) => m.toJson()).toList(),
      ));
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
            kb: c.kb,
            kbFromScale: c.kbFromScale,
            kbToScale: c.kbToScale,
            kbFromCx: c.kbFromCx,
            kbFromCy: c.kbFromCy,
            kbToCx: c.kbToCx,
            kbToCy: c.kbToCy,
            brightness: c.brightness,
            contrast: c.contrast,
            saturation: c.saturation,
            fadeInMs: c.fadeInMs,
            fadeOutMs: c.fadeOutMs,
            maskFrames: c.maskFrames.map((m) => m.toJson()).toList(),
          ))
      .toList();

  /// Clip index containing the given timeline position.
  int clipIndexAt(int timelineMs) {
    var i = 0;
    for (final span in primarySpans) {
      if (timelineMs >= span.startMs && timelineMs < span.endMs) return i;
      i++;
    }
    return clips.isEmpty ? -1 : clips.length - 1;
  }

  /// Timeline start (ms) of a clip.
  int clipStartMs(int index) {
    if (index <= 0) return 0;
    if (index >= clips.length) return totalMs;
    var start = 0;
    for (var i = 0; i < index; i++) {
      start += clips[i].timelineLenMs;
    }
    return start;
  }

  /// Return the primary-track insertion boundary nearest [timelineMs].
  ///
  /// Primary clips are contiguous, so inserting at a boundary is the only way
  /// to move a clip onto this track without creating overlap or a gap.
  int primaryInsertIndexAt(int timelineMs) {
    final at = timelineMs.clamp(0, totalMs).toInt();
    var start = 0;
    for (var i = 0; i < clips.length; i++) {
      final end = start + clips[i].timelineLenMs;
      if (at <= start) return i;
      if (at < end) {
        final before = at - start;
        final after = end - at;
        return before <= after ? i : i + 1;
      }
      start = end;
    }
    return clips.length;
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
    c.kb = false; // a manual crop / punch-in replaces any Ken Burns pan
    notifyListeners();
  }

  /// Apply a Ken Burns moving pan/zoom to a clip: framing glides from
  /// (fromScale @ fromCx,fromCy) to (toScale @ toCx,toCy) over the clip. Scale ≥1
  /// (1 = whole frame); centres are 0..1 (.5 = middle). Clears any static crop.
  void setKenBurns(int index,
      {required double fromScale,
      required double toScale,
      required double fromCx,
      required double fromCy,
      required double toCx,
      required double toCy}) {
    if (index < 0 || index >= clips.length) return;
    final c = clips[index];
    c.kb = true;
    c.kbFromScale = fromScale.clamp(1.0, 4.0);
    c.kbToScale = toScale.clamp(1.0, 4.0);
    c.kbFromCx = fromCx.clamp(0.0, 1.0);
    c.kbFromCy = fromCy.clamp(0.0, 1.0);
    c.kbToCx = toCx.clamp(0.0, 1.0);
    c.kbToCy = toCy.clamp(0.0, 1.0);
    c.cropL = c.cropT = c.cropR = c.cropB = 0; // pan owns the framing now
    notifyListeners();
  }

  /// Turn a clip's Ken Burns pan off (back to full frame / static crop).
  void clearKenBurns(int index) {
    if (index < 0 || index >= clips.length) return;
    if (!clips[index].kb) return;
    clips[index].kb = false;
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
    if (outMs != null) {
      final max = c.mediaDurationMs > 0 ? c.mediaDurationMs : outMs;
      c.outMs = outMs.clamp(c.inMs + 100, max);
    }
    notifyListeners();
  }

  /// Append another source as a clip at the end of the timeline (multi-clip sequencing).
  void appendClip(String path, int durationMs) {
    if (durationMs <= 0) return;
    clips.add(EcClip(path, 0, durationMs, mediaDurationMs: durationMs));
    notifyListeners();
  }

  /// Reorder a clip within the sequence (timeline drag-to-reorder). Moves the clip
  /// at [from] so it lands at index [to], shifting the others. Keeps the moved clip
  /// selected. No-op if the indices are equal or out of range.
  void moveClip(int from, int to) {
    if (from < 0 || from >= clips.length) return;
    to = to.clamp(0, clips.length - 1);
    if (from == to) return;
    final c = clips.removeAt(from);
    clips.insert(to, c);
    selected = to;
    notifyListeners();
  }

  /// Move a primary clip into another track. A composition always retains one
  /// primary segment; without it the editor has no base duration or canvas.
  EcClip? takePrimaryClip(int index) {
    if (index < 0 || index >= clips.length || clips.length <= 1) return null;
    final clip = clips.removeAt(index);
    selected = -1;
    notifyListeners();
    return clip;
  }

  /// Insert a video overlay into the contiguous primary sequence. Its requested
  /// timeline time maps to an insertion boundary; neighbouring clips ripple.
  void insertPrimaryClip(int index, EcClip clip) {
    final target = index.clamp(0, clips.length).toInt();
    clips.insert(target, clip);
    selected = target;
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
