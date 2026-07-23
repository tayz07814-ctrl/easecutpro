import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'config.dart';
import 'native/exporter.dart';
import 'native/player.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Supabase is best-effort: the editor (import / preview / export) works fully
  // offline; login / sync / Cut Lord connect when online.
  try {
    await Supabase.initialize(
      url: AppConfig.supabaseUrl,
      // Legacy JWT anon key (public, RLS-protected) — the value the web app already
      // ships. `anonKey` is the correct param for it.
      // ignore: deprecated_member_use
      anonKey: AppConfig.supabaseAnonKey,
    );
  } catch (_) {}
  runApp(const EaseCutApp());
}

class EaseCutApp extends StatelessWidget {
  const EaseCutApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'EaseCut',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF19E37D),
          brightness: Brightness.dark,
        ),
        scaffoldBackgroundColor: const Color(0xFF0B0D10),
      ),
      home: const EditorSlice(),
    );
  }
}

/// First vertical slice: import a video → native ExoPlayer preview (in a Flutter
/// texture) with play/pause/scrub → native Media3 export. This proves the two hard
/// pieces of the rebuild — glassy native preview compositing and hardware export —
/// before the full editor UI is built on top.
class EditorSlice extends StatefulWidget {
  const EditorSlice({super.key});

  @override
  State<EditorSlice> createState() => _EditorSliceState();
}

class _EditorSliceState extends State<EditorSlice> {
  final NativePlayer _player = NativePlayer();
  final NativeExporter _exporter = NativeExporter();
  StreamSubscription<PlayerState>? _stateSub;
  StreamSubscription<dynamic>? _sizeSub;

  String? _clipPath;
  int? _textureId;
  double _aspect = 9 / 16;

  int _positionMs = 0;
  int _durationMs = 0;
  bool _playing = false;
  bool _scrubbing = false;

  bool _exporting = false;
  double _exportPct = 0;
  String? _status;

  @override
  void dispose() {
    _stateSub?.cancel();
    _sizeSub?.cancel();
    _player.release();
    _player.dispose();
    super.dispose();
  }

  Future<void> _import() async {
    try {
      final res = await FilePicker.pickFiles(type: FileType.video);
      final path = res?.files.single.path;
      if (path == null) return;

      setState(() {
        _status = 'Loading…';
        _clipPath = path;
        _positionMs = 0;
        _durationMs = 0;
        _playing = false;
      });

      final texId = await _player.create();
      _textureId = texId;

      _stateSub ??= _player.states.listen(_onState);
      _sizeSub ??= _player.sizes.listen((_) {
        if (mounted) setState(() => _aspect = _player.aspectRatio);
      });

      await _player.load([
        PlayerSegment(
          uri: 'file://$path',
          startMs: 0,
          endMs: 0, // whole clip
          timelineStartMs: 0,
          timelineEndMs: 24 * 3600 * 1000, // single segment; native seek maps to it
        ),
      ]);

      if (mounted) setState(() => _status = null);
    } catch (e) {
      if (mounted) setState(() => _status = 'Import failed: $e');
    }
  }

  void _onState(PlayerState s) {
    if (!mounted) return;
    setState(() {
      if (!_scrubbing) _positionMs = s.timelineMs;
      if (s.durationMs > 0) _durationMs = s.durationMs;
      _playing = s.playing;
      if (s.ended) _playing = false;
    });
  }

  Future<void> _togglePlay() async {
    if (_playing) {
      await _player.pause();
    } else {
      // Restart from the beginning if we're parked at the end.
      if (_durationMs > 0 && _positionMs >= _durationMs - 40) {
        await _player.seek(0);
      }
      await _player.play();
    }
  }

  Future<void> _export() async {
    final path = _clipPath;
    if (path == null || _exporting) return;
    setState(() {
      _exporting = true;
      _exportPct = 0;
      _status = 'Exporting…';
    });
    try {
      final size = _player.videoSize;
      final w = size.width.round().clamp(16, 4096);
      final h = size.height.round().clamp(16, 4096);
      final result = await _exporter.export(
        ExportSpec(
          segments: [ExportSegment(uri: 'file://$path', startMs: 0, endMs: 0)],
          width: w,
          height: h,
          filename: 'EaseCut_${DateTime.now().millisecondsSinceEpoch}.mp4',
        ),
        onProgress: (p) {
          if (mounted) setState(() => _exportPct = p);
        },
      );
      if (mounted) {
        setState(() {
          _exporting = false;
          _status = result.savedTo != null
              ? 'Saved to ${result.savedTo}'
              : 'Exported: ${result.path}';
        });
      }
    } catch (e) {
      if (mounted) {
        setState(() {
          _exporting = false;
          _status = 'Export failed: $e';
        });
      }
    }
  }

  String _fmt(int ms) {
    final s = (ms / 1000).floor();
    final m = (s ~/ 60).toString().padLeft(2, '0');
    final ss = (s % 60).toString().padLeft(2, '0');
    return '$m:$ss';
  }

  @override
  Widget build(BuildContext context) {
    final hasClip = _clipPath != null && _textureId != null;
    return Scaffold(
      appBar: AppBar(
        title: const Text('EaseCut · native'),
        backgroundColor: Colors.transparent,
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: Center(
                child: hasClip
                    ? AspectRatio(
                        aspectRatio: _aspect,
                        child: Container(
                          color: Colors.black,
                          child: Texture(textureId: _textureId!),
                        ),
                      )
                    : const Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.movie_creation_outlined,
                              size: 64, color: Colors.white24),
                          SizedBox(height: 16),
                          Text('No clip yet',
                              style: TextStyle(color: Colors.white54)),
                        ],
                      ),
              ),
            ),
            if (hasClip) _buildTransport(),
            if (_status != null)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 4),
                child: Text(_status!,
                    style: const TextStyle(color: Colors.white54, fontSize: 12),
                    textAlign: TextAlign.center),
              ),
            _buildActionBar(hasClip),
          ],
        ),
      ),
    );
  }

  Widget _buildTransport() {
    final total = _durationMs > 0 ? _durationMs : 1;
    final pos = _positionMs.clamp(0, total).toDouble();
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12),
      child: Row(
        children: [
          IconButton(
            iconSize: 40,
            color: const Color(0xFF19E37D),
            icon: Icon(_playing ? Icons.pause_circle : Icons.play_circle),
            onPressed: _togglePlay,
          ),
          Expanded(
            child: Slider(
              value: pos,
              max: total.toDouble(),
              activeColor: const Color(0xFF19E37D),
              onChangeStart: (_) => _scrubbing = true,
              onChanged: (v) => setState(() => _positionMs = v.round()),
              onChangeEnd: (v) async {
                _scrubbing = false;
                await _player.seek(v.round());
              },
            ),
          ),
          Text('${_fmt(_positionMs)} / ${_fmt(_durationMs)}',
              style: const TextStyle(color: Colors.white70, fontSize: 12)),
          const SizedBox(width: 8),
        ],
      ),
    );
  }

  Widget _buildActionBar(bool hasClip) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
      child: Row(
        children: [
          Expanded(
            child: FilledButton.icon(
              onPressed: _exporting ? null : _import,
              icon: const Icon(Icons.video_library_outlined),
              label: Text(hasClip ? 'Change clip' : 'Import video'),
            ),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: FilledButton.icon(
              style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFF19E37D),
                  foregroundColor: Colors.black),
              onPressed: (!hasClip || _exporting) ? null : _export,
              icon: _exporting
                  ? const SizedBox(
                      width: 18,
                      height: 18,
                      child: CircularProgressIndicator(
                          strokeWidth: 2, color: Colors.black))
                  : const Icon(Icons.ios_share),
              label:
                  Text(_exporting ? 'Exporting ${_exportPct.round()}%' : 'Export'),
            ),
          ),
        ],
      ),
    );
  }
}
