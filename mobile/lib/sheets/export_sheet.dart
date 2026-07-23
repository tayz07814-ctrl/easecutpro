import 'package:flutter/material.dart';

import '../editor/text_overlay.dart';
import '../native/exporter.dart';
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Export drawer (MobileExportDrawer.tsx) — runs the native Media3 export with a
/// live progress bar and reports the gallery location.
class ExportSheet extends StatefulWidget {
  final NativeExporter exporter;
  final List<ExportSegment> segments;
  final List<TextOverlay> overlays; // baked at the CHOSEN output size on export
  final List<ImageOverlay> imageOverlays; // PiP / stickers
  final List<ExportSegment> audioTracks;
  final Size videoSize;
  const ExportSheet({
    super.key,
    required this.exporter,
    required this.segments,
    this.overlays = const [],
    this.imageOverlays = const [],
    this.audioTracks = const [],
    required this.videoSize,
  });

  @override
  State<ExportSheet> createState() => _ExportSheetState();
}

class _ExportSheetState extends State<ExportSheet> {
  bool _exporting = false;
  double _pct = 0;
  String? _done;
  String? _error;

  String _res = 'Source'; // Source / 1080p / 720p / 480p
  int _fps = 0; // 0 = source
  String _quality = 'High'; // Auto / High / Medium / Low

  /// Output (w,h) for the chosen resolution, preserving the source aspect (even).
  (int, int) _outSize() {
    final sw = widget.videoSize.width.round().clamp(16, 8192);
    final sh = widget.videoSize.height.round().clamp(16, 8192);
    if (_res == 'Source') return (_even(sw), _even(sh));
    final target = _res == '1080p' ? 1080 : _res == '720p' ? 720 : 480;
    if (sw <= sh) {
      // portrait: short side is width
      final w = target;
      final h = (target * sh / sw).round();
      return (_even(w.clamp(16, 8192)), _even(h.clamp(16, 8192)));
    } else {
      final h = target;
      final w = (target * sw / sh).round();
      return (_even(w.clamp(16, 8192)), _even(h.clamp(16, 8192)));
    }
  }

  int _even(int v) => v.isEven ? v : v + 1;

  int _bitrate() {
    switch (_quality) {
      case 'High':
        return 14000000;
      case 'Medium':
        return 9000000;
      case 'Low':
        return 5000000;
      default:
        return 0; // Auto — let the encoder decide
    }
  }

  Future<void> _run() async {
    if (_exporting) return;
    setState(() {
      _exporting = true;
      _pct = 0;
      _done = null;
      _error = null;
    });
    try {
      final (w, h) = _outSize();
      // Bake text/caption overlays at the ACTUAL output resolution so a full-frame
      // PNG maps 1:1 onto the frame (otherwise they land off-screen / clipped).
      final caps = <ExportOverlay>[];
      for (final t in widget.overlays) {
        if (t.text.trim().isEmpty || t.endMs <= t.startMs) continue;
        final b = await t.bakePngBase64(w, h);
        caps.add(ExportOverlay(base64: b, startMs: t.startMs, endMs: t.endMs));
      }
      final imgs = <ExportOverlay>[];
      for (final o in widget.imageOverlays) {
        if (o.endMs <= o.startMs) continue;
        final b = await o.bakePngBase64(w, h);
        imgs.add(ExportOverlay(base64: b, startMs: o.startMs, endMs: o.endMs));
      }
      final res = await widget.exporter.export(
        ExportSpec(
          segments: widget.segments,
          captions: caps,
          images: imgs,
          audioTracks: widget.audioTracks,
          width: w,
          height: h,
          fps: _fps,
          bitrate: _bitrate(),
          filename: 'EaseCut_${DateTime.now().millisecondsSinceEpoch}.mp4',
        ),
        onProgress: (p) {
          if (mounted) setState(() => _pct = p);
        },
      );
      if (mounted) {
        setState(() {
          _exporting = false;
          _done = res.savedTo ?? res.path;
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _exporting = false;
          _error = '$e';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final (ow, oh) = _outSize();
    return SheetScaffold(
      title: 'Export',
      heightFactor: 0.62,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _seg('Resolution', const ['Source', '1080p', '720p', '480p'], _res, (v) => setState(() => _res = v)),
            _seg('Frame rate', const ['Source', '24', '30', '60'], _fps == 0 ? 'Source' : '$_fps',
                (v) => setState(() => _fps = v == 'Source' ? 0 : int.parse(v))),
            _seg('Quality', const ['Auto', 'High', 'Medium', 'Low'], _quality, (v) => setState(() => _quality = v)),
            const SizedBox(height: 6),
            _row('Output', '$ow × $oh · ${_fps == 0 ? "source" : "$_fps"} fps'),
            const Spacer(),
            if (_exporting) ...[
              ClipRRect(
                borderRadius: BorderRadius.circular(6),
                child: LinearProgressIndicator(
                  value: _pct / 100,
                  minHeight: 8,
                  backgroundColor: Ec.card2,
                  valueColor: const AlwaysStoppedAnimation(Ec.accentB),
                ),
              ),
              const SizedBox(height: 10),
              Text('Exporting ${_pct.round()}%',
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Ec.textDim, fontSize: 13)),
            ] else if (_done != null)
              Container(
                padding: const EdgeInsets.all(14),
                decoration: BoxDecoration(
                  color: Ec.card2,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Row(
                  children: [
                    const Icon(Icons.check_circle, color: Ec.green, size: 20),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text('Saved · $_done',
                          style: const TextStyle(color: Ec.green, fontSize: 12.5)),
                    ),
                  ],
                ),
              )
            else if (_error != null)
              Text(_error!,
                  style: const TextStyle(color: Color(0xFFFF6B6B), fontSize: 12.5)),
            const SizedBox(height: 14),
            GestureDetector(
              onTap: _exporting ? null : _run,
              child: Opacity(
                opacity: _exporting ? 0.6 : 1,
                child: Container(
                  height: 50,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    gradient: Ec.gradient,
                    borderRadius: BorderRadius.circular(12),
                    boxShadow: [
                      BoxShadow(
                          color: Ec.accentA.withValues(alpha: 0.32),
                          blurRadius: 18,
                          offset: const Offset(0, 6)),
                    ],
                  ),
                  child: Text(
                    _done != null ? 'Export again' : 'Export',
                    style: const TextStyle(
                        color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _row(String k, String v) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(k, style: const TextStyle(color: Ec.textMute, fontSize: 13)),
          Text(v, style: const TextStyle(color: Ec.text, fontSize: 13, fontWeight: FontWeight.w500)),
        ],
      ),
    );
  }

  Widget _seg(String label, List<String> options, String selected, ValueChanged<String> onSelect) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 7),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: const TextStyle(color: Ec.textMute, fontSize: 12.5)),
          const SizedBox(height: 7),
          Row(
            children: [
              for (final o in options)
                Expanded(
                  child: GestureDetector(
                    onTap: () => onSelect(o),
                    child: Container(
                      margin: const EdgeInsets.only(right: 6),
                      padding: const EdgeInsets.symmetric(vertical: 9),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: selected == o ? Ec.indigoTint : Ec.chip,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(
                            color: selected == o ? Ec.indigo : Colors.white.withValues(alpha: 0.06)),
                      ),
                      child: Text(o,
                          style: TextStyle(
                              color: selected == o ? Ec.indigoText : Ec.textDim,
                              fontSize: 12.5,
                              fontWeight: FontWeight.w600)),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    );
  }
}
