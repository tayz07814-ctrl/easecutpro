import 'dart:async';

import 'package:flutter/services.dart'; // provides Size + platform channels

/// One base-track segment: a trimmed slice of a source, placed on the timeline.
class PlayerSegment {
  final String uri; // file:// path
  final int startMs; // trim in-point in the source
  final int endMs; // trim out-point in the source (0 = to end)
  final int timelineStartMs; // where it sits on the global timeline
  final int timelineEndMs;
  final double speed; // playback speed (timeline span = source span / speed)
  final double volume; // 0..4 gain
  final List<Map<String, dynamic>> maskFrames;

  const PlayerSegment({
    required this.uri,
    required this.startMs,
    required this.endMs,
    required this.timelineStartMs,
    required this.timelineEndMs,
    this.speed = 1.0,
    this.volume = 1.0,
    this.maskFrames = const [],
  });

  Map<String, dynamic> toMap() => {
        'uri': uri,
        'startMs': startMs,
        'endMs': endMs,
        'timelineStartMs': timelineStartMs,
        'timelineEndMs': timelineEndMs,
        'speed': speed,
        'volume': volume,
        'maskFrames': maskFrames,
      };
}

/// A ~10 Hz snapshot of the native player's position/state.
class PlayerState {
  final int timelineMs;
  final int durationMs;
  final bool playing;
  final bool ended;
  final bool ready;
  const PlayerState(
      this.timelineMs, this.durationMs, this.playing, this.ended, this.ready);
}

/// Dart side of the native ExoPlayer → Flutter texture bridge (see EcPlayer.kt).
/// Playback is decoded by the phone's hardware codecs and rendered into a Flutter
/// texture, so the preview composites like any widget — no WebView, no stuck surface.
class NativePlayer {
  static const MethodChannel _m = MethodChannel('ec/player');
  static const EventChannel _e = EventChannel('ec/player/events');

  int? textureId;
  double aspectRatio = 9 / 16;
  Size videoSize = const Size(1080, 1920);

  final StreamController<PlayerState> _states = StreamController.broadcast();
  final StreamController<Size> _sizes = StreamController.broadcast();
  Stream<PlayerState> get states => _states.stream;
  Stream<Size> get sizes => _sizes.stream;

  StreamSubscription<dynamic>? _sub;

  Future<int> create() async {
    final res = await _m.invokeMethod<Map<dynamic, dynamic>>('create');
    textureId = (res?['textureId'] as num?)?.toInt();
    _sub ??= _e.receiveBroadcastStream().listen(_onEvent);
    return textureId ?? -1;
  }

  void _onEvent(dynamic ev) {
    final map = (ev as Map).cast<String, dynamic>();
    if (map['event'] == 'size') {
      final w = (map['width'] as num?)?.toDouble() ?? 0;
      final h = (map['height'] as num?)?.toDouble() ?? 0;
      if (w > 0 && h > 0) {
        aspectRatio = w / h;
        videoSize = Size(w, h);
        _sizes.add(videoSize);
      }
    } else {
      _states.add(PlayerState(
        (map['timelineMs'] as num?)?.toInt() ?? 0,
        (map['durationMs'] as num?)?.toInt() ?? 0,
        map['playing'] == true,
        map['ended'] == true,
        map['ready'] == true,
      ));
    }
  }

  Future<void> load(List<PlayerSegment> segs, {List<Map<String, dynamic>> audioTracks = const []}) =>
      _m.invokeMethod('load', {
        'segments': segs.map((s) => s.toMap()).toList(),
        'audioTracks': audioTracks,
      });

  Future<void> play() => _m.invokeMethod('play');
  Future<void> pause() => _m.invokeMethod('pause');
  Future<void> seek(int timelineMs) =>
      _m.invokeMethod('seek', {'timelineMs': timelineMs});

  Future<void> release() async {
    await _sub?.cancel();
    _sub = null;
    try {
      await _m.invokeMethod('release');
    } catch (_) {}
    textureId = null;
  }

  void dispose() {
    _states.close();
    _sizes.close();
  }
}
