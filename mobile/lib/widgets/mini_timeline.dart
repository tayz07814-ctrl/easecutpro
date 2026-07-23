import 'package:flutter/material.dart';

import '../theme.dart';

/// First-pass timeline: a time ruler, the base-video clip block, and a playhead that
/// scrubs the native player. The full multi-track timeline (thumbnails, text/audio
/// lanes, trim handles, zoom) is the next milestone.
class MiniTimeline extends StatelessWidget {
  final bool hasClip;
  final String clipName;
  final int positionMs;
  final int durationMs;
  final VoidCallback onScrubStart;
  final ValueChanged<int> onScrub;
  final ValueChanged<int> onScrubEnd;

  const MiniTimeline({
    super.key,
    required this.hasClip,
    required this.clipName,
    required this.positionMs,
    required this.durationMs,
    required this.onScrubStart,
    required this.onScrub,
    required this.onScrubEnd,
  });

  String _fmt(int ms) {
    final s = (ms / 1000).floor();
    final m = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    if (!hasClip) {
      return const Center(
        child: Text('Your timeline will appear here',
            style: TextStyle(color: Ec.textFaint, fontSize: 12.5)),
      );
    }
    final total = durationMs > 0 ? durationMs : 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        // Centered timecode readout (.ec-mtl-tc)
        Container(
          padding: const EdgeInsets.symmetric(vertical: 7),
          alignment: Alignment.center,
          decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: Color(0xFF262A37))),
          ),
          child: Text(
            '${_fmt(positionMs)} / ${_fmt(durationMs)}',
            style: const TextStyle(
                color: Color(0xFFEEF0F7),
                fontSize: 13,
                fontWeight: FontWeight.w600,
                fontFeatures: [FontFeature.tabularFigures()]),
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) {
              final w = c.maxWidth - 28; // 14px side padding
              double clampX(double x) => x.clamp(0.0, w);
              int msAt(double x) => ((clampX(x) / w) * total).round();
              final playheadX = 14 + (positionMs.clamp(0, total) / total) * w;

              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onHorizontalDragStart: (d) {
                  onScrubStart();
                  onScrub(msAt(d.localPosition.dx - 14));
                },
                onHorizontalDragUpdate: (d) => onScrub(msAt(d.localPosition.dx - 14)),
                onHorizontalDragEnd: (_) => onScrubEnd(positionMs),
                onTapUp: (d) {
                  onScrubStart();
                  onScrubEnd(msAt(d.localPosition.dx - 14));
                },
                child: Stack(
                  children: [
                    // Base-video clip block
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                      child: Container(
                        decoration: BoxDecoration(
                          color: const Color(0xFF312A52), // base-video clip (dark purple)
                          borderRadius: BorderRadius.circular(7),
                          border: Border.all(color: Colors.white.withValues(alpha: 0.08)),
                        ),
                        padding: const EdgeInsets.symmetric(horizontal: 12),
                        alignment: Alignment.centerLeft,
                        child: Row(
                          children: [
                            const Icon(Icons.videocam_outlined, size: 16, color: Ec.indigoText),
                            const SizedBox(width: 8),
                            Expanded(
                              child: Text(
                                clipName,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                    color: Ec.text, fontSize: 12, fontWeight: FontWeight.w500),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    // Playhead (.ec-mtl-centerline — red #ff5d6c)
                    Positioned(
                      left: playheadX - 1,
                      top: 0,
                      bottom: 0,
                      child: Container(width: 2, color: const Color(0xFFFF5D6C)),
                    ),
                    Positioned(
                      left: playheadX - 6,
                      top: 2,
                      child: Container(
                        width: 12,
                        height: 12,
                        decoration: const BoxDecoration(color: Color(0xFFFF5D6C), shape: BoxShape.circle),
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
}
