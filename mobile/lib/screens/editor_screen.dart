import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../native/exporter.dart';
import '../native/player.dart';
import '../theme.dart';
import '../widgets/tool_dock.dart';
import '../widgets/mini_timeline.dart';
import '../sheets/media_sheet.dart';
import '../sheets/export_sheet.dart';

/// The EaseCut mobile editor, rebuilt in Flutter to match newui/screens/MobileEditor.tsx:
/// top bar (back · 9:16 · settings + purple Export) → fixed stage (native ExoPlayer
/// texture) → resize grip → transport (undo/redo · circular play · zoom) → timeline →
/// bottom tool dock (Import · Cut Lord · Text · Captions · Audio · Sticker).
class EditorScreen extends StatefulWidget {
  const EditorScreen({super.key});

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  final NativePlayer _player = NativePlayer();
  final NativeExporter _exporter = NativeExporter();
  StreamSubscription<PlayerState>? _stateSub;
  StreamSubscription<dynamic>? _sizeSub;

  String? _clipPath;
  String? _clipName;
  int? _textureId;
  double _aspect = 9 / 16;

  int _positionMs = 0;
  int _durationMs = 0;
  bool _playing = false;
  bool _scrubbing = false;

  double _stageFrac = 0.46; // fraction of screen height for the stage (22%–58%)

  @override
  void dispose() {
    _stateSub?.cancel();
    _sizeSub?.cancel();
    _player.release();
    _player.dispose();
    super.dispose();
  }

  bool get _hasBase => _clipPath != null && _textureId != null;

  Future<void> _import() async {
    try {
      final res = await FilePicker.pickFiles(type: FileType.video);
      final path = res?.files.single.path;
      if (path == null) return;
      setState(() {
        _clipPath = path;
        _clipName = res!.files.single.name;
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
          endMs: 0,
          timelineStartMs: 0,
          timelineEndMs: 24 * 3600 * 1000,
        ),
      ]);
      if (mounted) setState(() {});
    } catch (e) {
      _toast('Import failed: $e');
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
    if (!_hasBase) return;
    if (_playing) {
      await _player.pause();
    } else {
      if (_durationMs > 0 && _positionMs >= _durationMs - 40) await _player.seek(0);
      await _player.play();
    }
  }

  Future<void> _seek(int ms) async {
    setState(() => _positionMs = ms);
    await _player.seek(ms);
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(msg), backgroundColor: Ec.card),
    );
  }

  void _openExport() {
    if (!_hasBase) {
      _toast('Import a clip first');
      return;
    }
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => ExportSheet(
        exporter: _exporter,
        clipPath: _clipPath!,
        videoSize: _player.videoSize,
      ),
    );
  }

  void _openMedia() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => MediaSheet(
        currentName: _clipName,
        onPick: () async {
          Navigator.of(context).pop();
          await _import();
        },
      ),
    );
  }

  void _todo(String tool) => _toast('$tool — coming next in the rebuild');

  @override
  Widget build(BuildContext context) {
    final screenH = MediaQuery.of(context).size.height;
    return Scaffold(
      backgroundColor: Ec.bg,
      body: SafeArea(
        child: Column(
          children: [
            _topBar(),
            _stage(screenH),
            _grip(),
            _transport(),
            Expanded(child: _timeline()),
            ToolDock(
              hasSelection: false,
              onEdit: _openMedia, // "select main clip, else import"
              onMusic: () => _todo('Audio'),
              onText: () => _todo('Text'),
              onCutLord: () => _todo('Cut Lord'),
              onCaptions: () => _todo('Captions'),
            ),
          ],
        ),
      ),
    );
  }

  // ---- Top bar (52px) ----
  Widget _topBar() {
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: Ec.hair)),
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Row(
            children: [
              GestureDetector(
                onTap: () {}, // Home comes with the dashboard screen
                child: Container(
                  width: 38,
                  height: 38,
                  alignment: Alignment.center,
                  child: const Icon(Icons.chevron_left, size: 26, color: Ec.text),
                ),
              ),
              const Spacer(),
              GestureDetector(
                onTap: () => _todo('Settings'),
                child: const SizedBox(
                  width: 34,
                  height: 34,
                  child: Icon(Icons.more_horiz, size: 20, color: Color(0xFFBDBDC4)),
                ),
              ),
              const SizedBox(width: 10),
              GradientButton(label: 'Export', onTap: _openExport),
            ],
          ),
          // Centered 9:16 aspect marker
          Container(
            width: 16,
            height: 25,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              border: Border.all(color: Colors.white, width: 1.6),
              borderRadius: BorderRadius.circular(5),
            ),
            child: const Text('9:16',
                style: TextStyle(fontSize: 6.5, fontWeight: FontWeight.w700, color: Colors.white)),
          ),
        ],
      ),
    );
  }

  // ---- Stage (fixed height) ----
  Widget _stage(double screenH) {
    final h = (screenH * _stageFrac).clamp(160.0, screenH * 0.58);
    return SizedBox(
      height: h,
      width: double.infinity,
      child: Container(
        color: Ec.stage,
        alignment: Alignment.center,
        child: _hasBase
            ? AspectRatio(
                aspectRatio: _aspect,
                child: Texture(textureId: _textureId!),
              )
            : Column(
                mainAxisSize: MainAxisSize.min,
                children: const [
                  Icon(Icons.movie_creation_outlined, size: 54, color: Colors.white24),
                  SizedBox(height: 14),
                  Text('Import a video to start',
                      style: TextStyle(color: Ec.textFaint, fontSize: 13)),
                ],
              ),
      ),
    );
  }

  // ---- Resize grip ----
  Widget _grip() {
    return GestureDetector(
      onVerticalDragUpdate: (d) {
        final screenH = MediaQuery.of(context).size.height;
        setState(() {
          _stageFrac = (_stageFrac + d.delta.dy / screenH).clamp(0.22, 0.58);
        });
      },
      child: Container(
        height: 20,
        alignment: Alignment.center,
        color: Ec.bg,
        child: Container(
          width: 44,
          height: 4,
          decoration: BoxDecoration(
            color: Colors.white.withValues(alpha: 0.18),
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      ),
    );
  }

  // ---- Transport ----
  Widget _transport() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: Row(
        children: [
          _icBtn(Icons.undo, () => _todo('Undo'), enabled: false),
          _icBtn(Icons.redo, () => _todo('Redo'), enabled: false),
          const Spacer(),
          GestureDetector(
            onTap: _togglePlay,
            child: Container(
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: _hasBase ? Colors.white.withValues(alpha: 0.08) : Colors.transparent,
              ),
              child: Icon(
                _playing ? Icons.pause : Icons.play_arrow,
                size: 30,
                color: _hasBase ? Colors.white : Ec.disabled,
              ),
            ),
          ),
          const Spacer(),
          _icBtnText('−', () {}),
          _icBtnText('＋', () {}),
        ],
      ),
    );
  }

  Widget _icBtn(IconData icon, VoidCallback onTap, {bool enabled = true}) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: SizedBox(
        width: 34,
        height: 34,
        child: Icon(icon, size: 21, color: enabled ? Ec.textDim : Ec.disabled),
      ),
    );
  }

  Widget _icBtnText(String label, VoidCallback onTap) {
    return GestureDetector(
      onTap: onTap,
      child: SizedBox(
        width: 34,
        height: 34,
        child: Center(
          child: Text(label, style: const TextStyle(fontSize: 18, color: Ec.textDim)),
        ),
      ),
    );
  }

  // ---- Timeline ----
  Widget _timeline() {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: MiniTimeline(
        hasClip: _hasBase,
        clipName: _clipName ?? '',
        positionMs: _positionMs,
        durationMs: _durationMs,
        onScrubStart: () => _scrubbing = true,
        onScrub: (ms) => setState(() => _positionMs = ms),
        onScrubEnd: (ms) async {
          _scrubbing = false;
          await _seek(ms);
        },
      ),
    );
  }
}
