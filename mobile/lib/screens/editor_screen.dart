import 'dart:async';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../editor/timeline_model.dart';
import '../native/exporter.dart';
import '../native/player.dart';
import '../theme.dart';
import '../widgets/tool_dock.dart';
import '../widgets/selected_toolbar.dart';
import '../widgets/mini_timeline.dart';
import '../sheets/export_sheet.dart';
import '../sheets/cutlord_sheet.dart';
import '../sheets/captions_sheet.dart';
import '../sheets/text_sheet.dart';
import '../sheets/audio_sheet.dart';
import '../sheets/settings_sheet.dart';
import '../sheets/silence_modal.dart';

/// The EaseCut mobile editor. Everything (preview, export, split/trim/delete, and —
/// next — Cut Lord) runs off a single [TimelineModel] of base-video clips fed to the
/// native ExoPlayer (preview) and Media3 Transformer (export).
class EditorScreen extends StatefulWidget {
  const EditorScreen({super.key});

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  final NativePlayer _player = NativePlayer();
  final NativeExporter _exporter = NativeExporter();
  final TimelineModel _model = TimelineModel();
  StreamSubscription<PlayerState>? _stateSub;
  StreamSubscription<dynamic>? _sizeSub;

  String? _clipName;
  int? _textureId;
  double _aspect = 9 / 16;

  int _positionMs = 0;
  int _sourceDurationMs = 0;
  bool _playing = false;
  bool _scrubbing = false;

  double _stageFrac = 0.46;
  bool _selected = false;

  @override
  void initState() {
    super.initState();
    _model.addListener(_onModel);
  }

  @override
  void dispose() {
    _model.removeListener(_onModel);
    _stateSub?.cancel();
    _sizeSub?.cancel();
    _player.release();
    _player.dispose();
    super.dispose();
  }

  void _onModel() {
    if (mounted) setState(() {});
  }

  bool get _hasBase => _model.hasBase && _textureId != null;
  int get _totalMs => _model.totalMs > 0 ? _model.totalMs : _sourceDurationMs;

  Future<void> _import() async {
    try {
      final res = await FilePicker.pickFiles(type: FileType.video);
      final path = res?.files.single.path;
      if (path == null) return;
      setState(() {
        _clipName = res!.files.single.name;
        _positionMs = 0;
        _sourceDurationMs = 0;
        _playing = false;
      });
      _textureId ??= await _player.create();
      _stateSub ??= _player.states.listen(_onState);
      _sizeSub ??= _player.sizes.listen((_) {
        if (mounted) setState(() => _aspect = _player.aspectRatio);
      });
      _model.setBase(path, 0); // duration filled in when the player reports it
      await _player.load(_model.playerSegments());
      if (mounted) setState(() {});
    } catch (e) {
      _toast('Import failed: $e');
    }
  }

  /// Rebuild the native playlist from the model after an edit, and land the
  /// playhead at [seekTo] (clamped).
  Future<void> _reload({int? seekTo}) async {
    if (!_model.hasBase) return;
    await _player.load(_model.playerSegments());
    final pos = (seekTo ?? _positionMs).clamp(0, _totalMs);
    await _player.seek(pos);
    setState(() => _positionMs = pos);
  }

  void _onState(PlayerState s) {
    if (!mounted) return;
    // The player reports the CURRENT item's clipped duration; use it once to fill
    // the source duration of the initial full clip (for split math + the ruler).
    if (s.durationMs > 0 && _sourceDurationMs == 0) {
      _sourceDurationMs = s.durationMs;
      _model.setDuration(s.durationMs);
    }
    setState(() {
      if (!_scrubbing) _positionMs = s.timelineMs;
      _playing = s.playing;
      if (s.ended) _playing = false;
    });
  }

  Future<void> _togglePlay() async {
    if (!_hasBase) return;
    if (_playing) {
      await _player.pause();
    } else {
      if (_totalMs > 0 && _positionMs >= _totalMs - 40) await _player.seek(0);
      await _player.play();
    }
  }

  Future<void> _seek(int ms) async {
    setState(() => _positionMs = ms);
    await _player.seek(ms);
  }

  // ---- edits ----
  Future<void> _split() async {
    if (_model.splitAt(_positionMs)) {
      await _reload(seekTo: _positionMs);
      _toast('Split');
    } else {
      _toast('Move the playhead onto a clip to split');
    }
  }

  Future<void> _deleteSelected() async {
    final i = _model.selected >= 0 ? _model.selected : _model.clipIndexAt(_positionMs);
    if (_model.clips.length <= 1) {
      _toast('Can’t delete the only clip');
      return;
    }
    final startAt = _model.clipStartMs(i);
    _model.deleteClip(i);
    setState(() => _selected = false);
    await _reload(seekTo: startAt);
  }

  void _onSelectedTool(String tool) {
    switch (tool) {
      case 'Split':
        _split();
        break;
      default:
        _toast('$tool — wires in the next build');
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: Ec.card));
  }

  // ---- sheets ----
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
        segments: _model.exportSegments(),
        videoSize: _player.videoSize,
      ),
    );
  }

  void _openSheet(Widget sheet) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => sheet,
    );
  }

  void _openCutLord() => _openSheet(CutLordSheet(onOpenSilence: () {
        Navigator.of(context).pop();
        _openSilence();
      }));
  void _openCaptions() => _openSheet(const CaptionsSheet());
  void _openText() => _openSheet(const TextSheet());
  void _openAudio() => _openSheet(const AudioSheet());
  void _openSettings() => _openSheet(const SettingsSheet());
  void _openSilence() => showDialog(context: context, builder: (_) => const SilenceModal());

  // "Edit" tile: select the clip under the playhead, else import.
  void _onEdit() {
    if (_hasBase) {
      _model.select(_model.clipIndexAt(_positionMs));
      setState(() => _selected = true);
    } else {
      _import();
    }
  }

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
            _selected
                ? SelectedToolbar(
                    onCollapse: () {
                      _model.select(-1);
                      setState(() => _selected = false);
                    },
                    onTool: _onSelectedTool,
                    onDelete: _deleteSelected,
                  )
                : ToolDock(
                    hasSelection: false,
                    onEdit: _onEdit,
                    onMusic: _openAudio,
                    onText: _openText,
                    onCutLord: _openCutLord,
                    onCaptions: _openCaptions,
                  ),
          ],
        ),
      ),
    );
  }

  Widget _topBar() {
    return Container(
      height: 52,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Ec.hair))),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Row(
            children: [
              GestureDetector(
                onTap: () => Navigator.of(context).maybePop(),
                child: Container(
                  width: 38,
                  height: 38,
                  alignment: Alignment.center,
                  child: const Icon(Icons.chevron_left, size: 26, color: Ec.text),
                ),
              ),
              const Spacer(),
              GestureDetector(
                onTap: _openSettings,
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

  Widget _stage(double screenH) {
    final h = (screenH * _stageFrac).clamp(160.0, screenH * 0.58);
    return SizedBox(
      height: h,
      width: double.infinity,
      child: Container(
        color: Ec.stage,
        alignment: Alignment.center,
        child: _hasBase
            ? AspectRatio(aspectRatio: _aspect, child: Texture(textureId: _textureId!))
            : GestureDetector(
                onTap: _import,
                behavior: HitTestBehavior.opaque,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(horizontal: 22, vertical: 13),
                      decoration: BoxDecoration(
                        color: Ec.indigo,
                        borderRadius: BorderRadius.circular(12),
                        boxShadow: [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 18, offset: const Offset(0, 6))],
                      ),
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.add_photo_alternate_outlined, color: Colors.white, size: 20),
                          SizedBox(width: 8),
                          Text('Import a video',
                              style: TextStyle(color: Colors.white, fontSize: 15, fontWeight: FontWeight.w700)),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    const Text('Tap to pick a clip from your phone',
                        style: TextStyle(color: Ec.textFaint, fontSize: 12)),
                  ],
                ),
              ),
      ),
    );
  }

  Widget _grip() {
    return GestureDetector(
      onVerticalDragUpdate: (d) {
        final screenH = MediaQuery.of(context).size.height;
        setState(() => _stageFrac = (_stageFrac + d.delta.dy / screenH).clamp(0.22, 0.58));
      },
      child: Container(
        height: 20,
        alignment: Alignment.center,
        color: Ec.bg,
        child: Container(
          width: 44,
          height: 4,
          decoration: BoxDecoration(color: Colors.white.withValues(alpha: 0.18), borderRadius: BorderRadius.circular(2)),
        ),
      ),
    );
  }

  Widget _transport() {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: Row(
        children: [
          _icBtn(Icons.undo, () {}, enabled: false),
          _icBtn(Icons.redo, () {}, enabled: false),
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
              child: Icon(_playing ? Icons.pause : Icons.play_arrow, size: 30, color: _hasBase ? Colors.white : Ec.disabled),
            ),
          ),
          const Spacer(),
          // Split at the playhead (the scissors live here as the primary edit).
          _icBtn(Icons.content_cut, _split, enabled: _hasBase),
          const SizedBox(width: 6),
          _icBtn(Icons.delete_outline, _deleteSelected, enabled: _hasBase && _model.clips.length > 1),
        ],
      ),
    );
  }

  Widget _icBtn(IconData icon, VoidCallback onTap, {bool enabled = true}) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: SizedBox(width: 34, height: 34, child: Icon(icon, size: 21, color: enabled ? Ec.textDim : Ec.disabled)),
    );
  }

  Widget _timeline() {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: MiniTimeline(
        model: _model,
        clipName: _clipName ?? '',
        positionMs: _positionMs,
        totalMs: _totalMs,
        onScrubStart: () => _scrubbing = true,
        onScrub: (ms) => setState(() => _positionMs = ms),
        onScrubEnd: (ms) async {
          _scrubbing = false;
          await _seek(ms);
        },
        onSelectClip: (i) {
          _model.select(i);
          setState(() => _selected = true);
        },
      ),
    );
  }
}
