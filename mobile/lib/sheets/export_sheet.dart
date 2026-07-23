import 'package:flutter/material.dart';

import '../native/exporter.dart';
import '../theme.dart';
import 'sheet_scaffold.dart';

/// Export drawer (MobileExportDrawer.tsx) — runs the native Media3 export with a
/// live progress bar and reports the gallery location.
class ExportSheet extends StatefulWidget {
  final NativeExporter exporter;
  final List<ExportSegment> segments;
  final List<ExportOverlay> captions;
  final List<ExportSegment> audioTracks;
  final Size videoSize;
  const ExportSheet({
    super.key,
    required this.exporter,
    required this.segments,
    this.captions = const [],
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

  Future<void> _run() async {
    if (_exporting) return;
    setState(() {
      _exporting = true;
      _pct = 0;
      _done = null;
      _error = null;
    });
    try {
      final w = widget.videoSize.width.round().clamp(16, 4096);
      final h = widget.videoSize.height.round().clamp(16, 4096);
      final res = await widget.exporter.export(
        ExportSpec(
          segments: widget.segments,
          captions: widget.captions,
          audioTracks: widget.audioTracks,
          width: w,
          height: h,
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
    final w = widget.videoSize.width.round();
    final h = widget.videoSize.height.round();
    return SheetScaffold(
      title: 'Export',
      heightFactor: 0.5,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(18, 4, 18, 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _row('Resolution', '$w × $h'),
            _row('Codecs', 'Native hardware (Media3)'),
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
}
