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
import '../editor/autozoom.dart';
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
  // "Enhance on import" (set from the dashboard): after the initial clip loads,
  // auto-apply the silence/bad-take cuts and/or auto-generate captions.
  final bool enhanceCutSilence;
  final bool enhanceCaptions;
  const EditorScreen({
    super.key,
    this.initialClipPath,
    this.initialClipName,
    this.projectId,
    this.enhanceCutSilence = false,
    this.enhanceCaptions = false,
  });

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

  // Playhead interpolation: the native player reports position at ~30 Hz; between
  // those anchors we advance the displayed position by wall-clock time so the
  // playhead glides at 60 fps instead of stepping. Timeline position advances at
  // 1× wall time regardless of clip speed, so plain elapsed-ms interpolation is
  // correct; each native tick re-anchors and corrects any drift.
  Timer? _tick;
  int _anchorMs = 0;
  final Stopwatch _sw = Stopwatch();

  @override
  void initState() {
    super.initState();
    _model.addListener(_onModel);
    _tick = Timer.periodic(const Duration(milliseconds: 16), (_) => _interpolate());
    if (widget.initialClipPath != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        await _importPath(widget.initialClipPath!, widget.initialClipName);
        await _autoEnhanceOnImport();
      });
    } else if (widget.projectId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadProject());
    }
  }

  @override
  void dispose() {
    _saveTimer?.cancel();
    _tick?.cancel();
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
      if (!_scrubbing) {
        _positionMs = s.timelineMs;
        // Re-anchor the interpolation clock to this authoritative position.
        _anchorMs = s.timelineMs;
        _sw..reset()..start();
      }
      _playing = s.playing;
      if (s.ended) _playing = false;
      if (!_playing) _sw.stop();
    });
  }

  /// Advance the displayed playhead between native ticks for smooth 60 fps motion.
  void _interpolate() {
    if (!mounted || !_playing || _scrubbing || !_sw.isRunning) return;
    final p = (_anchorMs + _sw.elapsedMilliseconds).clamp(0, _totalMs);
    if (p != _positionMs) setState(() => _positionMs = p);
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
    setState(() {
      _positionMs = ms;
      _anchorMs = ms;
      _sw.reset();
      if (_playing) _sw.start();
    });
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
      case 'Zoom':
        _openZoom();
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

  // ---- lane packing (Task 5): items on the SAME track never overlap in time ----

  /// Lowest free lane (0-based) on which [startMs,endMs] doesn't overlap any span
  /// in [laneSpans] on that same lane. Each span is `[start, end, lane]`.
  int _freeLane(List<List<int>> laneSpans, int startMs, int endMs) {
    for (int lane = 0;; lane++) {
      var ok = true;
      for (final s in laneSpans) {
        if (s[2] == lane && startMs < s[1] && endMs > s[0]) {
          ok = false;
          break;
        }
      }
      if (ok) return lane;
    }
  }

  /// `[start, end, lane]` spans for the text/caption track matching [captions].
  List<List<int>> _textLaneSpans(bool captions) =>
      [for (final t in _texts) if (t.isCaption == captions) [t.startMs, t.endMs, t.lane]];

  /// `[start, end, lane]` spans for the image / PiP track.
  List<List<int>> _imageLaneSpans() =>
      [for (final o in _images) [o.startMs, o.endMs, o.lane]];

  /// Clamp a proposed start [ns] for an item of length [len] so it can't overlap a
  /// neighbour on the same lane — it stops flush against the nearest neighbour edge.
  /// Neighbours are classified by the item's CURRENT (pre-move, non-overlapping)
  /// [curStart]/[curEnd] so even a fast drag is clamped to the correct edge.
  int _clampNoOverlap(
      List<List<int>> sameLaneSpans, int ns, int curStart, int curEnd, int len, int total) {
    int lo = 0;
    int hi = (total - len) < 0 ? 0 : (total - len);
    for (final s in sameLaneSpans) {
      final ss = s[0], se = s[1];
      if (se <= curStart) {
        if (se > lo) lo = se; // neighbour on the left
      } else if (ss >= curEnd) {
        if (ss - len < hi) hi = ss - len; // neighbour on the right
      }
    }
    if (hi < lo) hi = lo;
    return ns.clamp(lo, hi);
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
    // Drop onto the lowest free lane at the playhead so it never lands on top of
    // an existing image (respecting each item's own duration).
    o.lane = _freeLane(_imageLaneSpans(), o.startMs, o.endMs);
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

  void _openZoom() {
    final i = _selectedIndex();
    if (i < 0) return;
    final c = _model.clips[i];
    // recover the current zoom from a symmetric crop (else start at 1.0×)
    final sym = (c.cropL == c.cropR && c.cropT == c.cropB && c.cropL == c.cropT) ? c.cropL : 0.0;
    final curZoom = (sym > 0 && sym < 0.49) ? 1.0 / (1.0 - 2 * sym) : 1.0;
    _pushHistory();
    _openSheet(ZoomSheet(
      initial: curZoom,
      onChanged: (z) {
        final crop = z <= 1.0 ? 0.0 : (1.0 - 1.0 / z) / 2.0;
        _model.setCrop(i, l: crop, t: crop, r: crop, b: crop); // centred punch = symmetric crop
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
        onAutoZoom: _autoZoom,
        onAutoBroll: _autoBroll,
      ));

  // ---- Auto Zoom: transcript → auto-zoom-judge → per-clip centred punch-in ----
  Future<void> _autoZoom() async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    final prog = ValueNotifier<String>('Preparing…');
    _showProgress(prog);
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
      final words = _transcript!;
      // One un-cut clip → split at sentence groups so Auto Zoom has segments.
      if (_model.clips.length < 2 && words.isNotEmpty) {
        final groups = groupCaptions(words);
        final points = <int>[];
        for (int g = 1; g < groups.length; g++) {
          final ms = (groups[g].startS * 1000).round();
          if (ms > 500 && ms < _totalMs - 500) points.add(ms);
        }
        points.sort((a, b) => b.compareTo(a)); // descending so earlier splits stay valid
        for (final ms in points) {
          _model.splitAt(ms);
        }
      }
      prog.value = 'Finding moments to zoom…';
      final clips = _model.clips;
      final eligible = <Map<String, dynamic>>[]; // {i, clipIdx, t, d}
      for (int ci = 0; ci < clips.length; ci++) {
        final c = clips[ci];
        final d = c.timelineLenMs / 1000.0;
        if (d < 0.9) continue;
        final buf = StringBuffer();
        for (final w in words) {
          final ms = w.start * 1000;
          if (ms >= c.inMs && ms < c.outMs) {
            buf.write(w.text.trim());
            buf.write(' ');
          }
        }
        final t = buf.toString().trim();
        if (t.isEmpty) continue;
        eligible.add({'i': eligible.length, 'clipIdx': ci, 't': t.length > 180 ? t.substring(0, 180) : t, 'd': (d * 10).round() / 10});
      }
      if (eligible.isEmpty) {
        if (mounted) Navigator.of(context).pop();
        prog.dispose();
        _toast('No clips long enough to zoom.');
        return;
      }
      var picks = await judgeZooms(eligible.map((e) => {'i': e['i'], 't': e['t'], 'd': e['d']}).toList());
      if (picks.isEmpty) picks = fallbackZooms(eligible.map((e) => {'i': e['i'] as int, 'd': e['d']}).toList());

      final budget = (eligible.length * 0.55).floor().clamp(1, eligible.length);
      final applied = <int>{};
      _pushHistory();
      picks.sort((a, b) => b.level.compareTo(a.level));
      var n = 0;
      for (final p in picks) {
        if (applied.length >= budget) break;
        if (p.i < 0 || p.i >= eligible.length) continue;
        if (applied.contains(p.i) || applied.contains(p.i - 1) || applied.contains(p.i + 1)) continue;
        applied.add(p.i);
        final clipIdx = eligible[p.i]['clipIdx'] as int;
        final crop = (1.0 - 1.0 / p.level) / 2.0;
        _model.setCrop(clipIdx, l: crop, t: crop, r: crop, b: crop);
        n++;
      }
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
      await _reload(seekTo: 0);
      _toast(n > 0 ? 'Added zoom to $n moment${n == 1 ? '' : 's'}.' : 'No zooms added.');
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
      _toast('Auto Zoom failed: ${_cleanErr(e)}');
    }
  }

  // ---- Auto B-roll: pick photos → spread them across the timeline as timed,
  // full-frame overlays (mobile has no stock library, so you supply the images). --
  Future<void> _autoBroll() async {
    if (!_hasBase || _totalMs <= 0) {
      _toast('Import a clip first');
      return;
    }
    final res = await FilePicker.pickFiles(type: FileType.image, allowMultiple: true, withData: true);
    final files = res?.files.where((f) => f.bytes != null).toList() ?? [];
    if (files.isEmpty) return;
    const clipMs = 2500;
    final n = files.length;
    final slot = _totalMs / n;
    final maxStart = (_totalMs - clipMs) <= 0 ? 0 : (_totalMs - clipMs);
    _pushHistory();
    setState(() {
      for (int k = 0; k < n; k++) {
        final start = (slot * k + slot / 2 - clipMs / 2).clamp(0, maxStart).round();
        final end = (start + clipMs).clamp(0, _totalMs);
        final o = ImageOverlay(
          bytes: files[k].bytes!,
          x: 0.5,
          y: 0.5,
          scale: 1.0, // full-frame b-roll
          startMs: start,
          endMs: end,
        );
        // Stack onto a free lane if this slot would collide with one already placed.
        o.lane = _freeLane(_imageLaneSpans(), start, end);
        _images.add(o);
      }
    });
    _toast('Placed $n b-roll clip${n == 1 ? '' : 's'} — drag any to fine-tune.');
  }
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
      minPauseS: SilenceSettings.minGapS,
      padS: SilenceSettings.padAfterS,
      airAfterS: SilenceSettings.padAfterS,
      leadBeforeS: SilenceSettings.padBeforeS,
    );
    _pushHistory();
    _texts.removeWhere((t) => t.isCaption); // stale after a re-cut
    _model.applyKeepRanges(keeps);
    await _reload(seekTo: 0);
    // No snackbar — the top-bar / transport undo buttons are the undo affordance.
  }

  /// "Enhance on import": after the initial clip loads, optionally auto-apply the
  /// silence/bad-take cuts and/or auto-generate captions — no review sheet, mirroring
  /// the web "Enhance & open editor" flow. Runs cuts first (so captions land on the
  /// cut timeline), reusing the cached transcript so it never transcribes twice.
  Future<void> _autoEnhanceOnImport() async {
    if (!mounted || !(widget.enhanceCutSilence || widget.enhanceCaptions)) return;
    final src = _model.sourcePath;
    if (src == null || !_model.hasBase) return;
    // The judge + keep-range maths need the real source duration; the player may
    // not have reported it yet, so probe it directly if it's still unknown.
    if (_sourceDurationMs <= 0) {
      final d = await _exporter.duration('file://$src');
      if (!mounted) return;
      if (d > 0) {
        _sourceDurationMs = d;
        _model.setDuration(d);
      }
    }
    if (_sourceDurationMs <= 0) return; // can't safely enhance without a duration
    if (widget.enhanceCutSilence) {
      await _autoApplySilenceCuts();
      if (!mounted) return;
    }
    if (widget.enhanceCaptions && mounted) {
      await _generateCaptions();
    }
  }

  /// Transcribe → judge → APPLY the cuts directly (no review), reusing the same
  /// judge+apply logic as [_runCutLord] but auto-committing.
  Future<void> _autoApplySilenceCuts() async {
    if (!_hasBase || _model.sourcePath == null || _sourceDurationMs <= 0) return;
    final prog = ValueNotifier<String>('Enhancing…');
    _showProgress(prog);
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
      final words = _transcript!;
      if (words.isEmpty) {
        if (mounted) Navigator.of(context).pop();
        return;
      }
      prog.value = 'Finding cuts…';
      final res = await judge(
        words,
        cutLordRetake,
        _sourceDurationMs / 1000.0,
        cutSilence: true,
        minPauseS: SilenceSettings.trimS,
        padS: SilenceSettings.keepS,
      ).timeout(const Duration(seconds: 130));
      if (mounted) Navigator.of(context).pop();
      await _applyCuts(res.wordCuts, true, cutLordRetake.label);
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      _toast('Auto enhance failed: ${_cleanErr(e)}');
    } finally {
      prog.dispose();
    }
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
        final lane = _freeLane(_textLaneSpans(true), s, e);
        _texts.add(TextOverlay(
            text: l.text, y: 0.85, fontSize: 0.05, bold: true, startMs: s, endMs: e, isCaption: true, lane: lane));
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
        // Place on the lowest free lane at the playhead so it doesn't stack on top
        // of an existing text block (keeps its own duration intact).
        t.lane = _freeLane(_textLaneSpans(t.isCaption), t.startMs, t.endMs);
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
        images: _images,
        selectedImage: _selectedImage,
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
        // Hold-drag a main clip to reorder it in the sequence. The grabbed clip
        // floats under the finger; the reorder is committed once, on release, then
        // the native player is rebuilt for the new order.
        onClipReorderStart: () {
          setState(() {
            _selected = true;
            _selectedText = null;
            _selectedImage = null;
          });
        },
        onClipReorder: (from, to) {
          _pushHistory();
          _model.moveClip(from, to);
        },
        onClipReorderEnd: () async {
          _scheduleSave();
          if (_hasBase) {
            await _reload(seekTo: _model.clipStartMs(_model.selected < 0 ? 0 : _model.selected));
          }
        },
        onSelectText: (t) async {
          setState(() {
            _selectedText = t;
            _selectedImage = null;
          });
          await _seek(t.startMs.clamp(0, _totalMs > 0 ? _totalMs : t.startMs)); // jump so it's visible + editable
        },
        onSelectImage: (o) async {
          setState(() {
            _selectedImage = o;
            _selectedText = null;
          });
          await _seek(o.startMs.clamp(0, _totalMs > 0 ? _totalMs : o.startMs));
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
            // Same-lane, same-track neighbours (excluding this block).
            final spans = [
              for (final o in _texts)
                if (o.isCaption == t.isCaption && o.lane == t.lane && !identical(o, t))
                  [o.startMs, o.endMs]
            ];
            final ns = _clampNoOverlap(spans, t.startMs + dMs, t.startMs, t.endMs, len, total);
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
        onImageEditStart: () {
          setState(() {
            _selectedText = null;
            _selectedImage = null;
          });
          _pushHistory();
        },
        onImageMove: (o, dMs) {
          setState(() {
            _selectedImage = o;
            final total = _totalMs;
            final len = o.endMs - o.startMs;
            final spans = [
              for (final x in _images)
                if (x.lane == o.lane && !identical(x, o)) [x.startMs, x.endMs]
            ];
            final ns = _clampNoOverlap(spans, o.startMs + dMs, o.startMs, o.endMs, len, total);
            o.startMs = ns;
            o.endMs = ns + len;
          });
        },
        onImageTrim: (o, {startDeltaMs, endDeltaMs}) {
          setState(() {
            _selectedImage = o;
            if (startDeltaMs != null) {
              o.startMs = (o.startMs + startDeltaMs).clamp(0, o.endMs - 200);
            }
            if (endDeltaMs != null) {
              final max = _totalMs > 0 ? _totalMs : o.endMs + endDeltaMs;
              o.endMs = (o.endMs + endDeltaMs).clamp(o.startMs + 200, max);
            }
          });
        },
        onImageEditEnd: () => _scheduleSave(),
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
