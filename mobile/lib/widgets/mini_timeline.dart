import 'package:flutter/material.dart';

import '../editor/timeline_model.dart';
import '../native/exporter.dart' show ThumbFrame;
import '../theme.dart';

/// Base-track timeline: renders the [TimelineModel]'s clips as a filmstrip
/// (frame thumbnails + waveform), with a top scrub-ruler, a red playhead,
/// pinch-free zoom (− / +) that makes the strip horizontally scrollable, and
/// drag trim-handles on the selected clip.
class MiniTimeline extends StatefulWidget {
  final TimelineModel model;
  final String clipName;
  final int positionMs;
  final int totalMs;
  final List<ThumbFrame> thumbs;
  final List<double> waveform; // whole-source amplitude peaks (0..1)
  final int sourceDurationMs;
  final VoidCallback onScrubStart;
  final ValueChanged<int> onScrub;
  final ValueChanged<int> onScrubEnd;
  final ValueChanged<int> onSelectClip;

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
    required this.onScrubStart,
    required this.onScrub,
    required this.onScrubEnd,
    required this.onSelectClip,
    this.onTrim,
    this.onTrimStart,
    this.onTrimEnd,
  });

  @override
  State<MiniTimeline> createState() => _MiniTimelineState();
}

class _MiniTimelineState extends State<MiniTimeline> {
  static const double _pad = 14;
  final ScrollController _sc = ScrollController();
  double _zoom = 1.0; // 1 = fit-to-width; >1 = scrollable
  bool _scrubbing = false;
  bool _trimming = false;

  // Cached from the last build so auto-follow can position the scroll.
  double _pxPerMs = 0;
  double _viewW = 0;
  double _contentW = 0;

  @override
  void initState() {
    super.initState();
    _sc.addListener(() {
      if (mounted) setState(() {}); // playhead x depends on the scroll offset
    });
  }

  @override
  void dispose() {
    _sc.dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(MiniTimeline old) {
    super.didUpdateWidget(old);
    if (widget.positionMs != old.positionMs && !_scrubbing && !_trimming && _zoom > 1) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _followPlayhead());
    }
  }

  void _followPlayhead() {
    if (!_sc.hasClients || _pxPerMs <= 0) return;
    final target = (_pad + widget.positionMs * _pxPerMs) - _viewW / 2;
    final maxOff = (_contentW - _viewW).clamp(0.0, double.infinity);
    _sc.jumpTo(target.clamp(0.0, maxOff));
  }

  void _setZoom(double z) {
    setState(() => _zoom = z.clamp(1.0, 10.0));
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_zoom > 1) _followPlayhead();
    });
  }

  double get _scrollOffset => _sc.hasClients ? _sc.offset : 0;

  /// Frames whose source-time falls within a clip's [in,out] (nearest if none).
  List<ThumbFrame> _clipThumbs(EcClip c) {
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

  /// The whole-source peaks sliced to a clip's [in,out] source window.
  List<double> _clipPeaks(EcClip c) {
    final wf = widget.waveform;
    final dur = widget.sourceDurationMs;
    if (wf.isEmpty || dur <= 0) return const [];
    final n = wf.length;
    int a = (c.inMs / dur * n).floor().clamp(0, n);
    int b = (c.outMs / dur * n).ceil().clamp(0, n);
    if (b <= a) b = (a + 1).clamp(0, n);
    return wf.sublist(a, b);
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
    final total = widget.totalMs > 0 ? widget.totalMs : 1;
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
                      color: Color(0xFFEEF0F7), fontSize: 13, fontWeight: FontWeight.w600,
                      fontFeatures: [FontFeature.tabularFigures()]),
                ),
              ),
              Positioned(
                right: 8,
                top: 0,
                bottom: 0,
                child: Row(
                  children: [
                    _zoomBtn(Icons.remove, () => _setZoom(_zoom - 0.5), _zoom > 1),
                    const SizedBox(width: 2),
                    _zoomBtn(Icons.add, () => _setZoom(_zoom + 0.5), _zoom < 10),
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
              final basePxPerMs = (_viewW - 2 * _pad) / total;
              _pxPerMs = basePxPerMs * _zoom;
              _contentW = total * _pxPerMs + 2 * _pad;
              final scrollable = _zoom > 1.0;
              final playheadX = _pad + widget.positionMs.clamp(0, total) * _pxPerMs - _scrollOffset;

              return Column(
                children: [
                  // Scrub ruler (maps viewport-x + scroll → source time).
                  GestureDetector(
                    behavior: HitTestBehavior.opaque,
                    onHorizontalDragStart: (d) {
                      _scrubbing = true;
                      widget.onScrubStart();
                      widget.onScrub(_msAt(d.localPosition.dx, total));
                    },
                    onHorizontalDragUpdate: (d) => widget.onScrub(_msAt(d.localPosition.dx, total)),
                    onHorizontalDragEnd: (_) {
                      _scrubbing = false;
                      widget.onScrubEnd(widget.positionMs);
                    },
                    onTapDown: (d) {
                      widget.onScrubStart();
                      widget.onScrub(_msAt(d.localPosition.dx, total));
                      widget.onScrubEnd(_msAt(d.localPosition.dx, total));
                    },
                    child: Container(
                      height: 18,
                      color: const Color(0xFF141821),
                      alignment: Alignment.center,
                      child: const Icon(Icons.drag_handle, size: 14, color: Color(0xFF3A4152)),
                    ),
                  ),
                  // Filmstrip (scrollable when zoomed).
                  Expanded(
                    child: Stack(
                      children: [
                        SingleChildScrollView(
                          controller: _sc,
                          scrollDirection: Axis.horizontal,
                          physics: scrollable
                              ? const ClampingScrollPhysics()
                              : const NeverScrollableScrollPhysics(),
                          child: SizedBox(
                            width: _contentW,
                            child: Padding(
                              padding: const EdgeInsets.symmetric(horizontal: _pad, vertical: 10),
                              child: Row(
                                children: [
                                  for (int i = 0; i < model.clips.length; i++) ...[
                                    if (i > 0) const SizedBox(width: 2),
                                    _clip(model, i),
                                  ],
                                ],
                              ),
                            ),
                          ),
                        ),
                        // Playhead line + knob.
                        Positioned(
                          left: playheadX - 1,
                          top: 0,
                          bottom: 0,
                          child: IgnorePointer(child: Container(width: 2, color: const Color(0xFFFF5D6C))),
                        ),
                        Positioned(
                          left: playheadX - 6,
                          top: 2,
                          child: IgnorePointer(
                            child: Container(
                              width: 12,
                              height: 12,
                              decoration: const BoxDecoration(color: Color(0xFFFF5D6C), shape: BoxShape.circle),
                            ),
                          ),
                        ),
                      ],
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

  int _msAt(double localX, int total) {
    final contentX = _scrollOffset + localX;
    return (((contentX - _pad) / _pxPerMs)).round().clamp(0, total);
  }

  Widget _zoomBtn(IconData icon, VoidCallback onTap, bool enabled) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: Container(
        width: 26,
        height: 24,
        margin: const EdgeInsets.symmetric(vertical: 5),
        decoration: BoxDecoration(
          color: const Color(0xFF23252b),
          borderRadius: BorderRadius.circular(6),
          border: Border.all(color: Colors.white.withValues(alpha: 0.06)),
        ),
        child: Icon(icon, size: 15, color: enabled ? Ec.text : Ec.textFaint),
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
                  Builder(builder: (_) {
                    final frames = _clipThumbs(clip);
                    if (frames.isEmpty) return const SizedBox.shrink();
                    return Row(
                      children: [
                        for (final t in frames)
                          Expanded(
                            child: Image.memory(
                              t.jpeg,
                              fit: BoxFit.cover,
                              height: double.infinity,
                              gaplessPlayback: true,
                            ),
                          ),
                      ],
                    );
                  }),
                  Builder(builder: (_) {
                    final peaks = _clipPeaks(clip);
                    if (peaks.isEmpty) return const SizedBox.shrink();
                    return Positioned.fill(child: CustomPaint(painter: _WavePainter(peaks)));
                  }),
                  Positioned(
                    left: 0,
                    right: 0,
                    bottom: 0,
                    child: Container(
                      height: 24,
                      decoration: const BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.bottomCenter,
                          end: Alignment.topCenter,
                          colors: [Color(0x99000000), Color(0x00000000)],
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    left: 6,
                    right: 6,
                    bottom: 4,
                    child: Row(
                      children: [
                        const Icon(Icons.videocam_outlined, size: 12, color: Ec.indigoText),
                        const SizedBox(width: 4),
                        Flexible(
                          child: Text(
                            model.clips.length == 1 ? widget.clipName : 'Clip ${i + 1}',
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                color: Ec.text,
                                fontSize: 11,
                                fontWeight: FontWeight.w500,
                                shadows: [Shadow(color: Colors.black, blurRadius: 2)]),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
          // Trim handles (only on the selected clip).
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
        onHorizontalDragStart: (_) {
          _trimming = true;
          widget.onTrimStart?.call();
        },
        onHorizontalDragUpdate: (d) {
          final c = widget.model.clips[i];
          final s = c.speed <= 0 ? 1.0 : c.speed;
          final dMs = (d.delta.dx / _pxPerMs * s).round(); // timeline px → source ms
          if (left) {
            widget.onTrim!(i, inMs: c.inMs + dMs);
          } else {
            widget.onTrim!(i, outMs: c.outMs + dMs);
          }
        },
        onHorizontalDragEnd: (_) {
          _trimming = false;
          widget.onTrimEnd?.call();
        },
        child: Container(
          width: 16,
          decoration: BoxDecoration(
            color: Colors.white,
            borderRadius: BorderRadius.horizontal(
              left: left ? const Radius.circular(7) : Radius.zero,
              right: left ? Radius.zero : const Radius.circular(7),
            ),
          ),
          alignment: Alignment.center,
          child: Container(width: 3, height: 22, color: const Color(0xFF312A52)),
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
    // Draw ~1 bar every ~2.5px so wide clips don't over-draw thousands of lines.
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
