import 'package:flutter/material.dart';

import '../editor/audio_track.dart';
import '../editor/text_overlay.dart';
import '../editor/timeline_model.dart';
import '../native/exporter.dart' show MediaPeaks, ThumbFrame;
import '../theme.dart';

/// CapCut / EaseCut-style timeline: a FIXED red playhead pinned at the centre,
/// with stacked tracks (video filmstrip + waveform, audio, text/captions) that
/// SCROLL under it. Dragging the film scrubs; − / + (and pinch) zoom the scale.
class MiniTimeline extends StatefulWidget {
  final TimelineModel model;
  final String clipName;
  final int positionMs;
  final int totalMs;
  /// Filmstrip frames + amplitude peaks for EVERY source on the timeline, keyed by
  /// the media's bare path — so appended clips and imported audio draw their own
  /// art, not the base clip's (or nothing at all).
  final Map<String, MediaPeaks> media;
  final List<AudioTrack> audios; // extra audio tracks (music / voiceover)
  final int selectedAudio; // -1 = none
  final List<TextOverlay> texts; // text + caption overlays
  final List<ImageOverlay> images; // image / sticker (PiP) overlays
  final ImageOverlay? selectedImage; // image selected on the preview / timeline
  final VoidCallback onScrubStart;
  final ValueChanged<int> onScrub;
  final ValueChanged<int> onScrubEnd;
  final ValueChanged<int> onSelectClip;
  final ValueChanged<TextOverlay>? onSelectText;
  final ValueChanged<ImageOverlay>? onSelectImage;
  final ValueChanged<int>? onSelectAudio;

  /// Hold-drag a main video clip to reorder it in the sequence.
  final VoidCallback? onClipReorderStart;
  final void Function(int from, int to)? onClipReorder;
  final VoidCallback? onClipReorderEnd;

  /// Drag an audio block along the time axis (shift its timeline start by deltaMs).
  final void Function(int index, int deltaMs)? onAudioMove;

  /// Trim an audio block edge (one of the deltas is set).
  final void Function(int index, {int? startDeltaMs, int? endDeltaMs})? onAudioTrim;
  final VoidCallback? onAudioEditStart;
  final VoidCallback? onAudioEditEnd;

  /// Drag a text/caption block along the time axis (shift start+end by deltaMs).
  final void Function(TextOverlay t, int deltaMs)? onOverlayMove;

  /// Trim a text/caption block edge (one of the deltas is set).
  final void Function(TextOverlay t, {int? startDeltaMs, int? endDeltaMs})? onOverlayTrim;
  final VoidCallback? onOverlayEditStart;
  final VoidCallback? onOverlayEditEnd;

  /// Hold-drag an image overlay block along the time axis (shift start+end by deltaMs).
  final void Function(ImageOverlay o, int deltaMs)? onImageMove;

  /// Trim an image overlay block edge (one of the deltas is set).
  final void Function(ImageOverlay o, {int? startDeltaMs, int? endDeltaMs})? onImageTrim;
  final VoidCallback? onImageEditStart;
  final VoidCallback? onImageEditEnd;

  /// Live trim of the selected clip (source ms). Committed on [onTrimEnd].
  final void Function(int index, {int? inMs, int? outMs})? onTrim;
  final VoidCallback? onTrimStart;
  final VoidCallback? onTrimEnd;

  /// CapCut-style track-head tiles, PINNED at the viewport's left edge (they
  /// must stay reachable at any scrub position): mute-all-clips toggle, cover
  /// tile, and the per-lane add shortcuts.
  final bool muted;
  final VoidCallback? onToggleMute;
  final VoidCallback? onAddOverlay;
  final VoidCallback? onAddText;
  final VoidCallback? onAddAudio;

  const MiniTimeline({
    super.key,
    required this.model,
    required this.clipName,
    required this.positionMs,
    required this.totalMs,
    this.media = const {},
    this.audios = const [],
    this.selectedAudio = -1,
    this.texts = const [],
    this.images = const [],
    this.selectedImage,
    required this.onScrubStart,
    required this.onScrub,
    required this.onScrubEnd,
    required this.onSelectClip,
    this.onSelectText,
    this.onSelectImage,
    this.onSelectAudio,
    this.onClipReorderStart,
    this.onClipReorder,
    this.onClipReorderEnd,
    this.onAudioMove,
    this.onAudioTrim,
    this.onAudioEditStart,
    this.onAudioEditEnd,
    this.onOverlayMove,
    this.onOverlayTrim,
    this.onOverlayEditStart,
    this.onOverlayEditEnd,
    this.onImageMove,
    this.onImageTrim,
    this.onImageEditStart,
    this.onImageEditEnd,
    this.onTrim,
    this.onTrimStart,
    this.onTrimEnd,
    this.muted = false,
    this.onToggleMute,
    this.onAddOverlay,
    this.onAddText,
    this.onAddAudio,
  });

  @override
  State<MiniTimeline> createState() => _MiniTimelineState();
}

class _MiniTimelineState extends State<MiniTimeline> {
  static const double _basePxPerMs = 0.09; // 90 px/s at zoom 1
  static const double _clipsH = 54;
  static const double _laneH = 22;

  final ScrollController _sc = ScrollController();
  double _zoom = 1.0;
  bool _userScrolling = false;

  // Long-press "grab" state: which block the user is holding + dragging on the
  // timeline. A grabbed block is raised/highlighted; a plain drag still scrubs.
  String? _grabKind; // 'clip' | 'text' | 'image' | 'audio'
  int _grabIndex = -1; // index into the relevant list (clip index for 'clip')
  double _lpLastDx = 0; // last cumulative long-press dx (to derive per-frame deltas)
  double _grabDx = 0; // px the grabbed clip floats from its slot (follows the finger)
  int _dropIndex = -1; // where a grabbed clip would land if released now

  bool _isGrabbed(String kind, int index) => _grabKind == kind && _grabIndex == index;

  double _pxPerMs = _basePxPerMs;
  double _viewW = 0;
  bool _didInit = false;

  // Two-finger pinch-to-zoom (a passive Listener, so single-finger scrub still scrolls).
  final Map<int, Offset> _pointers = {};
  double _pinchStartDist = 0;
  double _pinchStartZoom = 1;
  bool _pinching = false;

  double _pinchDist() {
    final p = _pointers.values.toList();
    return p.length < 2 ? 0 : (p[0] - p[1]).distance;
  }

  void _onPinchDown(PointerDownEvent e) {
    _pointers[e.pointer] = e.position;
    if (_pointers.length == 2) {
      _pinchStartDist = _pinchDist();
      _pinchStartZoom = _zoom;
      setState(() => _pinching = true);
    }
  }

  void _onPinchMove(PointerMoveEvent e) {
    if (!_pointers.containsKey(e.pointer)) return;
    _pointers[e.pointer] = e.position;
    if (_pinching && _pointers.length >= 2 && _pinchStartDist > 8) {
      _setZoom(_pinchStartZoom * _pinchDist() / _pinchStartDist);
    }
  }

  void _onPinchUp(PointerEvent e) {
    _pointers.remove(e.pointer);
    if (_pointers.length < 2 && _pinching) setState(() => _pinching = false);
  }

  @override
  void initState() {
    super.initState();
    _sc.addListener(() {
      if (mounted) setState(() {}); // (kept for any offset-dependent chrome)
    });
    WidgetsBinding.instance.addPostFrameCallback((_) => _alignToPlayhead());
  }

  @override
  void dispose() {
    _sc.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(MiniTimeline old) {
    super.didUpdateWidget(old);
    if (widget.positionMs != old.positionMs && !_userScrolling) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _alignToPlayhead());
    }
  }

  /// Scroll so the playhead (screen centre) sits on the current position.
  void _alignToPlayhead() {
    if (!_sc.hasClients || _pxPerMs <= 0) return;
    final target = widget.positionMs * _pxPerMs;
    final maxOff = _sc.position.maxScrollExtent;
    final clamped = target.clamp(0.0, maxOff);
    if ((_sc.offset - clamped).abs() > 0.5) _sc.jumpTo(clamped);
  }

  void _setZoom(double z) {
    setState(() => _zoom = z.clamp(0.3, 8.0));
    WidgetsBinding.instance.addPostFrameCallback((_) => _alignToPlayhead());
  }

  int get _total => widget.totalMs > 0 ? widget.totalMs : 1;

  /// This source's cached art ('file://…' and bare paths share one entry).
  MediaPeaks? _art(String path) =>
      widget.media[path.startsWith('file://') ? path.substring(7) : path];

  /// Frames whose source-time falls within a clip's [in,out] (nearest if none).
  List<ThumbFrame> _clipThumbs(EcClip c) {
    final thumbs = _art(c.sourcePath)?.thumbs ?? const <ThumbFrame>[];
    if (thumbs.isEmpty) return const [];
    final inR = thumbs.where((t) => t.ms >= c.inMs && t.ms < c.outMs).toList();
    if (inR.isNotEmpty) return inR;
    final mid = (c.inMs + c.outMs) ~/ 2;
    ThumbFrame nearest = thumbs.first;
    for (final t in thumbs) {
      if ((t.ms - mid).abs() < (nearest.ms - mid).abs()) nearest = t;
    }
    return [nearest];
  }

  /// The slice of a source's peaks covering [inMs,outMs] — works for any source
  /// (base clip, appended video or an audio track), not just the base.
  List<double> _peaksFor(String path, int inMs, int outMs) {
    final art = _art(path);
    if (art == null || art.peaks.isEmpty || art.durMs <= 0) return const [];
    final n = art.peaks.length;
    int a = (inMs / art.durMs * n).floor().clamp(0, n);
    int b = (outMs / art.durMs * n).ceil().clamp(0, n);
    if (b <= a) b = (a + 1).clamp(0, n);
    return art.peaks.sublist(a, b);
  }

  List<double> _clipPeaks(EcClip c) => _peaksFor(c.sourcePath, c.inMs, c.outMs);

  /// A row of fixed-width frame tiles filling [clipW] (a real filmstrip, not a
  /// few stretched frames). Each tile shows the source frame nearest its time.
  Widget _filmstrip(EcClip c, double clipW) {
    final frames = _clipThumbs(c);
    if (frames.isEmpty) return Container(width: clipW, color: const Color(0xFF312A52));
    const tileW = 44.0;
    final n = (clipW / tileW).ceil().clamp(1, 400);
    return Row(
      children: [
        for (int i = 0; i < n; i++)
          SizedBox(
            width: tileW,
            height: double.infinity,
            child: Image.memory(_frameForTile(frames, c, i, n).jpeg,
                fit: BoxFit.cover, gaplessPlayback: true),
          ),
      ],
    );
  }

  ThumbFrame _frameForTile(List<ThumbFrame> frames, EcClip c, int i, int n) {
    if (frames.length == 1) return frames.first;
    final tMs = c.inMs + ((i + 0.5) / n) * (c.outMs - c.inMs);
    ThumbFrame nearest = frames.first;
    for (final f in frames) {
      if ((f.ms - tMs).abs() < (nearest.ms - tMs).abs()) nearest = f;
    }
    return nearest;
  }

  String _fmt(int ms) {
    final s = (ms / 1000).floor();
    final m = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final model = widget.model;
    if (!model.hasBase) {
      return const Center(
        child: Text('Your timeline will appear here',
            style: TextStyle(color: Ec.textFaint, fontSize: 12.5)),
      );
    }
    _pxPerMs = _basePxPerMs * _zoom;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Timecode readout — left-aligned like the web editor; pinch zooms.
        SizedBox(
          height: 30,
          child: Padding(
            padding: const EdgeInsets.only(left: 14),
            child: Align(
              alignment: Alignment.centerLeft,
              child: RichText(
                text: TextSpan(
                  style: const TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      fontFamily: Ec.mono,
                      fontFeatures: [FontFeature.tabularFigures()]),
                  children: [
                    TextSpan(
                        text: _fmt(widget.positionMs),
                        style: const TextStyle(color: Color(0xFFEEF0F7))),
                    TextSpan(
                        text: ' / ${_fmt(widget.totalMs)}',
                        style: const TextStyle(color: Color(0xFF6E6E85))),
                  ],
                ),
              ),
            ),
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) {
              _viewW = c.maxWidth;
              final tracksW = _total * _pxPerMs;
              final side = _viewW / 2; // pad so t=0 and t=total can reach the centre
              if (!_didInit) {
                _didInit = true;
                WidgetsBinding.instance.addPostFrameCallback((_) => _alignToPlayhead());
              }

              // Deterministic lane heights so the pinned track-head tiles line up
              // exactly with their rows (audio rows carry a 3px top margin EACH;
              // text/caption/image lanes pad 3px between stacked lanes only).
              int lanesOfTexts(bool captions) {
                var n = 0;
                for (final t in widget.texts) {
                  if (t.isCaption == captions && t.lane + 1 > n) n = t.lane + 1;
                }
                return n;
              }

              int lanesOfImages() {
                var n = 0;
                for (final o in widget.images) {
                  if (o.lane + 1 > n) n = o.lane + 1;
                }
                return n;
              }

              double stackedH(int n) => n * _laneH + (n - 1) * 3.0;

              // Row specs: (height, pinned tile, scrolling content). Gap rows have
              // neither. Built once, then rendered twice — the content column and
              // the pinned tile column share the same heights, so they can't drift.
              final rows = <(double, Widget?, Widget?)>[];
              rows.add((
                16,
                null,
                CustomPaint(
                  painter: _RulerPainter(
                    pxPerMs: _pxPerMs,
                    totalMs: _total,
                    visibleFromMs: ((_sc.hasClients ? _sc.offset : 0) / _pxPerMs) - _viewW / _pxPerMs,
                    visibleToMs: ((_sc.hasClients ? _sc.offset : 0) / _pxPerMs) + _viewW / _pxPerMs,
                  ),
                  child: const SizedBox.expand(),
                )
              ));
              rows.add((6, null, null));
              rows.add((_clipsH, _muteTile(), _clipsRow(model)));
              // Overlay (image / PiP) lane — ALWAYS present, like the reference.
              rows.add((4, null, null));
              if (widget.images.isNotEmpty) {
                rows.add((
                  stackedH(lanesOfImages()),
                  _gutterIcon(Icons.photo_library_outlined, widget.onAddOverlay),
                  _imageLane(tracksW)
                ));
              } else {
                rows.add((
                  _laneH,
                  _gutterIcon(Icons.photo_library_outlined, widget.onAddOverlay),
                  _ghostRow('＋ Add overlay', widget.onAddOverlay)
                ));
              }
              if (widget.texts.any((t) => t.isCaption)) {
                rows.add((4, null, null));
                rows.add((
                  stackedH(lanesOfTexts(true)),
                  _gutterIcon(Icons.closed_caption_outlined, null),
                  _overlayLane(tracksW, captions: true)
                ));
              }
              rows.add((4, null, null));
              if (widget.texts.any((t) => !t.isCaption)) {
                rows.add((
                  stackedH(lanesOfTexts(false)),
                  _gutterIcon(Icons.title, widget.onAddText),
                  _overlayLane(tracksW, captions: false)
                ));
              } else {
                rows.add((
                  _laneH,
                  _gutterIcon(Icons.title, widget.onAddText),
                  _ghostRow('＋ Add text', widget.onAddText)
                ));
              }
              rows.add((4, null, null));
              if (widget.audios.isNotEmpty) {
                rows.add((
                  widget.audios.length * (_laneH + 3.0),
                  _gutterIcon(Icons.music_note, widget.onAddAudio),
                  _audioLane(tracksW)
                ));
              } else {
                rows.add((
                  _laneH,
                  _gutterIcon(Icons.music_note, widget.onAddAudio),
                  _ghostRow('＋ Add audio', widget.onAddAudio)
                ));
              }
              rows.add((8, null, null));

              return Listener(
                behavior: HitTestBehavior.translucent,
                onPointerDown: _onPinchDown,
                onPointerMove: _onPinchMove,
                onPointerUp: _onPinchUp,
                onPointerCancel: _onPinchUp,
                child: Stack(
                  children: [
                    // The whole track area scrolls VERTICALLY too — more lanes must
                    // never push the audio track out of a short timeline viewport.
                    SingleChildScrollView(
                      physics: _pinching
                          ? const NeverScrollableScrollPhysics()
                          : const ClampingScrollPhysics(),
                      child: Stack(
                        children: [
                          NotificationListener<ScrollNotification>(
                            onNotification: _onScroll,
                            child: SingleChildScrollView(
                              controller: _sc,
                              scrollDirection: Axis.horizontal,
                              physics: _pinching
                                  ? const NeverScrollableScrollPhysics()
                                  : const ClampingScrollPhysics(),
                              child: SizedBox(
                                width: side + tracksW + side,
                                child: Column(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    for (final (h, _, content) in rows)
                                      SizedBox(
                                        height: h,
                                        child: content == null
                                            ? null
                                            : Row(
                                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                                children: [
                                                  SizedBox(width: side),
                                                  SizedBox(width: tracksW, child: content),
                                                  SizedBox(width: side),
                                                ],
                                              ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                          // Track-head tiles — pinned to the viewport's left edge
                          // (they scroll vertically with their rows, never
                          // horizontally), so they stay reachable mid-clip.
                          Positioned(
                            left: 8,
                            top: 0,
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                for (final (h, tile, _) in rows)
                                  SizedBox(
                                    height: h,
                                    child: tile == null
                                        ? const SizedBox.shrink()
                                        : Align(alignment: Alignment.topLeft, child: tile),
                                  ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    // Fixed centre playhead — thin white line, CapCut-style.
                    Positioned(
                      left: side - 1,
                      top: 0,
                      bottom: 0,
                      child: IgnorePointer(
                        child: Container(
                          width: 2,
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(1),
                            boxShadow: [
                              BoxShadow(color: Colors.black.withValues(alpha: 0.55), blurRadius: 3),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              );
            },
          ),
        ),
      ],
    );
  }

  /// The "Mute clip audio" gutter tile — toggles every main clip's audio.
  /// Compact (icon-only) so it doesn't crowd the pinned track-head column.
  Widget _muteTile() {
    final on = widget.muted;
    return GestureDetector(
      onTap: widget.onToggleMute,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 43,
        decoration: BoxDecoration(
          color: const Color(0xFF17171B),
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: Colors.white.withValues(alpha: 0.06)),
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(on ? Icons.volume_off : Icons.volume_up_outlined,
                size: 16, color: on ? const Color(0xFFFF9BA6) : const Color(0xFFC9C9DA)),
            const SizedBox(height: 3),
            Text(on ? 'Unmute' : 'Mute',
                textAlign: TextAlign.center,
                style: const TextStyle(color: Color(0xFF8B8BA0), fontSize: 7.5)),
          ],
        ),
      ),
    );
  }

  /// Small square gutter tile leading a secondary lane.
  Widget _gutterIcon(IconData ic, VoidCallback? onTap) {
    return GestureDetector(
      onTap: onTap,
      behavior: HitTestBehavior.opaque,
      child: Container(
        width: 26,
        height: _laneH,
        decoration: BoxDecoration(
          color: const Color(0xFF17171B),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.white.withValues(alpha: 0.06)),
        ),
        child: Icon(ic, size: 13, color: const Color(0xFFC9C9DA)),
      ),
    );
  }

  /// Empty-lane ghost row — "＋ Add text" / "＋ Add audio", CapCut-style.
  Widget _ghostRow(String label, VoidCallback? onTap) {
    return Align(
      alignment: Alignment.centerLeft,
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Container(
          width: 200,
          height: _laneH,
          alignment: Alignment.centerLeft,
          padding: const EdgeInsets.symmetric(horizontal: 10),
          decoration: BoxDecoration(
            color: const Color(0xFF141419),
            borderRadius: BorderRadius.circular(6),
          ),
          child: Text(label,
              style: const TextStyle(color: Color(0xFF8B8BA0), fontSize: 10.5, fontWeight: FontWeight.w500)),
        ),
      ),
    );
  }

  bool _onScroll(ScrollNotification n) {
    if (n is ScrollStartNotification && n.dragDetails != null) {
      _userScrolling = true;
      widget.onScrubStart();
    } else if (n is ScrollUpdateNotification && _userScrolling) {
      widget.onScrub((_sc.offset / _pxPerMs).round().clamp(0, _total));
    } else if (n is ScrollEndNotification && _userScrolling) {
      _userScrolling = false;
      widget.onScrubEnd((_sc.offset / _pxPerMs).round().clamp(0, _total));
    }
    return false;
  }

  Widget _clipsRow(TimelineModel model) {
    return Row(
      children: [
        for (int i = 0; i < model.clips.length; i++) _clip(model, i),
      ],
    );
  }

  /// One row per audio track: a block at its [timelineStart, +len] on the axis.
  /// Tap = select; drag body = move in time; drag edges = trim in/out.
  Widget _audioLane(double tracksW) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (int a = 0; a < widget.audios.length; a++) _audioRow(a, tracksW),
      ],
    );
  }

  Widget _audioRow(int a, double tracksW) {
    final t = widget.audios[a];
    final sel = a == widget.selectedAudio;
    final grabbed = _isGrabbed('audio', a);
    final len = t.lenMs > 0 ? t.lenMs : _total;
    return Container(
      height: _laneH,
      margin: const EdgeInsets.only(top: 3),
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned(
            left: t.timelineStartMs.clamp(0, _total) * _pxPerMs,
            width: (len * _pxPerMs).clamp(20.0, tracksW),
            top: 0,
            bottom: 0,
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: widget.onSelectAudio == null ? null : () => widget.onSelectAudio!(a),
              onLongPressStart: widget.onAudioMove == null
                  ? null
                  : (_) {
                      // Grab (highlight + history) without seeking — a seek here would
                      // re-align/scroll the timeline mid-grab and fight the move.
                      widget.onAudioEditStart?.call();
                      setState(() {
                        _grabKind = 'audio';
                        _grabIndex = a;
                        _lpLastDx = 0;
                      });
                    },
              onLongPressMoveUpdate: widget.onAudioMove == null
                  ? null
                  : (d) {
                      final dx = d.offsetFromOrigin.dx;
                      widget.onAudioMove!(a, ((dx - _lpLastDx) / _pxPerMs).round());
                      _lpLastDx = dx;
                    },
              onLongPressEnd: widget.onAudioMove == null
                  ? null
                  : (_) {
                      widget.onAudioEditEnd?.call();
                      setState(() {
                        _grabKind = null;
                        _grabIndex = -1;
                        _lpLastDx = 0;
                      });
                    },
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Container(
                    clipBehavior: Clip.hardEdge,
                    decoration: BoxDecoration(
                      color: const Color(0xFF12291A),
                      borderRadius: BorderRadius.circular(6),
                      border: Border.all(
                        color: (sel || grabbed) ? Ec.green : Ec.green.withValues(alpha: 0.35),
                        width: (sel || grabbed) ? 2 : 1,
                      ),
                      boxShadow: grabbed
                          ? [BoxShadow(color: Ec.green.withValues(alpha: 0.5), blurRadius: 10, spreadRadius: 1)]
                          : null,
                    ),
                    child: Stack(
                      fit: StackFit.expand,
                      children: [
                        // The track's OWN waveform, sliced to its trimmed window —
                        // same painter as the video clips, in the audio-lane green.
                        CustomPaint(
                          painter: _WavePainter(_peaksFor(t.uri, t.inMs, t.outMs),
                              barColor: const Color(0xFF57C77A)),
                        ),
                        Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: Row(
                            children: [
                              const Icon(Icons.music_note, size: 12, color: Ec.green),
                              const SizedBox(width: 5),
                              Expanded(
                                child: Text(t.name,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        color: Color(0xFFD6F5DC),
                                        fontSize: 10.5,
                                        fontWeight: FontWeight.w500,
                                        shadows: [Shadow(color: Colors.black87, blurRadius: 3)])),
                              ),
                              if (t.volume < 0.999)
                                const Icon(Icons.volume_down, size: 11, color: Color(0xFF8FCB9A)),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (sel && widget.onAudioTrim != null) ...[
                    _audioTrimGrip(a, left: true),
                    _audioTrimGrip(a, left: false),
                  ],
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _audioTrimGrip(int a, {required bool left}) {
    return Positioned(
      left: left ? 0 : null,
      right: left ? null : 0,
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => widget.onAudioEditStart?.call(),
        onHorizontalDragUpdate: (d) {
          final dMs = (d.delta.dx / _pxPerMs).round();
          if (left) {
            widget.onAudioTrim?.call(a, startDeltaMs: dMs);
          } else {
            widget.onAudioTrim?.call(a, endDeltaMs: dMs);
          }
        },
        onHorizontalDragEnd: (_) => widget.onAudioEditEnd?.call(),
        child: Container(
          width: 11,
          decoration: BoxDecoration(
            color: Ec.green.withValues(alpha: 0.9),
            borderRadius: BorderRadius.horizontal(
              left: left ? const Radius.circular(5) : Radius.zero,
              right: left ? Radius.zero : const Radius.circular(5),
            ),
          ),
          child: const Center(child: Icon(Icons.drag_indicator, size: 10, color: Colors.black54)),
        ),
      ),
    );
  }

  /// A track of text OR caption blocks, positioned at their [start,end] on the
  /// time axis and stacked into vertical [lane]s so same-track items never overlap
  /// in time. Tap = select; hold+drag body = move in time; drag edges = trim.
  Widget _overlayLane(double tracksW, {required bool captions}) {
    final items = widget.texts.where((t) => t.isCaption == captions).toList();
    if (items.isEmpty) return const SizedBox.shrink();
    final accent = captions ? Ec.indigo : const Color(0xFFFFD84D);
    int lanes = 1;
    for (final t in items) {
      if (t.lane + 1 > lanes) lanes = t.lane + 1;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (int ln = 0; ln < lanes; ln++)
          Padding(
            padding: EdgeInsets.only(top: ln == 0 ? 0 : 3),
            child: SizedBox(
              height: _laneH,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  for (final t in items)
                    if (t.lane == ln) _overlayBlock(t, accent, captions, tracksW),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _overlayBlock(TextOverlay t, Color accent, bool captions, double tracksW) {
    final grabbed = _grabKind == 'text' && _grabIndex == widget.texts.indexOf(t);
    return Positioned(
      left: (t.startMs.clamp(0, _total) * _pxPerMs),
      width: (((t.endMs - t.startMs).clamp(120, _total)) * _pxPerMs).clamp(16.0, tracksW),
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onSelectText == null ? null : () => widget.onSelectText!(t),
        onLongPressStart: widget.onOverlayMove == null
            ? null
            : (_) {
                // Grab without seeking (see audio note) — onOverlayEditStart clears
                // the preview selection so the on-video drag can't interfere.
                widget.onOverlayEditStart?.call();
                setState(() {
                  _grabKind = 'text';
                  _grabIndex = widget.texts.indexOf(t);
                  _lpLastDx = 0;
                });
              },
        onLongPressMoveUpdate: widget.onOverlayMove == null
            ? null
            : (d) {
                final dx = d.offsetFromOrigin.dx;
                widget.onOverlayMove!(t, ((dx - _lpLastDx) / _pxPerMs).round());
                _lpLastDx = dx;
              },
        onLongPressEnd: widget.onOverlayMove == null
            ? null
            : (_) {
                widget.onOverlayEditEnd?.call();
                setState(() {
                  _grabKind = null;
                  _grabIndex = -1;
                  _lpLastDx = 0;
                });
              },
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 12),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                color: captions ? const Color(0xFF2A2550) : const Color(0xFF3A2E12),
                borderRadius: BorderRadius.circular(5),
                border: Border.all(
                  color: accent.withValues(alpha: grabbed ? 0.95 : 0.45),
                  width: grabbed ? 2 : 1,
                ),
                boxShadow: grabbed
                    ? [BoxShadow(color: accent.withValues(alpha: 0.5), blurRadius: 10, spreadRadius: 1)]
                    : null,
              ),
              child: Row(
                children: [
                  Icon(captions ? Icons.closed_caption : Icons.title, size: 12, color: accent),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(t.text,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Ec.text, fontSize: 10.5, fontWeight: FontWeight.w500)),
                  ),
                ],
              ),
            ),
            _overlayTrimGrip(t, accent, left: true),
            _overlayTrimGrip(t, accent, left: false),
          ],
        ),
      ),
    );
  }

  /// A track of image / sticker (PiP) overlay blocks, stacked into vertical lanes
  /// so same-track items never overlap in time. Tap = select; hold+drag = move.
  Widget _imageLane(double tracksW) {
    final items = widget.images;
    if (items.isEmpty) return const SizedBox.shrink();
    const accent = Color(0xFF4FD1C5); // teal for image / PiP blocks
    int lanes = 1;
    for (final o in items) {
      if (o.lane + 1 > lanes) lanes = o.lane + 1;
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (int ln = 0; ln < lanes; ln++)
          Padding(
            padding: EdgeInsets.only(top: ln == 0 ? 0 : 3),
            child: SizedBox(
              height: _laneH,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  for (final o in items)
                    if (o.lane == ln) _imageBlock(o, accent, tracksW),
                ],
              ),
            ),
          ),
      ],
    );
  }

  Widget _imageBlock(ImageOverlay o, Color accent, double tracksW) {
    final grabbed = _grabKind == 'image' && _grabIndex == widget.images.indexOf(o);
    final sel = identical(o, widget.selectedImage);
    return Positioned(
      left: (o.startMs.clamp(0, _total) * _pxPerMs),
      width: (((o.endMs - o.startMs).clamp(120, _total)) * _pxPerMs).clamp(16.0, tracksW),
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: widget.onSelectImage == null ? null : () => widget.onSelectImage!(o),
        onLongPressStart: widget.onImageMove == null
            ? null
            : (_) {
                // Grab without seeking (see audio note); the move handler marks it
                // selected so it still highlights.
                widget.onImageEditStart?.call();
                setState(() {
                  _grabKind = 'image';
                  _grabIndex = widget.images.indexOf(o);
                  _lpLastDx = 0;
                });
              },
        onLongPressMoveUpdate: widget.onImageMove == null
            ? null
            : (d) {
                final dx = d.offsetFromOrigin.dx;
                widget.onImageMove!(o, ((dx - _lpLastDx) / _pxPerMs).round());
                _lpLastDx = dx;
              },
        onLongPressEnd: widget.onImageMove == null
            ? null
            : (_) {
                widget.onImageEditEnd?.call();
                setState(() {
                  _grabKind = null;
                  _grabIndex = -1;
                  _lpLastDx = 0;
                });
              },
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                color: const Color(0xFF123331),
                borderRadius: BorderRadius.circular(5),
                border: Border.all(
                  color: accent.withValues(alpha: (grabbed || sel) ? 0.95 : 0.45),
                  width: (grabbed || sel) ? 2 : 1,
                ),
                boxShadow: grabbed
                    ? [BoxShadow(color: accent.withValues(alpha: 0.5), blurRadius: 10, spreadRadius: 1)]
                    : null,
              ),
              child: Row(
                children: [
                  ClipRRect(
                    borderRadius: BorderRadius.circular(3),
                    child: Image.memory(o.bytes,
                        width: 16, height: 16, fit: BoxFit.cover, gaplessPlayback: true),
                  ),
                  const SizedBox(width: 5),
                  const Expanded(
                    child: Text('Image',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            color: Color(0xFFCDEFEB), fontSize: 10.5, fontWeight: FontWeight.w500)),
                  ),
                ],
              ),
            ),
            _imageTrimGrip(o, accent, left: true),
            _imageTrimGrip(o, accent, left: false),
          ],
        ),
      ),
    );
  }

  Widget _imageTrimGrip(ImageOverlay o, Color accent, {required bool left}) {
    return Positioned(
      left: left ? 0 : null,
      right: left ? null : 0,
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => widget.onImageEditStart?.call(),
        onHorizontalDragUpdate: (d) {
          final dMs = (d.delta.dx / _pxPerMs).round();
          if (left) {
            widget.onImageTrim?.call(o, startDeltaMs: dMs);
          } else {
            widget.onImageTrim?.call(o, endDeltaMs: dMs);
          }
        },
        onHorizontalDragEnd: (_) => widget.onImageEditEnd?.call(),
        child: Container(
          width: 11,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.85),
            borderRadius: BorderRadius.horizontal(
              left: left ? const Radius.circular(5) : Radius.zero,
              right: left ? Radius.zero : const Radius.circular(5),
            ),
          ),
          child: const Center(
            child: Icon(Icons.drag_indicator, size: 10, color: Colors.black54),
          ),
        ),
      ),
    );
  }

  Widget _overlayTrimGrip(TextOverlay t, Color accent, {required bool left}) {
    return Positioned(
      left: left ? 0 : null,
      right: left ? null : 0,
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => widget.onOverlayEditStart?.call(),
        onHorizontalDragUpdate: (d) {
          final dMs = (d.delta.dx / _pxPerMs).round();
          if (left) {
            widget.onOverlayTrim?.call(t, startDeltaMs: dMs);
          } else {
            widget.onOverlayTrim?.call(t, endDeltaMs: dMs);
          }
        },
        onHorizontalDragEnd: (_) => widget.onOverlayEditEnd?.call(),
        child: Container(
          width: 11,
          decoration: BoxDecoration(
            color: accent.withValues(alpha: 0.85),
            borderRadius: BorderRadius.horizontal(
              left: left ? const Radius.circular(5) : Radius.zero,
              right: left ? Radius.zero : const Radius.circular(5),
            ),
          ),
          child: const Center(
            child: Icon(Icons.drag_indicator, size: 10, color: Colors.black54),
          ),
        ),
      ),
    );
  }

  /// Rendered pixel width of clip [i]'s slot in the row (used for reorder maths).
  double _clipW(int i) {
    final clips = widget.model.clips;
    if (i < 0 || i >= clips.length) return 0;
    return (clips[i].timelineLenMs * _pxPerMs).clamp(6.0, double.infinity);
  }

  /// Where the grabbed clip [from] would be inserted for a finger offset of [dx]
  /// pixels, by walking neighbours and counting each one crossed past its midpoint.
  /// The clip list is NOT mutated until release, so widths stay stable here.
  int _dropIndexFor(int from, double dx) {
    var target = from;
    var acc = dx;
    final n = widget.model.clips.length;
    while (target < n - 1) {
      final wNext = _clipW(target + 1);
      if (acc > wNext / 2) {
        acc -= wNext;
        target += 1;
      } else {
        break;
      }
    }
    while (target > 0) {
      final wPrev = _clipW(target - 1);
      if (acc < -wPrev / 2) {
        acc += wPrev;
        target -= 1;
      } else {
        break;
      }
    }
    return target;
  }

  /// Hold-drag reorder: the grabbed clip floats with the finger; the drop slot is
  /// recomputed each frame and the reorder is committed once, on release.
  void _onClipHoldMove(LongPressMoveUpdateDetails d) {
    if (widget.onClipReorder == null) return;
    final dx = d.offsetFromOrigin.dx;
    setState(() {
      _grabDx = dx;
      _dropIndex = _dropIndexFor(_grabIndex, dx);
    });
  }

  Widget _clip(TimelineModel model, int i) {
    final clip = model.clips[i];
    final selected = model.selected == i;
    final grabbed = _isGrabbed('clip', i);
    final w = (clip.timelineLenMs * _pxPerMs).clamp(6.0, double.infinity);
    final peaks = _clipPeaks(clip);
    final body = SizedBox(
      width: w,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          GestureDetector(
            onTap: () => widget.onSelectClip(i),
            onLongPressStart: widget.onClipReorder == null
                ? null
                : (_) {
                    widget.onSelectClip(i);
                    widget.onClipReorderStart?.call();
                    setState(() {
                      _grabKind = 'clip';
                      _grabIndex = i;
                      _grabDx = 0;
                      _dropIndex = i;
                    });
                  },
            onLongPressMoveUpdate: widget.onClipReorder == null ? null : _onClipHoldMove,
            onLongPressEnd: widget.onClipReorder == null
                ? null
                : (_) {
                    final from = _grabIndex;
                    final to = _dropIndex;
                    if (to >= 0 && to != from) {
                      widget.onClipReorder!(from, to); // commit once
                      widget.onClipReorderEnd?.call();
                    }
                    setState(() {
                      _grabKind = null;
                      _grabIndex = -1;
                      _grabDx = 0;
                      _dropIndex = -1;
                    });
                  },
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 1),
              decoration: BoxDecoration(
                color: const Color(0xFF312A52),
                borderRadius: BorderRadius.circular(7),
                border: Border.all(
                  color: grabbed
                      ? Ec.accentB
                      : (selected ? Colors.white : Colors.white.withValues(alpha: 0.08)),
                  width: (grabbed || selected) ? 2 : 1,
                ),
                boxShadow: grabbed
                    ? [BoxShadow(color: Ec.accentB.withValues(alpha: 0.6), blurRadius: 12, spreadRadius: 1)]
                    : selected
                        ? [BoxShadow(color: Ec.accentB.withValues(alpha: 0.5), blurRadius: 0, spreadRadius: 1.5)]
                        : null,
              ),
              clipBehavior: Clip.hardEdge,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  // Each clip is split horizontally: TOP half = thumbnail filmstrip,
                  // BOTTOM half = that clip's waveform peaks (matching the web editor).
                  Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Expanded(
                        child: ClipRect(
                          child: OverflowBox(
                            alignment: Alignment.centerLeft,
                            minWidth: 0,
                            maxWidth: double.infinity,
                            child: _filmstrip(clip, w),
                          ),
                        ),
                      ),
                      Expanded(
                        // Blackish-purple wave bg; the parent block's hardEdge
                        // clip rounds this Container's bottom corners for us.
                        child: Container(
                          color: const Color(0xFF1A1526),
                          child: CustomPaint(
                            painter: _WavePainter(peaks),
                            child: const SizedBox.expand(),
                          ),
                        ),
                      ),
                    ],
                  ),
                  // Clip name chip (top-left).
                  Positioned(
                    left: 4,
                    top: 4,
                    child: Container(
                      padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
                      decoration: BoxDecoration(
                        color: const Color(0x99000000),
                        borderRadius: BorderRadius.circular(4),
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.videocam_outlined, size: 11, color: Ec.indigoText),
                          const SizedBox(width: 3),
                          Text(
                            model.clips.length == 1 ? widget.clipName : 'Clip ${i + 1}',
                            style: const TextStyle(color: Ec.text, fontSize: 10, fontWeight: FontWeight.w500),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (selected && widget.onTrim != null) ...[
            _trimHandle(i, left: true),
            _trimHandle(i, left: false),
          ],
        ],
      ),
    );
    // A grabbed clip floats under the finger (residual offset between swaps).
    return grabbed ? Transform.translate(offset: Offset(_grabDx, 0), child: body) : body;
  }

  Widget _trimHandle(int i, {required bool left}) {
    return Positioned(
      left: left ? 0 : null,
      right: left ? null : 0,
      top: 0,
      bottom: 0,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onHorizontalDragStart: (_) => widget.onTrimStart?.call(),
        onHorizontalDragUpdate: (d) {
          final c = widget.model.clips[i];
          final s = c.speed <= 0 ? 1.0 : c.speed;
          final dMs = (d.delta.dx / _pxPerMs * s).round();
          if (left) {
            widget.onTrim!(i, inMs: c.inMs + dMs);
          } else {
            widget.onTrim!(i, outMs: c.outMs + dMs);
          }
        },
        onHorizontalDragEnd: (_) => widget.onTrimEnd?.call(),
        child: Container(
          width: 15,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.horizontal(
              left: left ? const Radius.circular(7) : Radius.zero,
              right: left ? Radius.zero : const Radius.circular(7),
            ),
          ),
          alignment: Alignment.center,
          child: Container(width: 3, height: 20, color: const Color(0xFF312A52)),
        ),
      ),
    );
  }
}

/// Paints the ruler's tick labels ("00:00  00:02  00:04 …") at a "nice" interval
/// chosen so labels sit ≥ ~64 px apart at the current zoom. Only ticks inside the
/// visible window (plus margin) are laid out, so long timelines stay cheap.
class _RulerPainter extends CustomPainter {
  final double pxPerMs;
  final int totalMs;
  final double visibleFromMs;
  final double visibleToMs;
  const _RulerPainter({
    required this.pxPerMs,
    required this.totalMs,
    required this.visibleFromMs,
    required this.visibleToMs,
  });

  @override
  void paint(Canvas canvas, Size size) {
    if (pxPerMs <= 0 || totalMs <= 0) return;
    const candidates = [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000, 300000];
    var stepMs = candidates.last;
    for (final s in candidates) {
      if (s * pxPerMs >= 64) {
        stepMs = s;
        break;
      }
    }
    final from = (visibleFromMs.clamp(0, totalMs.toDouble()) / stepMs).floor() * stepMs;
    final to = visibleToMs.clamp(0, totalMs.toDouble());
    const style = TextStyle(
        color: Color(0xFF6E6E85), fontSize: 9, fontFamily: Ec.mono, fontWeight: FontWeight.w500);
    final dot = Paint()..color = const Color(0xFF3A3A46);
    for (var t = from; t <= to; t += stepMs) {
      final x = t * pxPerMs;
      final s = t ~/ 1000;
      final label = '${(s ~/ 60).toString().padLeft(2, '0')}:${(s % 60).toString().padLeft(2, '0')}';
      final tp = TextPainter(
        text: TextSpan(text: label, style: style),
        textDirection: TextDirection.ltr,
      )..layout();
      tp.paint(canvas, Offset(x + 3, (size.height - tp.height) / 2));
      // Midpoint dot between labels, like the reference ruler.
      final midX = x + stepMs * pxPerMs / 2;
      if (midX < totalMs * pxPerMs) {
        canvas.drawCircle(Offset(midX, size.height / 2), 1.2, dot);
      }
    }
  }

  @override
  bool shouldRepaint(_RulerPainter old) =>
      old.pxPerMs != pxPerMs ||
      old.totalMs != totalMs ||
      old.visibleFromMs != visibleFromMs ||
      old.visibleToMs != visibleToMs;
}

/// Paints a centered amplitude waveform: dense, closely-adjacent bright-purple
/// bars mirrored around the middle, over the blackish-purple wave bg — matching
/// the web editor's waveform look.
class _WavePainter extends CustomPainter {
  final List<double> peaks;
  final Color barColor;
  const _WavePainter(this.peaks, {this.barColor = const Color(0xFF9B7CFF)});

  @override
  void paint(Canvas canvas, Size size) {
    if (peaks.isEmpty) return;
    final mid = size.height / 2;
    // Keep bars off the top/bottom edges so they don't touch the block border.
    const vPad = 2.0;
    final maxH = (mid - vPad).clamp(1.0, mid);

    // Subtle brighter center line for the resting axis.
    canvas.drawLine(
      Offset(0, mid),
      Offset(size.width, mid),
      Paint()
        ..color = barColor.withValues(alpha: 0.18)
        ..strokeWidth = 0.75,
    );

    final paint = Paint()
      ..color = barColor.withValues(alpha: 0.9)
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    // Fixed ~2.0px pitch at EVERY zoom (~1.5px bar + ~0.5px gap): the bar count follows
    // the pixel width, NOT the peak count, so zooming in packs MORE bars — each sampling
    // the nearest source peak — instead of stretching the same peaks apart. Capped so
    // extreme zoom stays cheap.
    final n = peaks.length;
    final bars = (size.width / 2.0).floor().clamp(1, 5000);
    for (int b = 0; b < bars; b++) {
      final x = (b + 0.5) / bars * size.width;
      final a = (b * n / bars).floor().clamp(0, n - 1);
      final e = (((b + 1) * n / bars).ceil()).clamp(a + 1, n);
      double m = 0;
      for (int j = a; j < e; j++) {
        if (peaks[j] > m) m = peaks[j];
      }
      final h = (m * maxH).clamp(0.5, maxH);
      canvas.drawLine(Offset(x, mid - h), Offset(x, mid + h), paint);
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) =>
      !identical(old.peaks, peaks) || old.barColor != barColor;
}
