import 'package:flutter/material.dart';

import '../editor/text_overlay.dart';
import '../editor/timeline_model.dart';
import '../native/exporter.dart' show ThumbFrame;
import '../theme.dart';

/// CapCut / EaseCut-style timeline: a FIXED red playhead pinned at the centre,
/// with stacked tracks (video filmstrip + waveform, audio, text/captions) that
/// SCROLL under it. Dragging the film scrubs; − / + (and pinch) zoom the scale.
class MiniTimeline extends StatefulWidget {
  final TimelineModel model;
  final String clipName;
  final int positionMs;
  final int totalMs;
  final List<ThumbFrame> thumbs;
  final List<double> waveform; // whole-source amplitude peaks (0..1)
  final int sourceDurationMs;
  final List<String> audioNames; // extra audio tracks (music / voiceover)
  final List<TextOverlay> texts; // text + caption overlays
  final VoidCallback onScrubStart;
  final ValueChanged<int> onScrub;
  final ValueChanged<int> onScrubEnd;
  final ValueChanged<int> onSelectClip;
  final ValueChanged<TextOverlay>? onSelectText;
  final ValueChanged<int>? onSelectAudio;

  /// Live trim of the selected clip (source ms). Committed on [onTrimEnd].
  final void Function(int index, {int? inMs, int? outMs})? onTrim;
  final VoidCallback? onTrimStart;
  final VoidCallback? onTrimEnd;

  const MiniTimeline({
    super.key,
    required this.model,
    required this.clipName,
    required this.positionMs,
    required this.totalMs,
    this.thumbs = const [],
    this.waveform = const [],
    this.sourceDurationMs = 0,
    this.audioNames = const [],
    this.texts = const [],
    required this.onScrubStart,
    required this.onScrub,
    required this.onScrubEnd,
    required this.onSelectClip,
    this.onSelectText,
    this.onSelectAudio,
    this.onTrim,
    this.onTrimStart,
    this.onTrimEnd,
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

  double _pxPerMs = _basePxPerMs;
  double _viewW = 0;
  bool _didInit = false;

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

  /// Frames whose source-time falls within a clip's [in,out] (nearest if none).
  List<ThumbFrame> _clipThumbs(EcClip c) {
    if (c.sourcePath != widget.model.sourcePath) return const [];
    final inR = widget.thumbs.where((t) => t.ms >= c.inMs && t.ms < c.outMs).toList();
    if (inR.isNotEmpty) return inR;
    if (widget.thumbs.isEmpty) return const [];
    final mid = (c.inMs + c.outMs) ~/ 2;
    ThumbFrame nearest = widget.thumbs.first;
    for (final t in widget.thumbs) {
      if ((t.ms - mid).abs() < (nearest.ms - mid).abs()) nearest = t;
    }
    return [nearest];
  }

  List<double> _clipPeaks(EcClip c) {
    if (c.sourcePath != widget.model.sourcePath) return const [];
    final wf = widget.waveform;
    final dur = widget.sourceDurationMs;
    if (wf.isEmpty || dur <= 0) return const [];
    final n = wf.length;
    int a = (c.inMs / dur * n).floor().clamp(0, n);
    int b = (c.outMs / dur * n).ceil().clamp(0, n);
    if (b <= a) b = (a + 1).clamp(0, n);
    return wf.sublist(a, b);
  }

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
        // Timecode + zoom control.
        Container(
          height: 34,
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0xFF262A37)))),
          child: Stack(
            children: [
              Center(
                child: Text(
                  '${_fmt(widget.positionMs)} / ${_fmt(widget.totalMs)}',
                  style: const TextStyle(
                      color: Color(0xFFEEF0F7),
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      fontFamily: Ec.mono,
                      fontFeatures: [FontFeature.tabularFigures()]),
                ),
              ),
              Positioned(
                right: 8,
                top: 0,
                bottom: 0,
                child: Row(
                  children: [
                    _zoomBtn(Icons.zoom_out, () => _setZoom(_zoom - 0.4), _zoom > 0.3),
                    const SizedBox(width: 4),
                    _zoomBtn(Icons.zoom_in, () => _setZoom(_zoom + 0.4), _zoom < 8),
                  ],
                ),
              ),
            ],
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
              return Stack(
                children: [
                  NotificationListener<ScrollNotification>(
                    onNotification: _onScroll,
                      child: SingleChildScrollView(
                        controller: _sc,
                        scrollDirection: Axis.horizontal,
                        physics: const ClampingScrollPhysics(),
                        child: Padding(
                          padding: EdgeInsets.symmetric(horizontal: side),
                          child: SizedBox(
                            width: tracksW,
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                const SizedBox(height: 8),
                                SizedBox(height: _clipsH, child: _clipsRow(model)),
                                if (widget.audioNames.isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  _audioLane(tracksW),
                                ],
                                if (widget.texts.any((t) => t.isCaption)) ...[
                                  const SizedBox(height: 4),
                                  _overlayLane(tracksW, captions: true),
                                ],
                                if (widget.texts.any((t) => !t.isCaption)) ...[
                                  const SizedBox(height: 4),
                                  _overlayLane(tracksW, captions: false),
                                ],
                                const SizedBox(height: 8),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                    // Fixed centre playhead.
                    Positioned(
                      left: side - 1,
                      top: 0,
                      bottom: 0,
                      child: IgnorePointer(
                        child: Column(
                          children: [
                            Container(
                              width: 12,
                              height: 12,
                              decoration: const BoxDecoration(
                                  color: Color(0xFFFF5D6C), shape: BoxShape.circle),
                            ),
                            Expanded(child: Container(width: 2, color: const Color(0xFFFF5D6C))),
                          ],
                        ),
                      ),
                    ),
                  ],
                );
            },
          ),
        ),
      ],
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

  Widget _zoomBtn(IconData icon, VoidCallback onTap, bool enabled) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        width: 30,
        height: 24,
        decoration: BoxDecoration(
          color: const Color(0xFF23252b),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
        ),
        child: Icon(icon, size: 16, color: enabled ? Ec.text : Ec.textFaint),
      ),
    );
  }

  Widget _audioLane(double tracksW) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (int a = 0; a < widget.audioNames.length; a++)
          GestureDetector(
            onTap: widget.onSelectAudio == null ? null : () => widget.onSelectAudio!(a),
            behavior: HitTestBehavior.opaque,
            child: Container(
              height: _laneH,
              margin: const EdgeInsets.only(top: 3),
              padding: const EdgeInsets.symmetric(horizontal: 8),
              alignment: Alignment.centerLeft,
              decoration: BoxDecoration(
                color: const Color(0xFF1F3326),
                borderRadius: BorderRadius.circular(6),
                border: Border.all(color: Ec.green.withValues(alpha: 0.35)),
              ),
              child: Row(
                children: [
                  const Icon(Icons.music_note, size: 12, color: Ec.green),
                  const SizedBox(width: 5),
                  Expanded(
                    child: Text(widget.audioNames[a],
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                            color: Color(0xFFBFE8C4), fontSize: 10.5, fontWeight: FontWeight.w500)),
                  ),
                ],
              ),
            ),
          ),
      ],
    );
  }

  /// A track of text OR caption blocks, positioned at their [start,end] on the
  /// time axis. Tap a block to select it (opens its on-preview controls).
  Widget _overlayLane(double tracksW, {required bool captions}) {
    final items = widget.texts.where((t) => t.isCaption == captions).toList();
    final accent = captions ? Ec.indigo : const Color(0xFFFFD84D);
    return SizedBox(
      height: _laneH,
      child: Stack(
        children: [
          for (final t in items)
            Positioned(
              left: (t.startMs.clamp(0, _total) * _pxPerMs),
              width: (((t.endMs - t.startMs).clamp(120, _total)) * _pxPerMs).clamp(16.0, tracksW),
              top: 0,
              bottom: 0,
              child: GestureDetector(
                onTap: widget.onSelectText == null ? null : () => widget.onSelectText!(t),
                behavior: HitTestBehavior.opaque,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6),
                  alignment: Alignment.centerLeft,
                  decoration: BoxDecoration(
                    color: captions ? const Color(0xFF2A2550) : const Color(0xFF3A2E12),
                    borderRadius: BorderRadius.circular(5),
                    border: Border.all(color: accent.withValues(alpha: 0.45)),
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
              ),
            ),
        ],
      ),
    );
  }

  Widget _clip(TimelineModel model, int i) {
    final clip = model.clips[i];
    final selected = model.selected == i;
    final w = (clip.timelineLenMs * _pxPerMs).clamp(6.0, double.infinity);
    return SizedBox(
      width: w,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          GestureDetector(
            onTap: () => widget.onSelectClip(i),
            child: Container(
              margin: const EdgeInsets.symmetric(horizontal: 1),
              decoration: BoxDecoration(
                color: const Color(0xFF312A52),
                borderRadius: BorderRadius.circular(7),
                border: Border.all(
                  color: selected ? Colors.white : Colors.white.withValues(alpha: 0.08),
                  width: selected ? 2 : 1,
                ),
                boxShadow: selected
                    ? [BoxShadow(color: Ec.accentB.withValues(alpha: 0.5), blurRadius: 0, spreadRadius: 1.5)]
                    : null,
              ),
              clipBehavior: Clip.hardEdge,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  // Filmstrip: fixed-width frame tiles (each a distinct frame), not stretched.
                  ClipRect(
                    child: OverflowBox(
                      alignment: Alignment.centerLeft,
                      minWidth: 0,
                      maxWidth: double.infinity,
                      child: _filmstrip(clip, w),
                    ),
                  ),
                  // Thin waveform strip along the bottom (doesn't cover the frames).
                  Builder(builder: (_) {
                    final peaks = _clipPeaks(clip);
                    if (peaks.isEmpty) return const SizedBox.shrink();
                    return Positioned(
                      left: 0,
                      right: 0,
                      bottom: 0,
                      height: 15,
                      child: Container(
                        color: const Color(0x66000000),
                        child: CustomPaint(painter: _WavePainter(peaks)),
                      ),
                    );
                  }),
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

/// Paints a centered amplitude waveform (mirrored bars) from a peaks list.
class _WavePainter extends CustomPainter {
  final List<double> peaks;
  const _WavePainter(this.peaks);

  @override
  void paint(Canvas canvas, Size size) {
    if (peaks.isEmpty) return;
    final mid = size.height / 2;
    final paint = Paint()
      ..color = Colors.white.withValues(alpha: 0.55)
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round;
    final bars = (size.width / 2.5).floor().clamp(1, peaks.length);
    for (int b = 0; b < bars; b++) {
      final x = (b + 0.5) / bars * size.width;
      final a = (b * peaks.length / bars).floor();
      final e = (((b + 1) * peaks.length / bars).floor()).clamp(a + 1, peaks.length);
      double m = 0;
      for (int j = a; j < e; j++) {
        if (peaks[j] > m) m = peaks[j];
      }
      final h = (m * (mid - 1)).clamp(0.5, mid - 1);
      canvas.drawLine(Offset(x, mid - h), Offset(x, mid + h), paint);
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => !identical(old.peaks, peaks);
}
