import 'package:flutter/material.dart';

import '../editor/timeline_model.dart';
import '../theme.dart';

/// Base-track timeline: renders the [TimelineModel]'s clips as proportional blocks
/// (dark-purple #312a52, selected = white border), a centered timecode, and a red
/// playhead. Drag to scrub; tap a clip to select it.
class MiniTimeline extends StatelessWidget {
  final TimelineModel model;
  final String clipName;
  final int positionMs;
  final int totalMs;
  final VoidCallback onScrubStart;
  final ValueChanged<int> onScrub;
  final ValueChanged<int> onScrubEnd;
  final ValueChanged<int> onSelectClip;

  const MiniTimeline({
    super.key,
    required this.model,
    required this.clipName,
    required this.positionMs,
    required this.totalMs,
    required this.onScrubStart,
    required this.onScrub,
    required this.onScrubEnd,
    required this.onSelectClip,
  });

  String _fmt(int ms) {
    final s = (ms / 1000).floor();
    final m = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    if (!model.hasBase) {
      return const Center(
        child: Text('Your timeline will appear here',
            style: TextStyle(color: Ec.textFaint, fontSize: 12.5)),
      );
    }
    final total = totalMs > 0 ? totalMs : 1;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(
          padding: const EdgeInsets.symmetric(vertical: 7),
          alignment: Alignment.center,
          decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Color(0xFF262A37)))),
          child: Text(
            '${_fmt(positionMs)} / ${_fmt(totalMs)}',
            style: const TextStyle(
                color: Color(0xFFEEF0F7), fontSize: 13, fontWeight: FontWeight.w600,
                fontFeatures: [FontFeature.tabularFigures()]),
          ),
        ),
        Expanded(
          child: LayoutBuilder(
            builder: (context, c) {
              final w = c.maxWidth - 28;
              int msAt(double x) => (((x - 14).clamp(0, w) / w) * total).round();
              final playheadX = 14 + (positionMs.clamp(0, total) / total) * w;
              return GestureDetector(
                behavior: HitTestBehavior.opaque,
                onHorizontalDragStart: (d) {
                  onScrubStart();
                  onScrub(msAt(d.localPosition.dx));
                },
                onHorizontalDragUpdate: (d) => onScrub(msAt(d.localPosition.dx)),
                onHorizontalDragEnd: (_) => onScrubEnd(positionMs),
                child: Stack(
                  children: [
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
                      child: Row(
                        children: [
                          for (int i = 0; i < model.clips.length; i++) ...[
                            if (i > 0) const SizedBox(width: 2),
                            Expanded(
                              flex: model.clips[i].lengthMs.clamp(1, 1 << 30),
                              child: GestureDetector(
                                onTap: () => onSelectClip(i),
                                child: Container(
                                  decoration: BoxDecoration(
                                    color: const Color(0xFF312A52),
                                    borderRadius: BorderRadius.circular(7),
                                    border: Border.all(
                                      color: model.selected == i ? Colors.white : Colors.white.withValues(alpha: 0.08),
                                      width: model.selected == i ? 2 : 1,
                                    ),
                                    boxShadow: model.selected == i
                                        ? [BoxShadow(color: Ec.accentB.withValues(alpha: 0.5), blurRadius: 0, spreadRadius: 1.5)]
                                        : null,
                                  ),
                                  padding: const EdgeInsets.symmetric(horizontal: 10),
                                  alignment: Alignment.centerLeft,
                                  clipBehavior: Clip.hardEdge,
                                  child: Row(
                                    children: [
                                      const Icon(Icons.videocam_outlined, size: 14, color: Ec.indigoText),
                                      const SizedBox(width: 6),
                                      Flexible(
                                        child: Text(
                                          model.clips.length == 1 ? clipName : 'Clip ${i + 1}',
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(color: Ec.text, fontSize: 11.5, fontWeight: FontWeight.w500),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
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
              );
            },
          ),
        ),
      ],
    );
  }
}
