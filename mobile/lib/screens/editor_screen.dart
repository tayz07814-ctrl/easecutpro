import 'dart:async';
import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../cloud/backend.dart';
import '../cloud/stt.dart' show Word;
import '../editor/timeline_model.dart';
import '../editor/text_overlay.dart';
import '../editor/audio_track.dart';
import '../editor/cutcutpro.dart';
import '../editor/cutlord.dart';
import '../editor/silence_settings.dart';
import '../native/exporter.dart';
import '../native/player.dart';
import '../theme.dart';
import '../widgets/tool_dock.dart';
import '../widgets/selected_toolbar.dart';
import '../widgets/mini_timeline.dart';
import '../widgets/editable_overlay.dart';
import '../sheets/export_sheet.dart';
import '../sheets/cutlord_sheet.dart';
import '../sheets/captions_sheet.dart';
import '../sheets/text_sheet.dart';
import '../sheets/audio_sheet.dart';
import '../sheets/settings_sheet.dart';
import '../sheets/silence_modal.dart';
import '../sheets/clip_tools_sheets.dart';
import '../sheets/cut_review_sheet.dart';

/// The EaseCut mobile editor. Everything (preview, export, split/trim/delete, and —
/// next — Cut Lord) runs off a single [TimelineModel] of base-video clips fed to the
/// native ExoPlayer (preview) and Media3 Transformer (export).
class EditorScreen extends StatefulWidget {
  /// When opened from New Project, the clip picked in the wizard so the editor
  /// auto-loads it (no need to import again).
  final String? initialClipPath;
  final String? initialClipName;
  final String? projectId; // when set, edits autosave to this Supabase project
  const EditorScreen({super.key, this.initialClipPath, this.initialClipName, this.projectId});

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
  final List<TextOverlay> _texts = []; // text + caption overlays
  TextOverlay? _selectedText; // overlay being edited on the preview
  final List<ImageOverlay> _images = []; // image / sticker overlays (PiP)
  ImageOverlay? _selectedImage;
  final List<_EditSnap> _undoStack = [];
  final List<_EditSnap> _redoStack = [];
  List<Word>? _transcript; // cached STT (reused by Cut Lord + Captions)
  final List<AudioTrack> _audios = []; // imported music/voiceover (mixed on export)
  int _selectedAudio = -1; // audio block selected on the timeline
  List<ThumbFrame> _thumbs = []; // filmstrip frames for the timeline
  List<double> _waveform = []; // whole-source amplitude peaks (0..1)
  Map<String, dynamic> _projectDoc = {}; // full project jsonb (autosave target)
  Timer? _saveTimer;

  @override
  void initState() {
    super.initState();
    _model.addListener(_onModel);
    if (widget.initialClipPath != null) {
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _importPath(widget.initialClipPath!, widget.initialClipName),
      );
    } else if (widget.projectId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadProject());
    }
  }

  @override
  void dispose() {
    _saveTimer?.cancel();
    _model.removeListener(_onModel);
    _stateSub?.cancel();
    _sizeSub?.cancel();
    _player.release();
    _player.dispose();
    super.dispose();
  }

  void _onModel() {
    if (mounted) setState(() {});
    _scheduleSave();
  }

  // ---- autosave (debounced) + reload ----
  void _scheduleSave() {
    if (widget.projectId == null) return;
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 1500), _saveNow);
  }

  Map<String, dynamic> _serialize() => {
        'v': 1,
        'sourcePath': _model.sourcePath,
        'clipName': _clipName,
        'durationMs': _sourceDurationMs,
        'clips': _model.clips.map((c) => c.toJson()).toList(),
        'texts': _texts.map((t) => t.toJson()).toList(),
        'audio': _audios.map((a) => a.toJson()).toList(),
      };

  /// Audio tracks as native-player maps (previewed alongside the video, placed at
  /// their timeline offset with their gain).
  List<Map<String, dynamic>> _audioTrackMaps() => [
        for (final a in _audios)
          {
            'uri': a.uri,
            'startMs': a.inMs,
            'endMs': a.outMs,
            'timelineStartMs': a.timelineStartMs,
            'volume': a.volume,
          }
      ];

  Future<void> _saveNow() async {
    if (widget.projectId == null || !_model.hasBase) return;
    _projectDoc['mobile'] = _serialize();
    try {
      await Backend.saveProject(widget.projectId!, _projectDoc);
    } catch (_) {
      // best-effort; a later edit retries
    }
  }

  Future<void> _loadProject() async {
    try {
      final doc = await Backend.loadProject(widget.projectId!);
      if (doc != null) _projectDoc = doc;
      final m = doc?['mobile'];
      if (m is Map) await _restoreFrom(Map<String, dynamic>.from(m));
    } catch (_) {}
  }

  Future<void> _restoreFrom(Map<String, dynamic> m) async {
    final src = m['sourcePath'] as String?;
    final clipsJson = (m['clips'] as List?) ?? [];
    if (src == null || clipsJson.isEmpty) return;
    if (!await File(src).exists()) {
      _toast('Media not found on this device — re-import to continue');
      return;
    }
    _clipName = m['clipName'] as String?;
    _sourceDurationMs = (m['durationMs'] as num?)?.toInt() ?? 0;
    _model.sourcePath = src;
    _model.sourceDurationMs = _sourceDurationMs;
    _model.restore(clipsJson.map((c) => EcClip.fromJson(c as Map)).toList());
    _texts
      ..clear()
      ..addAll(((m['texts'] as List?) ?? []).map((t) => TextOverlay.fromJson(t as Map)));
    _audios.clear();
    _selectedAudio = -1;
    for (final a in (m['audio'] as List?) ?? []) {
      _audios.add(AudioTrack.fromJson(a as Map));
    }
    _textureId ??= await _player.create();
    _stateSub ??= _player.states.listen(_onState);
    _sizeSub ??= _player.sizes.listen((_) {
      if (mounted) setState(() => _aspect = _player.aspectRatio);
    });
    await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
    _exporter.thumbnails('file://$src', 40).then((t) {
      if (mounted) setState(() => _thumbs = t);
    });
    _exporter.waveform('file://$src', buckets: 600).then((w) {
      if (mounted) setState(() => _waveform = w);
    });
    if (mounted) setState(() {});
  }

  bool get _hasBase => _model.hasBase && _textureId != null;
  int get _totalMs => _model.totalMs > 0 ? _model.totalMs : _sourceDurationMs;

  Future<void> _import() async {
    final res = await FilePicker.pickFiles(type: FileType.video, allowMultiple: true);
    final files = res?.files.where((f) => f.path != null).toList() ?? [];
    if (files.isEmpty) return;
    if (!_hasBase) {
      await _importPath(files.first.path!, files.first.name);
      for (final f in files.skip(1)) {
        await _appendClip(f.path!);
      }
    } else {
      // Already have a base — append everything to the end of the timeline.
      for (final f in files) {
        await _appendClip(f.path!);
      }
    }
  }

  /// Probe [path]'s duration and append it as a clip at the end of the timeline.
  Future<void> _appendClip(String path) async {
    final durMs = await _exporter.duration('file://$path');
    if (durMs <= 0) {
      _toast('Couldn’t read one of the clips');
      return;
    }
    _pushHistory();
    _model.appendClip(path, durMs);
    await _reload(seekTo: _positionMs);
    _scheduleSave();
  }

  Future<void> _importPath(String path, [String? name]) async {
    try {
      setState(() {
        _clipName = name ?? path.split('/').last;
        _positionMs = 0;
        _sourceDurationMs = 0;
        _playing = false;
        _transcript = null;
        _texts.clear();
        _thumbs = [];
        _waveform = [];
      });
      _textureId ??= await _player.create();
      _stateSub ??= _player.states.listen(_onState);
      _sizeSub ??= _player.sizes.listen((_) {
        if (mounted) setState(() => _aspect = _player.aspectRatio);
      });
      _model.setBase(path, 0); // duration filled in when the player reports it
      await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
      if (mounted) setState(() {});
      // Filmstrip + waveform (async, non-blocking).
      _exporter.thumbnails('file://$path', 40).then((t) {
        if (mounted) setState(() => _thumbs = t);
      });
      _exporter.waveform('file://$path', buckets: 600).then((w) {
        if (mounted) setState(() => _waveform = w);
      });
      _scheduleSave();
    } catch (e) {
      _toast('Import failed: $e');
    }
  }

  /// Rebuild the native playlist from the model after an edit, and land the
  /// playhead at [seekTo] (clamped).
  Future<void> _reload({int? seekTo}) async {
    if (!_model.hasBase) return;
    await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
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

  // ---- undo / redo (snapshots of clips + text overlays) ----
  _EditSnap _snap() => _EditSnap(
        _model.clips.map((c) => c.copy()).toList(),
        _texts.map((t) => t.copy()).toList(),
        _audios.map((a) => a.copy()).toList(),
      );

  /// Call BEFORE a structural edit so it can be undone.
  void _pushHistory() {
    _undoStack.add(_snap());
    _redoStack.clear();
    if (_undoStack.length > 60) _undoStack.removeAt(0);
  }

  void _applySnap(_EditSnap s) {
    _model.restore(s.clips.map((c) => c.copy()).toList());
    _texts
      ..clear()
      ..addAll(s.texts.map((t) => t.copy()));
    _audios
      ..clear()
      ..addAll(s.audios.map((a) => a.copy()));
    _selectedText = null;
    _selectedAudio = -1;
  }

  Future<void> _undo() async {
    if (_undoStack.isEmpty) return;
    _redoStack.add(_snap());
    _applySnap(_undoStack.removeLast());
    setState(() {});
    await _reload(seekTo: _positionMs.clamp(0, _model.totalMs));
  }

  Future<void> _redo() async {
    if (_redoStack.isEmpty) return;
    _undoStack.add(_snap());
    _applySnap(_redoStack.removeLast());
    setState(() {});
    await _reload(seekTo: _positionMs.clamp(0, _model.totalMs));
  }

  // ---- edits ----
  Future<void> _split() async {
    if (_model.clipIndexAt(_positionMs) < 0) {
      _toast('Move the playhead onto a clip to split');
      return;
    }
    _pushHistory();
    if (_model.splitAt(_positionMs)) {
      await _reload(seekTo: _positionMs);
    } else {
      _undoStack.removeLast(); // nothing changed
      _toast('Move the playhead onto a clip to split');
    }
  }

  Future<void> _deleteSelected() async {
    final i = _model.selected >= 0 ? _model.selected : _model.clipIndexAt(_positionMs);
    if (_model.clips.length <= 1) {
      _toast('Can’t delete the only clip');
      return;
    }
    _pushHistory();
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
      case 'Speed':
        _openSpeed();
        break;
      case 'Volume':
        _openVolume();
        break;
      case 'Crop':
        _openCrop();
        break;
      case 'Extract':
        _extractClipAudio();
        break;
      case 'Overlay':
        _addOverlay();
        break;
      default:
        _toast('$tool — coming soon');
    }
  }

  /// Overlay tool: pick an image and drop it on the video as a PiP / sticker
  /// (draggable + pinch-resizable on the preview, baked into export).
  Future<void> _addOverlay() async {
    final res = await FilePicker.pickFiles(type: FileType.image, withData: true);
    final bytes = (res != null && res.files.isNotEmpty) ? res.files.first.bytes : null;
    if (bytes == null) return;
    final o = ImageOverlay(
      bytes: bytes,
      startMs: _positionMs,
      endMs: (_positionMs + 4000).clamp(0, _totalMs > 0 ? _totalMs : _positionMs + 4000),
    );
    _pushHistory();
    setState(() {
      _images.add(o);
      _selectedImage = o;
      _selectedText = null;
      _selected = false;
    });
    _model.select(-1);
    _scheduleSave();
  }

  /// The clip the selected-clip tools act on (selection, else the one at the playhead).
  int _selectedIndex() {
    if (_model.selected >= 0 && _model.selected < _model.clips.length) return _model.selected;
    return _model.clipIndexAt(_positionMs);
  }

  Future<void> _openSpeed() async {
    final i = _selectedIndex();
    if (i < 0) return;
    _pushHistory();
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => SpeedSheet(
        initial: _model.clips[i].speed,
        onChanged: (v) {
          _model.setSpeed(i, v); // live timeline length; player reloads on close
          setState(() {});
        },
      ),
    );
    await _reload(seekTo: _model.clipStartMs(i));
  }

  Future<void> _openVolume() async {
    final i = _selectedIndex();
    if (i < 0) return;
    _pushHistory();
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => VolumeSheet(
        initial: _model.clips[i].volume,
        onChanged: (v) => _model.setVolume(i, v),
      ),
    );
    await _reload(seekTo: _model.clipStartMs(i));
  }

  void _openCrop() {
    final i = _selectedIndex();
    if (i < 0) return;
    _pushHistory();
    _openSheet(CropSheet(
      sourceAspect: _aspect,
      onPick: (l, t, r, b) {
        _model.setCrop(i, l: l, t: t, r: r, b: b); // preview crop is Dart-side (no reload)
        setState(() {});
      },
    ));
  }

  Future<void> _extractClipAudio() async {
    final i = _selectedIndex();
    if (i < 0) return;
    final c = _model.clips[i];
    final prog = ValueNotifier<String>('Extracting audio…');
    _showProgress(prog);
    try {
      final path = await _exporter.extractAudio('file://${c.sourcePath}');
      _pushHistory();
      setState(() {
        // Detached audio as its own track — windowed to the clip and placed at the
        // clip's timeline position — then mute the source clip.
        _audios.add(AudioTrack(
          uri: 'file://$path',
          name: 'Clip ${i + 1} audio',
          inMs: c.inMs,
          outMs: c.outMs,
          durMs: _sourceDurationMs > 0 ? _sourceDurationMs : c.outMs,
          timelineStartMs: _model.clipStartMs(i),
        ));
        _model.setVolume(i, 0);
      });
      if (mounted) Navigator.of(context).pop();
      await _reload(seekTo: _model.clipStartMs(i));
      _toast('Audio detached to its own track');
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      _toast('Extract failed: ${_cleanErr(e)}');
    } finally {
      prog.dispose();
    }
  }

  void _toast(String msg) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg), backgroundColor: Ec.card));
  }

  // ---- sheets ----
  Future<void> _openExport() async {
    if (!_hasBase) {
      _toast('Import a clip first');
      return;
    }
    final size = _player.videoSize;
    _openSheet(ExportSheet(
      exporter: _exporter,
      segments: _model.exportSegments(),
      overlays: List<TextOverlay>.from(_texts), // baked at the chosen output size
      imageOverlays: List<ImageOverlay>.from(_images),
      audioTracks: [
        for (final a in _audios)
          ExportSegment(
            uri: a.uri,
            startMs: a.inMs,
            endMs: a.outMs,
            volume: a.volume,
            timelineStartMs: a.timelineStartMs,
          ),
      ],
      videoSize: size,
    ));
  }

  void _openSheet(Widget sheet) {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => sheet,
    );
  }

  void _openCutLord() => _openSheet(CutLordSheet(
        onOpenSilence: () {
          Navigator.of(context).pop();
          _openSilence();
        },
        onRun: _runCutLord,
      ));
  void _openCaptions() => _openSheet(CaptionsSheet(onGenerate: (_) => _generateCaptions()));

  // ---- Cut Lord: transcribe → SHOW transcript → judge in background → apply ----
  Future<void> _runCutLord(CutLordModel model, bool cutSilence) async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    // 1) Transcribe (the only blocking step — the transcript drives everything).
    final prog = ValueNotifier<String>('Starting…');
    _showProgress(prog);
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
      _toast('Transcription failed: ${_cleanErr(e)}');
      return;
    }
    if (mounted) Navigator.of(context).pop();
    prog.dispose();
    final words = _transcript!;
    if (words.isEmpty) {
      _toast('Couldn’t hear any speech to cut.');
      return;
    }

    // 2) Open the transcript review immediately; the AI judge runs in the background.
    final aiCuts = ValueNotifier<List<List<int>>>(const []);
    final judging = ValueNotifier<bool>(true);
    var closed = false;

    // Background judge — a hard timeout so a slow/blocked model never traps the user
    // on an empty proposal; the transcript stays fully usable for manual cuts.
    Future(() async {
      try {
        final res = await judge(
          words,
          model,
          _sourceDurationMs / 1000.0,
          cutSilence: cutSilence,
          minPauseS: SilenceSettings.trimS,
          padS: SilenceSettings.keepS,
        ).timeout(const Duration(seconds: 130));
        if (!closed) aiCuts.value = res.wordCuts;
      } catch (_) {
        // leave the review manual — the model was slow, blocked, or found nothing
      } finally {
        if (!closed) judging.value = false;
      }
    });

    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => CutReviewSheet(
        words: words,
        aiCuts: aiCuts,
        judging: judging,
        modelLabel: model.label,
        onExecute: (finalCuts) {
          Navigator.of(context).pop(); // close review sheet
          _applyCuts(finalCuts, cutSilence, model.label);
        },
      ),
    );
    closed = true;
  }

  /// Compute keep-ranges from (reviewed) word cuts + silence, snapshot for undo,
  /// then apply to the timeline.
  Future<void> _applyCuts(List<List<int>> wordCuts, bool cutSilence, String label) async {
    if (_transcript == null) return;
    final keeps = keepRanges(
      _transcript!,
      wordCuts,
      _sourceDurationMs / 1000.0,
      cutSilence: cutSilence,
      minPauseS: SilenceSettings.trimS,
      padS: SilenceSettings.keepS,
    );
    _pushHistory();
    _texts.removeWhere((t) => t.isCaption); // stale after a re-cut
    _model.applyKeepRanges(keeps);
    await _reload(seekTo: 0);
    // No snackbar — the top-bar / transport undo buttons are the undo affordance.
  }

  Future<void> _generateCaptions() async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    final prog = ValueNotifier<String>('Starting…');
    _showProgress(prog);
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
      final lines = groupCaptions(_transcript!);
      _pushHistory();
      _texts.removeWhere((t) => t.isCaption);
      for (final l in lines) {
        final s = _model.sourceToEdited((l.startS * 1000).round());
        if (s == null) continue;
        final e0 = _model.sourceToEdited((l.endS * 1000).round()) ?? (s + 500);
        final e = e0 <= s ? (s + 500) : (e0 > _totalMs ? _totalMs : e0);
        _texts.add(TextOverlay(
            text: l.text, y: 0.85, fontSize: 0.05, bold: true, startMs: s, endMs: e, isCaption: true));
      }
      if (mounted) {
        Navigator.of(context).pop();
        setState(() {});
      }
      _scheduleSave();
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      _toast('Captions failed: ${_cleanErr(e)}');
    } finally {
      prog.dispose();
    }
  }

  void _showProgress(ValueNotifier<String> msg) {
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => Dialog(
        backgroundColor: Ec.card,
        child: Padding(
          padding: const EdgeInsets.all(22),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Ec.indigo)),
              const SizedBox(width: 16),
              Flexible(
                child: ValueListenableBuilder<String>(
                  valueListenable: msg,
                  builder: (_, v, _) => Text(v, style: const TextStyle(color: Ec.text, fontSize: 13)),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  String _cleanErr(Object e) {
    var s = e.toString();
    if (s.startsWith('Exception: ')) s = s.substring(11);
    return s.length > 140 ? '${s.substring(0, 140)}…' : s;
  }
  void _openText() => _openSheet(TextSheet(onAdd: (t) {
        t.startMs = _positionMs;
        t.endMs = (_positionMs + 3000).clamp(0, _totalMs > 0 ? _totalMs : _positionMs + 3000);
        _pushHistory();
        setState(() {
          _texts.add(t);
          _selectedText = t; // ready to drag/resize on the preview
        });
        _scheduleSave();
      }));
  void _openAudio() => _openSheet(AudioSheet(
        names: [for (final a in _audios) a.name],
        volumes: [for (final a in _audios) a.volume],
        selected: _selectedAudio,
        onImport: (path, name) async {
          final dur = await _exporter.duration('file://$path');
          _pushHistory();
          setState(() {
            _audios.add(AudioTrack(
              uri: 'file://$path',
              name: name,
              inMs: 0,
              outMs: dur > 0 ? dur : 0,
              durMs: dur > 0 ? dur : 0,
              timelineStartMs: 0,
            ));
          });
          _scheduleSave();
          if (_hasBase) _reload(seekTo: _positionMs); // preview the new track
        },
        onRemove: (i) {
          _pushHistory();
          setState(() {
            _audios.removeAt(i);
            if (_selectedAudio >= _audios.length) _selectedAudio = -1;
          });
          _scheduleSave();
          if (_hasBase) _reload(seekTo: _positionMs);
        },
        onVolume: (i, v) {
          setState(() => _audios[i].volume = v);
          _scheduleSave();
          if (_hasBase) _reload(seekTo: _positionMs);
        },
      ));
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

  Widget _undoRedoBtn(IconData ic, bool enabled, VoidCallback onTap) => GestureDetector(
        onTap: enabled ? onTap : null,
        behavior: HitTestBehavior.opaque,
        child: SizedBox(
          width: 34,
          height: 38,
          child: Icon(ic, size: 20, color: enabled ? Ec.text : Ec.disabled),
        ),
      );

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
              _undoRedoBtn(Icons.undo, _undoStack.isNotEmpty, _undo),
              _undoRedoBtn(Icons.redo, _redoStack.isNotEmpty, _redo),
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

  /// Cover-zoom the preview to the crop of the clip under the playhead (per-clip,
  /// matching the export Crop effect).
  Widget _cropped(Widget child) {
    final idx = _model.clipIndexAt(_positionMs);
    if (idx < 0 || idx >= _model.clips.length) return child;
    final c = _model.clips[idx];
    if (!c.hasCrop) return child;
    final vw = (1 - c.cropL - c.cropR).clamp(0.05, 1.0);
    final vh = (1 - c.cropT - c.cropB).clamp(0.05, 1.0);
    final ax = (c.cropL + c.cropR) > 0 ? (c.cropL - c.cropR) / (c.cropL + c.cropR) : 0.0;
    final ay = (c.cropT + c.cropB) > 0 ? (c.cropT - c.cropB) / (c.cropT + c.cropB) : 0.0;
    return ClipRect(
      child: LayoutBuilder(
        builder: (_, bc) => OverflowBox(
          alignment: Alignment(ax, ay),
          maxWidth: bc.maxWidth / vw,
          maxHeight: bc.maxHeight / vh,
          child: SizedBox(width: bc.maxWidth / vw, height: bc.maxHeight / vh, child: child),
        ),
      ),
    );
  }

  /// Floating controls for the selected overlay: re-time to the playhead, edit,
  /// or delete. Drag to move + pinch to resize are on the overlay itself.
  Widget _textControlBar(TextOverlay t) {
    Widget btn(IconData ic, String label, VoidCallback onTap, {Color? c}) => GestureDetector(
          onTap: onTap,
          behavior: HitTestBehavior.opaque,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(ic, size: 18, color: c ?? Ec.text),
                const SizedBox(height: 2),
                Text(label, style: TextStyle(fontSize: 9.5, color: c ?? Ec.textDim)),
              ],
            ),
          ),
        );
    return Container(
      decoration: BoxDecoration(
        color: Ec.sheet.withValues(alpha: 0.92),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Ec.hair2),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          btn(Icons.login, 'Start', () {
            setState(() => t.startMs = _positionMs);
            _scheduleSave();
          }),
          btn(Icons.logout, 'End', () {
            setState(() => t.endMs = _positionMs <= t.startMs ? t.startMs + 500 : _positionMs);
            _scheduleSave();
          }),
          btn(Icons.edit_outlined, 'Edit', () => _editOverlayText(t)),
          btn(Icons.delete_outline, 'Delete', () {
            _pushHistory();
            setState(() {
              _texts.remove(t);
              _selectedText = null;
            });
            _scheduleSave();
          }, c: const Color(0xFFFF8A9A)),
        ],
      ),
    );
  }

  Future<void> _editOverlayText(TextOverlay t) async {
    final ctrl = TextEditingController(text: t.text);
    final result = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        title: const Text('Edit text', style: TextStyle(color: Ec.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          maxLines: null,
          style: const TextStyle(color: Ec.text),
          decoration: const InputDecoration(hintText: 'Text', hintStyle: TextStyle(color: Ec.textFaint)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
          TextButton(onPressed: () => Navigator.of(context).pop(ctrl.text), child: const Text('Save')),
        ],
      ),
    );
    if (result != null) {
      setState(() => t.text = result);
      _scheduleSave();
    }
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
            ? AspectRatio(
                aspectRatio: _aspect,
                child: LayoutBuilder(
                  builder: (context, c) {
                    final frame = Size(c.maxWidth, c.maxHeight);
                    return Stack(
                      fit: StackFit.expand,
                      children: [
                        GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: () => setState(() {
                            _selectedText = null;
                            _selectedImage = null;
                          }),
                          child: _cropped(Texture(textureId: _textureId!)),
                        ),
                        for (final o in _images)
                          if (o.activeAt(_positionMs) || identical(o, _selectedImage))
                            EditableImageOverlay(
                              o: o,
                              frame: frame,
                              selected: identical(o, _selectedImage),
                              onSelect: () => setState(() {
                                _selectedImage = o;
                                _selectedText = null;
                              }),
                              onChange: () {
                                setState(() {});
                                _scheduleSave();
                              },
                            ),
                        for (final t in _texts)
                          if (t.activeAt(_positionMs) || identical(t, _selectedText))
                            EditableOverlay(
                              t: t,
                              frame: frame,
                              selected: identical(t, _selectedText),
                              onSelect: () => setState(() => _selectedText = t),
                              onChange: () {
                                setState(() {});
                                _scheduleSave();
                              },
                            ),
                        if (_selectedText != null && _selectedText!.activeAt(_positionMs))
                          Positioned(
                            left: 0,
                            right: 0,
                            bottom: 6,
                            child: Center(child: _textControlBar(_selectedText!)),
                          ),
                      ],
                    );
                  },
                ),
              )
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
          _icBtn(Icons.undo, _undo, enabled: _undoStack.isNotEmpty),
          _icBtn(Icons.redo, _redo, enabled: _redoStack.isNotEmpty),
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
        thumbs: _thumbs,
        waveform: _waveform,
        sourceDurationMs: _sourceDurationMs,
        audios: _audios,
        selectedAudio: _selectedAudio,
        texts: _texts,
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
        onSelectText: (t) async {
          setState(() => _selectedText = t);
          await _seek(t.startMs.clamp(0, _totalMs > 0 ? _totalMs : t.startMs)); // jump so it's visible + editable
        },
        onSelectAudio: (i) async {
          setState(() {
            _selectedAudio = i;
            _selectedText = null;
          });
          if (i >= 0 && i < _audios.length) {
            await _seek(_audios[i].timelineStartMs.clamp(0, _totalMs > 0 ? _totalMs : _audios[i].timelineStartMs));
          }
        },
        onAudioEditStart: () {
          setState(() => _selectedText = null);
          _pushHistory();
        },
        onAudioMove: (i, dMs) {
          setState(() {
            _selectedAudio = i;
            final a = _audios[i];
            a.timelineStartMs = (a.timelineStartMs + dMs).clamp(0, 1 << 30);
          });
        },
        onAudioTrim: (i, {startDeltaMs, endDeltaMs}) {
          setState(() {
            _selectedAudio = i;
            final a = _audios[i];
            if (startDeltaMs != null) {
              // Move the left edge: shift in-point AND timeline start together,
              // clamped so ≥0 and at least 200ms of content remains.
              final d = startDeltaMs.clamp(-a.inMs, a.outMs - a.inMs - 200);
              a.inMs += d;
              a.timelineStartMs = (a.timelineStartMs + d).clamp(0, 1 << 30);
            }
            if (endDeltaMs != null) {
              final maxOut = a.durMs > 0 ? a.durMs : a.outMs + endDeltaMs;
              a.outMs = (a.outMs + endDeltaMs).clamp(a.inMs + 200, maxOut);
            }
          });
        },
        onAudioEditEnd: () async {
          _scheduleSave();
          if (_hasBase) await _reload(seekTo: _positionMs);
        },
        onOverlayEditStart: () {
          setState(() => _selectedText = null); // avoid preview-drag interference
          _pushHistory();
        },
        onOverlayMove: (t, dMs) {
          setState(() {
            final total = _totalMs;
            final len = t.endMs - t.startMs;
            final ns = (t.startMs + dMs).clamp(0, (total - len).clamp(0, total));
            t.startMs = ns;
            t.endMs = ns + len;
          });
        },
        onOverlayTrim: (t, {startDeltaMs, endDeltaMs}) {
          setState(() {
            if (startDeltaMs != null) {
              t.startMs = (t.startMs + startDeltaMs).clamp(0, t.endMs - 200);
            }
            if (endDeltaMs != null) {
              final max = _totalMs > 0 ? _totalMs : t.endMs + endDeltaMs;
              t.endMs = (t.endMs + endDeltaMs).clamp(t.startMs + 200, max);
            }
          });
        },
        onOverlayEditEnd: () => _scheduleSave(),
        onTrimStart: () {
          _scrubbing = true;
          _pushHistory();
        },
        onTrim: (i, {inMs, outMs}) {
          _model.trim(i, inMs: inMs, outMs: outMs);
          setState(() {});
        },
        onTrimEnd: () async {
          _scrubbing = false;
          await _reload(seekTo: _model.clipStartMs(_model.selected < 0 ? 0 : _model.selected));
        },
      ),
    );
  }
}

/// An immutable snapshot of the editable state (clips + text overlays) for undo/redo.
class _EditSnap {
  final List<EcClip> clips;
  final List<TextOverlay> texts;
  final List<AudioTrack> audios;
  _EditSnap(this.clips, this.texts, this.audios);
}
