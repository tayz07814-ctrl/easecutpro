import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

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
import '../editor/preview_proxy.dart';
import '../native/exporter.dart';
import '../native/player.dart';
import '../native/vad.dart';
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
import '../editor/variations.dart';
import '../sheets/variations_sheet.dart';
import '../sheets/cut_review_sheet.dart';
import '../local/fonts_store.dart';

/// The EaseCut mobile editor. Everything (preview, export, split/trim/delete, and —
/// next — Cut Lord) runs off a single [TimelineModel] of base-video clips fed to the
/// native ExoPlayer (preview) and Media3 Transformer (export).
class EditorScreen extends StatefulWidget {
  /// When opened from New Project, the clip picked in the wizard so the editor
  /// auto-loads it (no need to import again).
  final String? initialClipPath;
  final String? initialClipName;
  final String? projectId; // when set, edits autosave to this Supabase project
  // "Enhance on import" (set from the dashboard / batch queue): after the initial
  // clip loads, auto-apply the silence/bad-take cuts, auto-generate captions
  // and/or punch in on the moments Auto Zoom picks.
  final bool enhanceCutSilence;
  final bool enhanceCaptions;
  final bool enhanceAutoZoom;
  const EditorScreen({
    super.key,
    this.initialClipPath,
    this.initialClipName,
    this.projectId,
    this.enhanceCutSilence = false,
    this.enhanceCaptions = false,
    this.enhanceAutoZoom = false,
  });

  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  final NativePlayer _player = NativePlayer();
  final NativeExporter _exporter = NativeExporter();
  final TimelineModel _model = TimelineModel();
  // Renders + caches a flat "flatten-and-play" proxy of the current cuts for smooth
  // preview across boundaries; swapped in for the live player when it's ready.
  late final PreviewProxy _previewProxy = PreviewProxy(_exporter);
  StreamSubscription<PlayerState>? _stateSub;
  StreamSubscription<dynamic>? _sizeSub;

  String? _clipName;
  int? _textureId;
  double _aspect = 9 / 16;
  // Preview proxy: the flat pre-rendered file swapped in for smooth cross-cut playback.
  String? _proxyPath;
  bool _proxyActive = false;

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
  // Per-source timeline art (filmstrip + waveform + duration), keyed by the media's
  // absolute path. EVERY video source on the timeline and EVERY imported audio
  // track gets its own entry, so appended clips and music/voiceover tracks draw
  // their own frames and waveform instead of falling back to a flat block.
  final Map<String, MediaPeaks> _media = {};
  final Set<String> _mediaPending = {}; // in-flight loads, so we probe each source once
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
    _previewProxy.addListener(_onProxyReady);
    // Register any user-added fonts before preview/export need them.
    EcFonts.instance.ensureLoaded().then((_) {
      if (mounted) setState(() {});
    });
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
    _previewProxy.removeListener(_onProxyReady);
    _previewProxy.dispose();
    _stateSub?.cancel();
    _sizeSub?.cancel();
    _player.release();
    _player.dispose();
    super.dispose();
  }

  void _onModel() {
    if (mounted) setState(() {});
    _scheduleSave();
    // Any structural change to the cuts (split/delete/trim/speed/volume/crop/zoom/
    // reorder/cuts/undo/redo/append) flows through here — (re)render the proxy for it.
    _maybeUpdateProxy();
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
        // Stickers / PiP / Auto B-roll — base64 pixels, so they survive a reload.
        'images': _images.map((o) => o.toJson()).toList(),
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
    _previewProxy.reset(); // fresh project — drop any cached proxies
    _proxyActive = false;
    _proxyPath = null;
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
    _images.clear();
    _selectedImage = null;
    for (final o in (m['images'] as List?) ?? []) {
      try {
        _images.add(ImageOverlay.fromJson(o as Map));
      } catch (_) {} // a corrupt/oversized overlay must not sink the whole project
    }
    _textureId ??= await _player.create();
    _stateSub ??= _player.states.listen(_onState);
    _sizeSub ??= _player.sizes.listen((_) {
      if (mounted) setState(() => _aspect = _player.aspectRatio);
    });
    await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
    // Art for the base AND every appended clip / audio track in the restored doc.
    _ensureMedia(src, knownDurMs: _sourceDurationMs);
    _ensureAllMedia();
    if (mounted) setState(() {});
  }

  bool get _hasBase => _model.hasBase && _textureId != null;
  int get _totalMs => _model.totalMs > 0 ? _model.totalMs : _sourceDurationMs;

  /// Cache key for a media source — always the bare path, so 'file://…' and plain
  /// paths (clips store one, audio tracks the other) land on the same entry.
  static String _mediaKey(String p) => p.startsWith('file://') ? p.substring(7) : p;

  /// Load this source's filmstrip + waveform ONCE, so the timeline can draw it.
  /// Cheap to call on every import/restore: sources already loaded or in flight are
  /// skipped, and each piece lands independently so a failed decode never blocks
  /// the rest. [video] false skips the filmstrip (audio tracks have no frames).
  Future<void> _ensureMedia(String path, {bool video = true, int knownDurMs = 0}) async {
    if (path.isEmpty) return;
    final key = _mediaKey(path);
    if (_media.containsKey(key) || _mediaPending.contains(key)) return;
    _mediaPending.add(key);
    final uri = 'file://$key';
    var dur = knownDurMs;
    if (dur <= 0) dur = await _exporter.duration(uri);
    if (!mounted) return;
    // Seed the entry first: the peaks are sliced against this duration, and it also
    // claims the key so a second caller can't start the same probe.
    setState(() => _media[key] = MediaPeaks(durMs: dur));
    _mediaPending.remove(key);
    _exporter.waveform(uri, buckets: 600).then((w) {
      if (!mounted || w.isEmpty) return;
      setState(() => _media[key] = (_media[key] ?? const MediaPeaks()).copyWith(peaks: w));
    });
    if (video) {
      _exporter.thumbnails(uri, 40).then((t) {
        if (!mounted || t.isEmpty) return;
        setState(() => _media[key] = (_media[key] ?? const MediaPeaks()).copyWith(thumbs: t));
      });
    }
  }

  /// Make sure every source currently on the timeline (base clips + audio tracks)
  /// has its art loaded — used after a restore, an append or an audio import.
  void _ensureAllMedia() {
    for (final c in _model.clips) {
      _ensureMedia(c.sourcePath);
    }
    for (final a in _audios) {
      _ensureMedia(a.uri, video: false, knownDurMs: a.durMs);
    }
  }

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
    _ensureMedia(path, knownDurMs: durMs); // its own filmstrip + waveform
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
        _media.clear();
        _mediaPending.clear();
        _proxyActive = false;
        _proxyPath = null;
      });
      _previewProxy.reset(); // fresh project — drop any cached proxies
      _textureId ??= await _player.create();
      _stateSub ??= _player.states.listen(_onState);
      _sizeSub ??= _player.sizes.listen((_) {
        if (mounted) setState(() => _aspect = _player.aspectRatio);
      });
      _model.setBase(path, 0); // duration filled in when the player reports it
      await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
      if (mounted) setState(() {});
      _ensureMedia(path); // filmstrip + waveform (async, non-blocking)
      _scheduleSave();
    } catch (e) {
      _toast('Import failed: $e');
    }
  }

  /// Rebuild the native playlist from the model after an edit, and land the
  /// playhead at [seekTo] (clamped). Delegates source selection to [_loadSource].
  Future<void> _reload({int? seekTo}) async {
    if (!_model.hasBase) return;
    await _loadSource(seekTo: seekTo);
  }

  /// Load the native player from the best source: the flat preview proxy when it is
  /// rendered, [PreviewProxy.matches] the current cuts, and the timeline actually has
  /// cuts ([_proxyWorthwhile]); otherwise the live segment list (the original
  /// behaviour). Extra audio (music/voiceover) is always mixed live on top. Position
  /// is preserved; when [resumePlaying] the player continues after the seek (used by
  /// the mid-play hot-swap so playback isn't interrupted).
  Future<void> _loadSource({int? seekTo, bool resumePlaying = false}) async {
    if (!_model.hasBase) return;
    final proxyReady = _proxyWorthwhile() &&
        _previewProxy.path != null &&
        _previewProxy.matches(_proxySegments());
    if (proxyReady) {
      final path = _previewProxy.path!;
      final dur = _previewProxy.durationMs ?? _totalMs;
      _proxyActive = true;
      _proxyPath = path;
      await _player.load([
        PlayerSegment(
          uri: 'file://$path',
          startMs: 0,
          endMs: dur,
          timelineStartMs: 0,
          timelineEndMs: dur,
          speed: 1.0,
          volume: 1.0,
        ),
      ], audioTracks: _audioTrackMaps());
    } else {
      _proxyActive = false;
      _proxyPath = null;
      await _player.load(_model.playerSegments(), audioTracks: _audioTrackMaps());
    }
    final pos = (seekTo ?? _positionMs).clamp(0, _totalMs);
    await _player.seek(pos);
    if (resumePlaying) await _player.play();
    if (mounted) setState(() => _positionMs = pos);
  }

  /// The current cut list as native-export-shaped maps (uri + trim + speed + volume +
  /// crop per clip) — the exact input the native proxy render and the manager's hash
  /// consume, so crop/speed/volume are baked into the proxy (unlike playerSegments()).
  List<Map<String, dynamic>> _proxySegments() =>
      [for (final s in _model.exportSegments()) s.toMap()];

  /// A flat proxy only helps once the timeline has real cut boundaries: more than one
  /// clip, or a single clip trimmed off its source. A full, untrimmed clip already
  /// previews smoothly on the live player, so we skip the proxy for it.
  bool _proxyWorthwhile() {
    // Disabled: the native preview now plays the cut list through Media3
    // CompositionPlayer, which steps over removed ranges in one continuous decode
    // (seamless across seams, no proxy render / pre-warm). The flatten proxy is kept
    // in the tree but no longer used for playback, so crop + the Ken Burns pan render
    // live via `_cropped` and the player always receives the real cut segments.
    return false;
    // ignore: dead_code
    final clips = _model.clips;
    if (clips.length > 1) return true;
    if (clips.length == 1) {
      final c = clips.first;
      return c.inMs > 0 || (_sourceDurationMs > 0 && c.outMs < _sourceDurationMs);
    }
    return false;
  }

  /// Ask the manager to (re)render a proxy for the current cuts (debounced inside it).
  /// No-op when a proxy wouldn't help — playback then just stays on the live player.
  void _maybeUpdateProxy() {
    if (!_model.hasBase || !_proxyWorthwhile()) return;
    _previewProxy.update(_proxySegments(), aspect: _aspect);
  }

  /// The manager produced (or promoted from cache) a proxy. Deferred to a microtask so
  /// it never re-enters a running edit/reload; the swap preserves position + play.
  void _onProxyReady() {
    if (!mounted) return;
    scheduleMicrotask(_swapToProxyIfReady);
  }

  /// Hot-swap the player onto the ready proxy when it still matches what's on screen
  /// and cuts exist. Skips if already on that proxy or the user is scrubbing.
  void _swapToProxyIfReady() {
    if (!mounted || !_model.hasBase || _scrubbing) return;
    if (!_proxyWorthwhile() || !_previewProxy.matches(_proxySegments())) return;
    if (_proxyActive && _proxyPath == _previewProxy.path) return; // already on it
    _loadSource(seekTo: _positionMs, resumePlaying: _playing);
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

  // ---- undo / redo (snapshots of clips + text/image overlays + audio) ----
  _EditSnap _snap() => _EditSnap(
        _model.clips.map((c) => c.copy()).toList(),
        _texts.map((t) => t.copy()).toList(),
        _audios.map((a) => a.copy()).toList(),
        _images.map((o) => o.copy()).toList(),
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
    _images
      ..clear()
      ..addAll(s.images.map((o) => o.copy()));
    _selectedText = null;
    _selectedImage = null;
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

  /// Hold-drag an overlay ANYWHERE on the time axis. The new start is bounded only
  /// by the timeline itself; when it lands on top of a neighbour the block HOPS to
  /// the lowest lane with room instead of stopping flush against it — so a block
  /// can be dragged clean past its neighbours. [laneSpans] are `[start, end, lane]`
  /// for the same track EXCLUDING the block being moved.
  ({int start, int lane}) _freeMove(
      List<List<int>> laneSpans, int proposedStart, int len, int curLane, int total) {
    final maxStart = (total - len) < 0 ? 0 : (total - len);
    final start = proposedStart.clamp(0, maxStart);
    final end = start + len;
    // Stay put when the current lane is still clear — a drag shouldn't reshuffle
    // lanes for no reason.
    for (final s in laneSpans) {
      if (s[2] == curLane && start < s[1] && end > s[0]) {
        return (start: start, lane: _freeLane(laneSpans, start, end));
      }
    }
    return (start: start, lane: curLane);
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
    final c = _model.clips[i];
    _openSheet(CropSheet(
      sourceAspect: _aspect,
      frame: _cropFrame(i),
      initL: c.cropL,
      initT: c.cropT,
      initR: c.cropR,
      initB: c.cropB,
      onChange: (l, t, r, b) {
        _model.setCrop(i, l: l, t: t, r: r, b: b); // preview crop is Dart-side (no reload)
        setState(() {});
      },
    ));
  }

  /// A representative JPEG for the crop box: the filmstrip frame nearest the current
  /// source position within clip [i] (falls back to null → the sheet shows a
  /// placeholder box, still fully usable).
  Uint8List? _cropFrame(int i) {
    if (i < 0 || i >= _model.clips.length) return null;
    final c = _model.clips[i];
    // That clip's OWN filmstrip — an appended source has its own frames.
    final thumbs = _media[_mediaKey(c.sourcePath)]?.thumbs ?? const <ThumbFrame>[];
    if (thumbs.isEmpty) return null;
    final sp = c.speed <= 0 ? 1.0 : c.speed;
    final within = (_positionMs - _model.clipStartMs(i)).clamp(0, c.timelineLenMs);
    final srcMs = c.inMs + (within * sp).round();
    ThumbFrame? best;
    int bestD = 1 << 30;
    for (final t in thumbs) {
      final d = (t.ms - srcMs).abs();
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best?.jpeg;
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
      _ensureMedia(path, video: false, knownDurMs: _sourceDurationMs); // its waveform
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
        onVariations: _openVariations,
      ));

  // ---- Variations: recut the same footage into a different edit ----
  void _openVariations() => _openSheet(VariationsSheet(
        onGenerate: (count) async {
          if (!_hasBase || _model.sourcePath == null) {
            return const VariationParse([], warnings: ['Import a clip first.']);
          }
          _transcript ??= await extractAndTranscribe(_exporter, _model.sourcePath!);
          return generateVariations(_transcript!, _sourceDurationMs / 1000.0, count);
        },
        onParse: (text, name) =>
            parseVariation(text, _sourceDurationMs / 1000.0, fallbackName: name),
        onApply: _applyVariation,
      ));

  /// Rebuild the base track from a variation's source ranges — IN ORDER, keeping
  /// repeats and overlaps, since the order IS the edit.
  Future<void> _applyVariation(Variation v) async {
    if (!_hasBase || _model.sourcePath == null) return;
    final ranges = v.rangesMs();
    if (ranges.isEmpty) return;
    _pushHistory();
    _texts.removeWhere((t) => t.isCaption); // caption times are stale after a recut
    _model.applyKeepRanges(ranges);
    await _reload(seekTo: 0);
    _toast('Applied “${v.name ?? 'variation'}” — ${ranges.length} clips');
  }

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
      // Ken Burns pan directions (dx, dy) in normalized frame units — the window
      // centre glides from -dir to +dir while it slowly pushes in. Mostly horizontal
      // so the motion reads clearly; cycled so consecutive moments feel different.
      const dirs = <List<double>>[
        [1.0, 0.0], // pan right
        [-1.0, 0.0], // pan left
        [0.6, 0.5], // drift up-right
        [-0.6, 0.5], // drift up-left
        [0.0, 0.0], // straight push-in
        [0.6, -0.5], // drift down-right
      ];
      var n = 0;
      for (final p in picks) {
        if (applied.length >= budget) break;
        if (p.i < 0 || p.i >= eligible.length) continue;
        if (applied.contains(p.i) || applied.contains(p.i - 1) || applied.contains(p.i + 1)) continue;
        applied.add(p.i);
        final clipIdx = eligible[p.i]['clipIdx'] as int;
        final level = p.level.clamp(1.08, 1.2).toDouble(); // start zoom
        final endScale = (level * 1.06).clamp(1.0, 1.4).toDouble(); // slow push-in
        // how far the window centre can drift at the start zoom without leaving frame
        final drift = ((1.0 - 1.0 / level) / 2.0).clamp(0.0, 0.45).toDouble() * 0.75;
        final d = dirs[n % dirs.length];
        _model.setKenBurns(
          clipIdx,
          fromScale: level,
          toScale: endScale,
          fromCx: 0.5 - d[0] * drift,
          fromCy: 0.5 - d[1] * drift,
          toCx: 0.5 + d[0] * drift,
          toCy: 0.5 + d[1] * drift,
        );
        n++;
      }
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
      await _reload(seekTo: 0);
      _maybeUpdateProxy(); // re-bake the flat proxy so the pan previews smoothly
      _toast(n > 0 ? 'Added a moving zoom to $n moment${n == 1 ? '' : 's'}.' : 'No zooms added.');
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
  void _openCaptions() => _openSheet(CaptionsSheet(onGenerate: (style) => _generateCaptions(style)));

  // ---- Cut Lord: transcribe → SHOW transcript → judge in background → apply ----
  Future<void> _runCutLord(CutLordModel model, bool cutSilence) async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    // Transcribe, then find cuts — BOTH under one progress overlay. The transcript
    // review opens only AFTER the judge finishes, so it shows the proposed cuts (not a
    // raw dump straight off AssemblyAI).
    final prog = ValueNotifier<String>('Starting…');
    _showProgress(prog);
    List<List<int>> aiCuts = const [];
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
      if (_transcript!.isEmpty) {
        if (mounted) Navigator.of(context).pop();
        prog.dispose();
        _toast('Couldn’t hear any speech to cut.');
        return;
      }
      // Find cuts (blocking). Hard timeout so a slow/blocked model can't trap us; on
      // failure the review still opens for manual cutting.
      prog.value = 'Finding cuts…';
      try {
        final res = await judge(
          _transcript!,
          model,
          _sourceDurationMs / 1000.0,
          cutSilence: cutSilence,
          minPauseS: SilenceSettings.trimS,
          padS: SilenceSettings.keepS,
        ).timeout(const Duration(seconds: 130));
        aiCuts = res.wordCuts;
      } catch (_) {
        // slow / blocked / nothing found — fall through to a manual review
      }
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
      _toast('Transcription failed: ${_cleanErr(e)}');
      return;
    }
    if (mounted) Navigator.of(context).pop();
    prog.dispose();
    if (!mounted) return;

    // Review the found cuts. The transcript renders grouped into sentences (see sheet).
    final words = _transcript!;
    final aiCutsN = ValueNotifier<List<List<int>>>(aiCuts);
    final judgingN = ValueNotifier<bool>(false);
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => CutReviewSheet(
        words: words,
        aiCuts: aiCutsN,
        judging: judgingN,
        modelLabel: model.label,
        onExecute: (finalCuts) {
          Navigator.of(context).pop(); // close review sheet
          _applyCuts(finalCuts, cutSilence, model.label);
        },
      ),
    );
    aiCutsN.dispose();
    judgingN.dispose();
  }

  /// Compute keep-ranges from (reviewed) word cuts + silence, snapshot for undo,
  /// then apply to the timeline.
  Future<void> _applyCuts(List<List<int>> wordCuts, bool cutSilence, String label) async {
    if (_transcript == null) return;
    final durS = _sourceDurationMs / 1000.0;

    // Silence = the FSMN (FunASR) VAD run on-device via native ONNX — the desktop
    // Retake Final Boss silence engine. Falls back to transcript word-gap silence
    // only if the native VAD is unavailable or finds nothing.
    List<List<int>> fsmn = const [];
    if (cutSilence && _model.sourcePath != null) {
      final prog = ValueNotifier<String>('Cleaning silence…');
      _showProgress(prog);
      try {
        final regions = await NativeVad.detectSilences(
          'file://${_model.sourcePath!}',
          padBeforeS: SilenceSettings.padBeforeS,
          padAfterS: SilenceSettings.padAfterS,
          trimEdgesS: SilenceSettings.edgeTrimS,
          tailTrim: SilenceSettings.removeBreaths,
        ).timeout(const Duration(seconds: 90), onTimeout: () => const []);
        fsmn = [for (final r in regions) [(r[0] * 1000).round(), (r[1] * 1000).round()]];
      } catch (_) {
        fsmn = const [];
      } finally {
        if (mounted) Navigator.of(context).pop();
        prog.dispose();
      }
    }

    final keeps = keepRanges(
      _transcript!,
      wordCuts,
      durS,
      cutSilence: cutSilence && fsmn.isEmpty, // word-gap only as the VAD fallback
      minPauseS: SilenceSettings.minGapS,
      padS: SilenceSettings.padAfterS,
      airAfterS: SilenceSettings.padAfterS,
      leadBeforeS: SilenceSettings.padBeforeS,
      extraSilenceMs: fsmn,
    );
    _pushHistory();
    _texts.removeWhere((t) => t.isCaption); // stale after a re-cut
    _model.applyKeepRanges(keeps);
    await _reload(seekTo: 0);
    // No snackbar — the top-bar / transport undo buttons are the undo affordance.
  }

  /// "Enhance on import": after the initial clip loads, optionally auto-apply the
  /// silence/bad-take cuts, punch in with Auto Zoom and/or auto-generate captions —
  /// no review sheet, mirroring the web "Enhance & open editor" flow. Runs cuts
  /// first (so the zoom + captions land on the cut timeline), reusing the cached
  /// transcript so it never transcribes twice.
  Future<void> _autoEnhanceOnImport() async {
    if (!mounted || !(widget.enhanceCutSilence || widget.enhanceCaptions || widget.enhanceAutoZoom)) {
      return;
    }
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
    // Zoom before captions: Auto Zoom splits the base at sentence groups, and the
    // caption placement maps SOURCE→edited times, which splitting never changes.
    if (widget.enhanceAutoZoom) {
      await _autoZoom();
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

  /// Generate caption overlays from the transcript in the chosen [style]:
  ///   'clean'/'boxed' — grouped subtitle lines (boxed adds a black bar).
  ///   'word'          — one word on screen at a time.
  ///   'karaoke'       — the full line, with the currently-spoken word lit and
  ///                     advancing word-by-word.
  Future<void> _generateCaptions([String style = 'clean']) async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    final prog = ValueNotifier<String>('Starting…');
    _showProgress(prog);
    try {
      _transcript ??=
          await extractAndTranscribe(_exporter, _model.sourcePath!, onProgress: (p, m) => prog.value = m);
      final words = _transcript!;
      _pushHistory();
      _texts.removeWhere((t) => t.isCaption);
      final boxed = style == 'boxed';

      // Map a source [startS,endS] (seconds) window to an edited [start,end] (ms)
      // pair, skipping (null) anything whose start falls inside a removed region.
      List<int>? edited(double startS, double endS, int minLen) {
        final s = _model.sourceToEdited((startS * 1000).round());
        if (s == null) return null;
        final e0 = _model.sourceToEdited((endS * 1000).round()) ?? (s + minLen);
        final e = e0 <= s ? (s + minLen) : (e0 > _totalMs ? _totalMs : e0);
        return [s, e];
      }

      void addCap(String text, int s, int e,
          {List<String>? lineWords, int? highlightWord, double fs = 0.05}) {
        final lane = _freeLane(_textLaneSpans(true), s, e);
        _texts.add(TextOverlay(
          text: text,
          y: 0.85,
          fontSize: fs,
          bold: true,
          bg: boxed,
          startMs: s,
          endMs: e,
          isCaption: true,
          lane: lane,
          lineWords: lineWords,
          highlightWord: highlightWord,
        ));
      }

      if (style == 'word') {
        // One overlay per word — exactly one word visible at a time.
        for (final w in words) {
          final r = edited(w.start, w.end, 300);
          if (r == null) continue;
          addCap(w.text.trim(), r[0], r[1], fs: 0.06);
        }
      } else if (style == 'karaoke') {
        // Per line, one overlay PER WORD showing the whole line with that word
        // highlighted, timed [thisWord.start, nextWord.start) so the highlight
        // advances across the otherwise-static line.
        for (final l in groupCaptions(words)) {
          final lw = l.words;
          if (lw.isEmpty) continue;
          final tokens = [for (final w in lw) w.text.trim()];
          for (int wi = 0; wi < lw.length; wi++) {
            final endS = wi < lw.length - 1 ? lw[wi + 1].start : lw[wi].end;
            final r = edited(lw[wi].start, endS, 200);
            if (r == null) continue;
            addCap(l.text, r[0], r[1], lineWords: tokens, highlightWord: wi);
          }
        }
      } else {
        // 'clean' / 'boxed' — grouped subtitle lines.
        for (final l in groupCaptions(words)) {
          final r = edited(l.startS, l.endS, 500);
          if (r == null) continue;
          addCap(l.text, r[0], r[1]);
        }
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
          _ensureMedia(path, video: false, knownDurMs: dur); // waveform for its block
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
    // The flat proxy already has each clip's crop / Ken Burns pan baked in —
    // re-framing here would double it, so pass the texture straight through while
    // the proxy is active.
    if (_proxyActive) return child;
    final idx = _model.clipIndexAt(_positionMs);
    if (idx < 0 || idx >= _model.clips.length) return child;
    final c = _model.clips[idx];
    double vw, vh, ax, ay;
    if (c.kb) {
      // Ken Burns: interpolate scale + window centre by the playhead's position in
      // this clip (the 60 fps interpolation tick re-renders us, so the pan glides).
      final start = _model.clipStartMs(idx);
      final len = c.timelineLenMs > 0 ? c.timelineLenMs : 1;
      final f = ((_positionMs - start) / len).clamp(0.0, 1.0);
      final scale = (c.kbFromScale + (c.kbToScale - c.kbFromScale) * f).clamp(1.0, 4.0).toDouble();
      final vis = (1.0 / scale);
      final half = vis / 2.0;
      final cx = (c.kbFromCx + (c.kbToCx - c.kbFromCx) * f).clamp(half, 1.0 - half).toDouble();
      final cy = (c.kbFromCy + (c.kbToCy - c.kbFromCy) * f).clamp(half, 1.0 - half).toDouble();
      vw = vis.clamp(0.05, 1.0).toDouble();
      vh = vw;
      ax = (1 - vw) > 1e-6 ? (2 * (cx - vw / 2) / (1 - vw) - 1).clamp(-1.0, 1.0).toDouble() : 0.0;
      ay = (1 - vh) > 1e-6 ? (2 * (cy - vh / 2) / (1 - vh) - 1).clamp(-1.0, 1.0).toDouble() : 0.0;
    } else if (c.hasCrop) {
      vw = (1 - c.cropL - c.cropR).clamp(0.05, 1.0).toDouble();
      vh = (1 - c.cropT - c.cropB).clamp(0.05, 1.0).toDouble();
      ax = (c.cropL + c.cropR) > 0 ? (c.cropL - c.cropR) / (c.cropL + c.cropR) : 0.0;
      ay = (c.cropT + c.cropB) > 0 ? (c.cropT - c.cropB) / (c.cropT + c.cropB) : 0.0;
    } else {
      return child;
    }
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
          // Deselect: clears the selection (and thus the purple outline + this bar).
          btn(Icons.close, 'Done', () => setState(() => _selectedText = null)),
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

  /// Small themed chip shown over the preview while a proxy render is in flight.
  Widget _proxyChip() => Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: Ec.sheet.withValues(alpha: 0.9),
          borderRadius: BorderRadius.circular(20),
          border: Border.all(color: Ec.hair2),
        ),
        child: const Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 11,
              height: 11,
              child: CircularProgressIndicator(strokeWidth: 1.6, color: Ec.indigo),
            ),
            SizedBox(width: 7),
            Text('Updating preview…',
                style: TextStyle(color: Ec.text, fontSize: 11, fontWeight: FontWeight.w600)),
          ],
        ),
      );

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
                              onDeselect: () => setState(() => _selectedImage = null),
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
                              onSelect: () => setState(() {
                                _selectedText = t;
                                _selectedImage = null;
                              }),
                              onDeselect: () => setState(() => _selectedText = null),
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
                        // "Updating preview…" while the flat proxy is (re)rendering.
                        Positioned(
                          top: 8,
                          left: 0,
                          right: 0,
                          child: IgnorePointer(
                            child: Center(
                              child: ValueListenableBuilder<bool>(
                                valueListenable: _previewProxy.rendering,
                                builder: (_, r, _) =>
                                    r ? _proxyChip() : const SizedBox.shrink(),
                              ),
                            ),
                          ),
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
        media: _media,
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
            final len = t.endMs - t.startMs;
            // Same-track neighbours (excluding this block), with their lanes.
            final spans = [
              for (final o in _texts)
                if (o.isCaption == t.isCaption && !identical(o, t)) [o.startMs, o.endMs, o.lane]
            ];
            final p = _freeMove(spans, t.startMs + dMs, len, t.lane, _totalMs);
            t.startMs = p.start;
            t.endMs = p.start + len;
            t.lane = p.lane;
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
            final len = o.endMs - o.startMs;
            final spans = [
              for (final x in _images)
                if (!identical(x, o)) [x.startMs, x.endMs, x.lane]
            ];
            final p = _freeMove(spans, o.startMs + dMs, len, o.lane, _totalMs);
            o.startMs = p.start;
            o.endMs = p.start + len;
            o.lane = p.lane;
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

/// An immutable snapshot of the editable state (clips + text/image overlays +
/// audio tracks) for undo/redo.
class _EditSnap {
  final List<EcClip> clips;
  final List<TextOverlay> texts;
  final List<AudioTrack> audios;
  final List<ImageOverlay> images;
  _EditSnap(this.clips, this.texts, this.audios, this.images);
}
