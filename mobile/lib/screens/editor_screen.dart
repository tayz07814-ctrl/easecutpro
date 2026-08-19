import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../cloud/backend.dart';
import '../cloud/stt.dart' show Word, Progress, SttOutcome;
import '../editor/timeline_model.dart';
import '../editor/text_overlay.dart';
import '../editor/background_mask.dart';
import '../editor/audio_track.dart';
import '../editor/cutcutpro.dart';
import '../editor/cutlord.dart';
import '../editor/silence_settings.dart';
import '../editor/transcript_silence.dart';
import '../local/app_settings.dart';
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
import '../sheets/ease_tools_sheet.dart';
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
import '../sheets/cutout_sheet.dart';
import '../local/fonts_store.dart';

/// The EaseCut mobile editor. Everything (preview, export, split/trim/delete, and —
/// next — EaseTools) runs off a single [TimelineModel] of base-video clips fed to the
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
  String? _preparedAudioPath;
  int? _textureId;
  double _aspect = 9 / 16;
  // Preview proxy: the flat pre-rendered file swapped in for smooth cross-cut playback.
  String? _proxyPath;
  bool _proxyActive = false;

  int _positionMs = 0;
  int _sourceDurationMs = 0;
  bool _playing = false;
  bool _scrubbing = false;
  bool _loop = false; // transport loop toggle — replay from 0 when playback ends
  bool _previewExpanded = false; // fullscreen-preview mode (hides timeline + dock)
  bool _preparing = false;
  double _preparingProgress = 0;
  String _preparingMessage = 'Preparing video for editing…';
  int _preparationGeneration = 0;

  double _stageFrac = 0.46;
  bool _selected = false;
  final List<TextOverlay> _texts = []; // text + caption overlays
  TextOverlay? _selectedText; // overlay being edited on the preview
  final List<ImageOverlay> _images = []; // image / sticker overlays (PiP)
  ImageOverlay? _selectedImage;
  final List<_EditSnap> _undoStack = [];
  final List<_EditSnap> _redoStack = [];

  // ---- staged cuts (review-before-apply) ----------------------------------
  // With "Apply cuts immediately" OFF, a tool stages its result instead of
  // committing: [_pendingKeeps] is what WOULD be kept, [_stagedCutsSrc] is what
  // would be removed (source ms) and gets painted on the timeline for review.
  List<List<int>>? _pendingKeeps;
  List<List<int>> _stagedCutsSrc = const [];
  String _stagedLabel = '';
  /// STT cache keyed by a source's bare path — the FULL transcript of that file
  /// in its OWN source time. Persisted with the project and never cleared by a
  /// cut, so re-running any EaseTool reuses it: already-transcribed audio is
  /// never uploaded (or billed) twice, and only a source we have not seen before
  /// — a newly appended clip — is sent to the API.
  final Map<String, List<Word>> _sttCache = {};

  /// The base source's transcript, if we already have it.
  List<Word>? get _transcript {
    final p = _model.sourcePath;
    return p == null ? null : _sttCache[_mediaKey(p)];
  }

  /// The base source's transcript, transcribing ONLY if it isn't cached yet.
  Future<List<Word>> _ensureTranscript({Progress? onProgress}) async {
    final path = _model.sourcePath;
    if (path == null) return const [];
    final key = _mediaKey(path);
    final cached = _sttCache[key];
    if (cached != null) {
      onProgress?.call(100, 'Using the saved transcript…');
      return cached;
    }
    final words = await extractAndTranscribe(_exporter, path,
        preparedAudioPath: _preparedAudioPath, onProgress: onProgress);
    // Say which provider actually ran — the setting is a preference, and a
    // silent fallback is exactly how "is Deepgram even working?" becomes
    // unanswerable.
    final note = SttOutcome.note;
    _toast(note != null
        ? 'Transcribed via ${SttOutcome.label} · $note'
        : 'Transcribed via ${SttOutcome.label} · ${words.length} words');
    _sttCache[key] = words;
    _scheduleSave(); // survive an app restart too
    return words;
  }
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
      _preparing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        await _importPath(widget.initialClipPath!, widget.initialClipName);
        await _autoEnhanceOnImport();
      });
    } else if (widget.projectId != null) {
      _preparing = true;
      WidgetsBinding.instance.addPostFrameCallback((_) => _loadProject());
    }
  }

  /// Keep the primary clip and overlay selections mutually exclusive. Timeline
  /// gestures call these same methods as preview gestures, so a selection cannot
  /// remain highlighted in a different track after tapping another item.
  void _clearSelection() {
    _model.select(-1);
    if (!mounted) return;
    setState(() {
      _selected = false;
      _selectedText = null;
      _selectedImage = null;
      _selectedAudio = -1;
    });
  }

  void _selectClip(int index) {
    _model.select(index);
    setState(() {
      _selected = index >= 0;
      _selectedText = null;
      _selectedImage = null;
      _selectedAudio = -1;
    });
  }

  void _selectText(TextOverlay text) {
    _model.select(-1);
    setState(() {
      _selected = false;
      _selectedText = text;
      _selectedImage = null;
      _selectedAudio = -1;
    });
  }

  void _selectImage(ImageOverlay image) {
    _model.select(-1);
    setState(() {
      _selected = false;
      _selectedText = null;
      _selectedImage = image;
      _selectedAudio = -1;
    });
  }

  void _selectAudio(int index) {
    _model.select(-1);
    setState(() {
      _selected = false;
      _selectedText = null;
      _selectedImage = null;
      _selectedAudio = index;
    });
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
        // Transcripts per source file, so reopening a project never re-transcribes
        // (and never re-bills) audio we have already sent once.
        'stt': {
          for (final e in _sttCache.entries) e.key: e.value.map((w) => w.toJson()).toList(),
        },
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
    String? thumb;
    try {
      thumb = _projectThumb();
    } catch (_) {}
    try {
      await Backend.saveProject(widget.projectId!, _projectDoc, thumb: thumb);
    } catch (_) {
      // best-effort; a later edit retries
    }
  }

  /// Small base64 JPEG from the filmstrip frame nearest the playhead, so the
  /// dashboard grid can preview the project. The filmstrip is already decoded;
  /// no extra native call is needed.
  String? _projectThumb() {
    if (!_model.hasBase) return null;
    final i = _model.clipIndexAt(_positionMs);
    if (i < 0) return null;
    final jpeg = _cropFrame(i);
    return jpeg == null ? null : base64Encode(jpeg);
  }

  Future<void> _loadProject() async {
    try {
      final doc = await Backend.loadProject(widget.projectId!);
      if (doc != null) _projectDoc = doc;
      final m = doc?['mobile'];
      if (m is Map) await _restoreFrom(Map<String, dynamic>.from(m));
    } catch (_) {
      if (mounted) setState(() => _preparing = false);
    }
  }

  Future<void> _restoreFrom(Map<String, dynamic> m) async {
    final src = m['sourcePath'] as String?;
    final clipsJson = (m['clips'] as List?) ?? [];
    if (src == null || clipsJson.isEmpty) {
      if (mounted) setState(() => _preparing = false);
      return;
    }
    if (!await File(src).exists()) {
      _toast('Media not found on this device — re-import to continue');
      if (mounted) setState(() => _preparing = false);
      return;
    }
    _previewProxy.reset(); // fresh project — drop any cached proxies
    _proxyActive = false;
    _proxyPath = null;
    _clipName = m['clipName'] as String?;
    _preparedAudioPath = null;
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
    _sttCache.clear();
    final stt = m['stt'];
    if (stt is Map) {
      stt.forEach((k, v) {
        if (v is List) {
          _sttCache['$k'] = [for (final w in v) Word.fromJson(w as Map)];
        }
      });
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
    // Prepare the base before revealing the editor; extra sources are warmed
    // after the first frame so a large restored montage does not block forever.
    await _prepareMedia(src, knownDurMs: _sourceDurationMs);
    _ensureAllMedia();
    if (mounted) setState(() => _preparing = false);
  }

  bool get _hasBase => _model.hasBase && _textureId != null;
  int get _totalMs => _model.totalMs > 0 ? _model.totalMs : _sourceDurationMs;

  /// Cache key for a media source — always the bare path, so 'file://…' and plain
  /// paths (clips store one, audio tracks the other) land on the same entry.
  static String _mediaKey(String p) => p.startsWith('file://') ? p.substring(7) : p;

  /// Load this source's filmstrip + waveform in the background after the editor is
  /// already usable. Initial base media uses [_prepareMedia] instead, which awaits
  /// all required assets before the editor is revealed.
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

  /// Prepare the base media before entering the usable editor state. The native
  /// calls are started together, but progress advances only as each real artifact
  /// completes. The audio path is retained so Cut Lord never extracts it again.
  Future<void> _prepareMedia(String path, {int knownDurMs = 0}) async {
    final generation = ++_preparationGeneration;
    final key = _mediaKey(path);
    final uri = 'file://$key';
    if (mounted) {
      setState(() {
        _preparing = true;
        _preparingProgress = 2;
        _preparingMessage = 'Preparing video for editing…';
      });
    }
    var completed = 0;
    const total = 4;
    void step(String message) {
      completed++;
      if (!mounted || generation != _preparationGeneration) return;
      setState(() {
        _preparingProgress = completed / total * 100;
        _preparingMessage = message;
      });
    }

    final durationFuture = knownDurMs > 0 ? Future<int>.value(knownDurMs) : _exporter.duration(uri);
    final waveformFuture = _exporter.waveform(uri, buckets: 600);
    final thumbnailsFuture = _exporter.thumbnails(uri, 60);
    final audioFuture = _exporter.extractAudio(uri);
    final duration = await durationFuture;
    if (!mounted || generation != _preparationGeneration) return;
    _sourceDurationMs = duration;
    _model.sourceDurationMs = duration;
    step('Reading video metadata…');

    final waveform = await waveformFuture;
    if (!mounted || generation != _preparationGeneration) return;
    setState(() => _media[key] = MediaPeaks(peaks: waveform, durMs: duration));
    step('Building waveform…');

    final thumbs = await thumbnailsFuture;
    if (!mounted || generation != _preparationGeneration) return;
    setState(() => _media[key] = (_media[key] ?? MediaPeaks(durMs: duration)).copyWith(thumbs: thumbs));
    step('Building filmstrip…');

    String? audio;
    try {
      audio = await audioFuture;
    } catch (_) {
      // The editor can still open with waveform/filmstrip; Cut Lord will retry
      // extraction and surface the actual transcription error later.
    }
    if (!mounted || generation != _preparationGeneration) return;
    _preparedAudioPath = audio;
    step(audio == null ? 'Audio preparation unavailable — continuing…' : 'Preparing audio for transcription…');
    setState(() {
      _preparingProgress = 100;
      _preparingMessage = 'Ready for editing';
      _preparing = false;
    });
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
        _preparing = true;
        _preparingProgress = 0;
        _preparingMessage = 'Preparing video for editing…';
        _clipName = name ?? path.split('/').last;
        _positionMs = 0;
        _sourceDurationMs = 0;
        _playing = false;
        _sttCache.clear(); // brand-new project — nothing transcribed yet
        _preparedAudioPath = null;
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
      await _prepareMedia(path);
      _scheduleSave();
    } catch (e) {
      if (mounted) setState(() => _preparing = false);
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
    // Loop: when playback runs off the end, jump back to 0 and keep going.
    if (s.ended && _loop && _hasBase) {
      _player.seek(0);
      _player.play();
    }
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
      case 'Cutout':
        _openMainCutout();
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
      case 'Adjust':
        _openAdjust();
        break;
      case 'Animation':
        _openAnimation();
        break;
    }
  }

  ImageOverlay? get _selectedVisual => _selectedImage;

  void _deleteSelectedOverlay() {
    final o = _selectedVisual;
    if (o == null) return;
    _pushHistory();
    setState(() {
      _images.remove(o);
      _selectedImage = null;
    });
    _scheduleSave();
  }

  void _splitSelectedOverlay() {
    final o = _selectedVisual;
    if (o == null || _positionMs <= o.startMs || _positionMs >= o.endMs) return;
    _pushHistory();
    final right = o.copy()
      ..startMs = _positionMs
      ..endMs = o.endMs;
    setState(() {
      o.endMs = _positionMs;
      _images.add(right);
      _selectedImage = right;
    });
    _scheduleSave();
  }

  Future<void> _openOverlaySpeed() async {
    final o = _selectedVisual;
    if (o == null || !o.isVideo) return;
    _pushHistory();
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => SpeedSheet(
        initial: o.speed,
        onChanged: (v) => setState(() => o.speed = v),
      ),
    );
    _scheduleSave();
  }

  Future<void> _openOverlayVolume() async {
    final o = _selectedVisual;
    if (o == null || !o.isVideo) return;
    _pushHistory();
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => VolumeSheet(
        initial: o.volume,
        onChanged: (v) => setState(() => o.volume = v),
      ),
    );
    _scheduleSave();
  }

  Future<void> _openOverlayCrop() async {
    final o = _selectedVisual;
    if (o == null) return;
    _pushHistory();
    final localMs = (_positionMs - o.startMs).clamp(0, o.endMs - o.startMs).toInt();
    final frame = o.isVideo
        ? await _exporter.frame('file://${o.videoPath}', (localMs * o.speed).round())
        : o.bytes;
    if (!mounted) return;
    _openSheet(CropSheet(
      sourceAspect: await _frameAspect(frame),
      frame: frame,
      initL: o.cropL,
      initT: o.cropT,
      initR: o.cropR,
      initB: o.cropB,
      onChange: (l, t, r, b) => setState(() {
        o.cropL = l;
        o.cropT = t;
        o.cropR = r;
        o.cropB = b;
      }),
    ));
  }

  Future<void> _openOverlayZoom() async {
    final o = _selectedVisual;
    if (o == null) return;
    _pushHistory();
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Ec.sheet,
      builder: (_) => StatefulBuilder(
        builder: (context, sheetSetState) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 16, 20, 24),
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              const Text('Overlay zoom', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text('${(o.scale * 100).round()}%', style: const TextStyle(color: Ec.textDim)),
              Slider(
                value: o.scale.clamp(0.05, 1.0).toDouble(),
                min: 0.05,
                max: 1.0,
                onChanged: (v) {
                  setState(() => o.scale = v);
                  sheetSetState(() {});
                },
              ),
              const Text('You can also pinch the overlay directly in the preview.',
                  style: TextStyle(color: Ec.textFaint, fontSize: 12)),
            ]),
          ),
        ),
      ),
    );
    _scheduleSave();
  }

  void _changeSelectedLayer(int delta, {bool edge = false}) {
    final selectedImage = _selectedImage;
    final selectedText = _selectedText;
    if (selectedImage == null && selectedText == null) return;
    final all = <int>[
      ..._images.map((o) => o.zIndex),
      ..._texts.map((t) => t.zIndex),
    ];
    final max = all.isEmpty ? 0 : all.reduce((a, b) => a > b ? a : b);
    final min = all.isEmpty ? 0 : all.reduce((a, b) => a < b ? a : b);
    setState(() {
      final next = edge ? (delta > 0 ? max + 1 : min - 1) : null;
      if (selectedImage != null) {
        selectedImage.zIndex = next ?? selectedImage.zIndex + delta;
      } else {
        selectedText!.zIndex = next ?? selectedText.zIndex + delta;
      }
    });
    _scheduleSave();
  }

  void _openLayers() {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: Ec.sheet,
      builder: (_) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 16),
          child: Wrap(
            runSpacing: 8,
            children: [
              const ListTile(leading: Icon(Icons.layers, color: Ec.indigoText), title: Text('Layers')),
              ListTile(leading: const Icon(Icons.vertical_align_top), title: const Text('Bring to Front'), onTap: () {
                Navigator.pop(context);
                _changeSelectedLayer(1, edge: true);
              }),
              ListTile(leading: const Icon(Icons.arrow_upward), title: const Text('Bring Forward'), onTap: () {
                Navigator.pop(context);
                _changeSelectedLayer(1);
              }),
              ListTile(leading: const Icon(Icons.arrow_downward), title: const Text('Send Backward'), onTap: () {
                Navigator.pop(context);
                _changeSelectedLayer(-1);
              }),
              ListTile(leading: const Icon(Icons.vertical_align_bottom), title: const Text('Send to Back'), onTap: () {
                Navigator.pop(context);
                _changeSelectedLayer(-1, edge: true);
              }),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _demotePrimaryClip(int index) async {
    if (_model.clips.length <= 1) {
      _toast('Keep one clip on the main track');
      return;
    }
    if (index < 0 || index >= _model.clips.length) return;
    _pushHistory();
    final start = _model.clipStartMs(index);
    final clip = _model.takePrimaryClip(index);
    if (clip == null) return;
    final overlay = ImageOverlay(
      videoPath: clip.sourcePath,
      startMs: start,
      endMs: start + clip.timelineLenMs,
      speed: clip.speed,
      volume: clip.volume,
      cropL: clip.cropL,
      cropT: clip.cropT,
      cropR: clip.cropR,
      cropB: clip.cropB,
      lane: 0,
    );
    setState(() {
      _images.add(overlay);
      _selectedImage = overlay;
      _selected = false;
    });
    await _loadSource(seekTo: _positionMs, resumePlaying: _playing);
  }

  Future<void> _promoteVideoOverlay(ImageOverlay overlay) async {
    if (!overlay.isVideo || overlay.videoPath == null) {
      _toast('Only video overlays can move to the main track');
      return;
    }
    _pushHistory();
    final sourceLen = ((overlay.endMs - overlay.startMs) * overlay.speed).round().clamp(100, 1 << 30).toInt();
    final insertAt = _model.clipIndexAt(overlay.startMs).clamp(0, _model.clips.length).toInt();
    _model.insertPrimaryClip(insertAt, EcClip(overlay.videoPath!, 0, sourceLen, mediaDurationMs: sourceLen,
        speed: overlay.speed, volume: overlay.volume));
    setState(() {
      _images.remove(overlay);
      _selectedImage = null;
      _selected = true;
    });
    await _loadSource(seekTo: _positionMs, resumePlaying: _playing);
  }

  Future<void> _openCutout() async {
    final o = _selectedVisual;
    if (o == null) return;
    _pushHistory();
    final sourceEnd = o.isVideo ? await _exporter.duration('file://${o.videoPath}') : 0;
    if (!mounted) return;
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => CutoutSheet(
        overlay: o,
        exporter: _exporter,
        sourceEndMs: sourceEnd,
        onApply: (mode, masks) {
          final speed = o.speed <= 0 ? 1.0 : o.speed;
          final timelineMasks = [
            for (final mask in masks)
              BackgroundMaskFrame((mask.timeMs / speed).round(), mask.path),
          ];
          setState(() {
            o.bgMode = mode;
            o.maskFrames = timelineMasks;
            o.maskPath = timelineMasks.length == 1 ? timelineMasks.first.path : null;
          });
          _scheduleSave();
        },
      ),
    );
  }

  Future<void> _openMainCutout() async {
    final i = _selectedIndex();
    if (i < 0 || i >= _model.clips.length) return;
    final clip = _model.clips[i];
    _pushHistory();
    final target = ImageOverlay(
      videoPath: clip.sourcePath,
      startMs: 0,
      endMs: clip.timelineLenMs,
      speed: clip.speed,
    );
    await showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => CutoutSheet(
        overlay: target,
        exporter: _exporter,
        sourceStartMs: clip.inMs,
        sourceEndMs: clip.outMs,
        onApply: (mode, masks) {
          final speed = clip.speed <= 0 ? 1.0 : clip.speed;
          final timelineMasks = [
            for (final mask in masks)
              BackgroundMaskFrame((mask.timeMs / speed).round(), mask.path),
          ];
          setState(() {
            clip.bgMode = mode;
            clip.maskFrames = timelineMasks;
            clip.maskPath = timelineMasks.length == 1 ? timelineMasks.first.path : null;
          });
          _scheduleSave();
          _loadSource(seekTo: _positionMs, resumePlaying: _playing);
        },
      ),
    );
  }

  void _onOverlayTool(String tool) {
    switch (tool) {
      case 'Split':
        _splitSelectedOverlay();
        break;
      case 'Crop':
        _openOverlayCrop();
        break;
      case 'Speed':
        _openOverlaySpeed();
        break;
      case 'Volume':
        _openOverlayVolume();
        break;
      case 'Layers':
        _openLayers();
        break;
      case 'Transform':
        _toast('Drag or pinch the selected overlay in the preview');
        break;
      case 'Cutout':
        _openMainCutout();
        break;
      case 'Zoom':
        _openOverlayZoom();
        break;
      case 'Adjust':
        _toast('Overlay adjustment controls are available from Transform');
        break;
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

  /// Overlay tool: pick an image or video and drop it on the visual overlay lane.
  /// Both media types use the same timed transform/layer model.
  Future<void> _addOverlay() async {
    final res = await FilePicker.pickFiles(
      type: FileType.custom,
      allowedExtensions: const ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'm4v', 'webm'],
      withData: true,
    );
    if (res == null || res.files.isEmpty) return;
    final file = res.files.first;
    final path = file.path;
    final ext = (file.extension ?? '').toLowerCase();
    final isVideo = {'mp4', 'mov', 'm4v', 'webm'}.contains(ext);
    if (isVideo && path == null) return;
    if (!isVideo && file.bytes == null) return;
    final sourceDuration = isVideo && path != null ? await _exporter.duration('file://$path') : 0;
    final end = (_positionMs + (sourceDuration > 0 ? sourceDuration : 4000))
        .clamp(0, _totalMs > 0 ? _totalMs : _positionMs + (sourceDuration > 0 ? sourceDuration : 4000));
    final o = ImageOverlay(
      bytes: isVideo ? null : file.bytes,
      videoPath: isVideo ? path : null,
      startMs: _positionMs,
      endMs: end.toInt(),
    );
    // Drop onto the lowest free lane at the playhead so it never lands on top of
    // an existing image (respecting each item's own duration).
    o.lane = _freeLane(_imageLaneSpans(), o.startMs, o.endMs);
    _pushHistory();
    setState(() {
      _images.add(o);
      _selectedImage = o;
      _selectedText = null;
      _selectedAudio = -1;
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

  Future<double> _frameAspect(Uint8List? bytes, [double fallback = 1]) async {
    if (bytes == null) return fallback;
    try {
      final decoded = Completer<ui.Image>();
      ui.decodeImageFromList(bytes, decoded.complete);
      final image = await decoded.future;
      final aspect = image.width / image.height;
      image.dispose();
      return aspect > 0 ? aspect : fallback;
    } catch (_) {
      return fallback;
    }
  }

  Future<void> _openCrop() async {
    final i = _selectedIndex();
    if (i < 0) return;
    _pushHistory();
    final c = _model.clips[i];
    final start = _model.clipStartMs(i);
    final sourceMs = c.inMs + ((
      (_positionMs - start).clamp(0, c.timelineLenMs) * (c.speed <= 0 ? 1 : c.speed)
    ).round());
    final frame = await _exporter.frame('file://${c.sourcePath}', sourceMs) ?? _cropFrame(i);
    if (!mounted) return;
    _openSheet(CropSheet(
      sourceAspect: await _frameAspect(frame, _aspect),
      frame: frame,
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

  /// Zoom is a MOVE (Ken Burns), not a punch: a start scale + focus glides to an
  /// end scale + focus across the clip. It drives the SAME kb fields Auto Zoom
  /// uses, which both the preview (`_cropped`) and the exporter already
  /// interpolate — so what you set is what renders.
  void _openZoom() {
    final i = _selectedIndex();
    if (i < 0) return;
    final c = _model.clips[i];
    // Seed from the existing move; a legacy static crop becomes its start+end
    // scale so an older project opens showing what it actually does.
    var fs = c.kb ? c.kbFromScale : 1.0;
    var ts = c.kb ? c.kbToScale : 1.0;
    if (!c.kb) {
      final sym = (c.cropL == c.cropR && c.cropT == c.cropB && c.cropL == c.cropT) ? c.cropL : 0.0;
      final z = (sym > 0 && sym < 0.49) ? 1.0 / (1.0 - 2 * sym) : 1.0;
      fs = z;
      ts = z;
    }
    _pushHistory();
    _openSheet(ZoomSheet(
      fromScale: fs,
      toScale: ts,
      fromCx: c.kb ? c.kbFromCx : 0.5,
      fromCy: c.kb ? c.kbFromCy : 0.5,
      toCx: c.kb ? c.kbToCx : 0.5,
      toCy: c.kb ? c.kbToCy : 0.5,
      onChanged: ({
        required double fromScale,
        required double toScale,
        required double fromCx,
        required double fromCy,
        required double toCx,
        required double toCy,
      }) {
        final none = fromScale <= 1.001 && toScale <= 1.001;
        setState(() {
          final clip = _model.clips[i];
          clip.kb = !none;
          clip.kbFromScale = fromScale;
          clip.kbToScale = toScale;
          clip.kbFromCx = fromCx;
          clip.kbFromCy = fromCy;
          clip.kbToCx = toCx;
          clip.kbToCy = toCy;
          // kb owns the framing — a leftover static crop would double up.
          if (!none) {
            clip.cropL = 0;
            clip.cropT = 0;
            clip.cropR = 0;
            clip.cropB = 0;
          }
        });
        _scheduleSave();
      },
    ));
  }

  void _openAdjust() {
    final i = _selectedIndex();
    if (i < 0) return;
    final c = _model.clips[i];
    _pushHistory();
    _openSheet(AdjustSheet(
      brightness: c.brightness,
      contrast: c.contrast,
      saturation: c.saturation,
      onChanged: ({required double brightness, required double contrast, required double saturation}) {
        setState(() {
          final clip = _model.clips[i];
          clip.brightness = brightness;
          clip.contrast = contrast;
          clip.saturation = saturation;
        });
        _scheduleSave();
      },
    ));
  }

  void _openAnimation() {
    final i = _selectedIndex();
    if (i < 0) return;
    final c = _model.clips[i];
    _pushHistory();
    _openSheet(AnimationSheet(
      fadeInMs: c.fadeInMs,
      fadeOutMs: c.fadeOutMs,
      maxMs: c.timelineLenMs,
      onChanged: ({required int fadeInMs, required int fadeOutMs}) {
        setState(() {
          final clip = _model.clips[i];
          clip.fadeInMs = fadeInMs;
          clip.fadeOutMs = fadeOutMs;
        });
        _scheduleSave();
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

  /// Every status message in the editor funnels through here, so the
  /// "Show status messages" setting silences the whole app in one place
  /// instead of the messages being deleted and the diagnostics lost.
  void _toast(String msg) {
    if (!mounted || !AppSettings.showStatusMessages) return;
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

  void _openEaseTools() => _openSheet(EaseToolsSheet(
        onOpenSilence: () {
          Navigator.of(context).pop();
          _openSilence();
        },
        onRun: _runCutLord,
        onCleanSilence: _cleanSilenceOnly,
        onZoom: _autoZoom,
        onOverlays: _autoBroll,
        onVariations: _openVariations,
       ));

  Future<List<Word>> _transcribePrepared({Progress? onProgress}) async {
    final source = _model.sourcePath;
    if (source == null || source.isEmpty) throw Exception('Import a clip first');
    return extractAndTranscribe(
      _exporter,
      source,
      preparedAudioPath: _preparedAudioPath,
      onProgress: onProgress,
    );
  }

  /// Silence-only quick action: run JUST the Silero engine on the source and
  /// apply its cuts — no transcription, no judge, no review. The fastest way to
  /// test (and debug) the silence cutter by itself.
  Future<void> _cleanSilenceOnly() async {
    if (!_hasBase || _model.sourcePath == null) {
      _toast('Import a clip first');
      return;
    }
    final durS = _sourceDurationMs / 1000.0;

    // TRANSCRIPT ENGINE — keep the word timestamps, cut everything else. Needs
    // a transcript (cached, so this is usually free) and no audio analysis.
    if (AppSettings.silenceEngine == SilenceEngineKind.transcript) {
      final prog = ValueNotifier<String>('Reading the transcript…');
      _showProgress(prog);
      List<Word> words = const [];
      String? err;
      try {
        words = await _ensureTranscript(onProgress: (p, m) => prog.value = m);
      } catch (e) {
        err = _cleanErr(e);
      } finally {
        if (mounted) Navigator.of(context).pop();
        prog.dispose();
      }
      if (err != null) {
        _toast('Transcript engine: $err — NO silence was cut');
        return;
      }
      if (words.isEmpty) {
        _toast('Transcript engine: no speech found — NO silence was cut');
        return;
      }
      final keeps = TranscriptSilence.keepRanges(
        words,
        durS,
        padS: AppSettings.transcriptPadMs / 1000.0,
        minSpeechS: AppSettings.minSpeechS,
      );
      final removed = _removedBy(keeps, durS);
      _toast('Transcript engine: ${removed.length} region${removed.length == 1 ? '' : 's'} '
          'from ${words.length} words');
      await _commitOrStage(keeps, durS, 'Silence (transcript)');
      return;
    }

    final prog = ValueNotifier<String>('Cleaning silence…');
    _showProgress(prog);
    var timedOut = false;
    String? engineErr;
    var stats = '';
    List<List<int>> regionsMs = const [];
    try {
      final res = await NativeVad.detectSilences(
        'file://${_model.sourcePath!}',
        minSilenceS: SilenceSettings.minSilenceS,
        padLeftMs: SilenceSettings.padLeftMs.toDouble(),
        padRightMs: SilenceSettings.padRightMs.toDouble(),
        trimLeftMs: SilenceSettings.trimLeftMs.toDouble(),
        trimRightMs: SilenceSettings.trimRightMs.toDouble(),
        breathRefine: SilenceSettings.breathRefine,
      ).timeout(const Duration(minutes: 4), onTimeout: () {
        timedOut = true;
        return const SilenceResult([], '');
      });
      stats = res.stats;
      regionsMs = [for (final r in res.regions) [(r[0] * 1000).round(), (r[1] * 1000).round()]];
    } catch (e) {
      engineErr = _cleanErr(e);
    } finally {
      if (mounted) Navigator.of(context).pop();
      prog.dispose();
    }
    if (engineErr != null) {
      _toast('Silero failed: $engineErr — NO silence was cut');
      return;
    }
    if (timedOut) {
      _toast('Silero timed out — NO silence was cut');
      return;
    }
    if (regionsMs.isEmpty) {
      _toast('Silero found no silence · $stats');
      return;
    }
    _toast('Silero: ${regionsMs.length} region${regionsMs.length == 1 ? '' : 's'} cut · $stats');
    // keeps = the timeline minus the regions (no words involved). Applied now or
    // staged for review, per the "Apply cuts immediately" toggle.
    final keeps = keepRanges(
      const [],
      const [],
      durS,
      cutSilence: false,
      extraSilenceMs: regionsMs,
    );
    await _commitOrStage(keeps, durS, 'Silence');
  }

  // ---- Variations: recut the same footage into a different edit ----
  void _openVariations() => _openSheet(VariationsSheet(
        onGenerate: (count) async {
          if (!_hasBase || _model.sourcePath == null) {
            return const VariationParse([], warnings: ['Import a clip first.']);
          }
          final words = await _ensureTranscript();
          return generateVariations(words, _sourceDurationMs / 1000.0, count);
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
      await _ensureTranscript(onProgress: (p, m) => prog.value = m);
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

  // ---- Speech Cleaner: transcribe → SHOW transcript → judge → apply/stage ----
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
      await _ensureTranscript(onProgress: (p, m) => prog.value = m);
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

    // Silence Mastery (SilenceEngine.kt) — the SAME Silero-only engine the web
    // app on main runs, with the same presets shaping its cuts. NO timestamp
    // fallback: if Silero fails, NOTHING is cut and the failure is shown in the
    // app's own snackbar — so a silent word-gap pass can never masquerade as
    // the engine.
    List<List<int>> fsmn = const [];
    if (cutSilence &&
        _model.sourcePath != null &&
        AppSettings.silenceEngine == SilenceEngineKind.transcript) {
      // Transcript engine: the silence IS the complement of the word stamps.
      fsmn = TranscriptSilence.cutRanges(
        _transcript!,
        durS,
        padS: AppSettings.transcriptPadMs / 1000.0,
        minSpeechS: AppSettings.minSpeechS,
      );
      _toast('Silence (transcript): ${fsmn.length} region${fsmn.length == 1 ? '' : 's'}');
    } else if (cutSilence && _model.sourcePath != null) {
      final prog = ValueNotifier<String>('Cleaning silence…');
      _showProgress(prog);
      var timedOut = false;
      String? engineErr;
      var stats = '';
      try {
        final res = await NativeVad.detectSilences(
          'file://${_model.sourcePath!}',
          minSilenceS: SilenceSettings.minSilenceS,
          padLeftMs: SilenceSettings.padLeftMs.toDouble(),
          padRightMs: SilenceSettings.padRightMs.toDouble(),
          trimLeftMs: SilenceSettings.trimLeftMs.toDouble(),
          trimRightMs: SilenceSettings.trimRightMs.toDouble(),
          breathRefine: SilenceSettings.breathRefine,
        ).timeout(const Duration(minutes: 4), onTimeout: () {
          timedOut = true;
          return const SilenceResult([], '');
        });
        stats = res.stats;
        fsmn = [for (final r in res.regions) [(r[0] * 1000).round(), (r[1] * 1000).round()]];
      } catch (e) {
        engineErr = _cleanErr(e);
        fsmn = const [];
      } finally {
        if (mounted) Navigator.of(context).pop();
        prog.dispose();
      }
      if (engineErr != null) {
        _toast('Silero failed: $engineErr — NO silence was cut');
      } else if (timedOut) {
        _toast('Silero timed out — NO silence was cut');
      } else if (fsmn.isEmpty) {
        _toast('Silero found no silence · $stats');
      } else {
        _toast('Silero: ${fsmn.length} region${fsmn.length == 1 ? '' : 's'} · $stats');
      }
    }

    final keeps = keepRanges(
      _transcript!,
      wordCuts,
      durS,
      cutSilence: false, // Silero owns silence — the word-gap pass is retired
      minPauseS: SilenceSettings.minGapS,
      padS: SilenceSettings.padAfterS,
      airAfterS: SilenceSettings.padAfterS,
      leadBeforeS: SilenceSettings.padBeforeS,
      extraSilenceMs: fsmn,
    );
    await _commitOrStage(keeps, durS, label);
  }

  // ---- review-before-apply -------------------------------------------------

  /// Everything inside [0, durS] that [keeps] does NOT keep — i.e. what a cut
  /// would remove. Source ms.
  List<List<int>> _removedBy(List<List<int>> keeps, double durS) {
    final durMs = (durS * 1000).round();
    final sorted = [for (final k in keeps) [k[0], k[1]]]..sort((a, b) => a[0].compareTo(b[0]));
    final out = <List<int>>[];
    var cursor = 0;
    for (final k in sorted) {
      if (k[0] > cursor) out.add([cursor, k[0]]);
      cursor = k[1] > cursor ? k[1] : cursor;
    }
    if (durMs > cursor) out.add([cursor, durMs]);
    return out.where((r) => r[1] - r[0] > 10).toList();
  }

  /// Apply [keeps] now, or stage them for review — per the "Apply cuts
  /// immediately" toggle. Staging paints the removed regions on the timeline and
  /// raises the confirm bar; nothing changes until the user taps Apply.
  Future<void> _commitOrStage(List<List<int>> keeps, double durS, String label) async {
    if (SilenceSettings.autoApplyCuts) {
      _pushHistory();
      _texts.removeWhere((t) => t.isCaption); // stale after a re-cut
      _model.applyKeepRanges(keeps);
      await _reload(seekTo: 0);
      return;
    }
    final removed = _removedBy(keeps, durS);
    if (removed.isEmpty) {
      _toast('$label: nothing to cut');
      return;
    }
    setState(() {
      _pendingKeeps = keeps;
      _stagedCutsSrc = removed;
      _stagedLabel = label;
    });
  }

  /// The staged (source-time) cuts mapped onto the CURRENT timeline, so they can
  /// be painted over the clips they would remove.
  List<List<int>> get _stagedTimelineRanges {
    final out = <List<int>>[];
    for (final r in _stagedCutsSrc) {
      final a = _model.sourceToEdited(r[0]);
      final b = _model.sourceToEdited(r[1] - 1);
      if (a == null || b == null || b <= a) continue;
      out.add([a, b]);
    }
    return out;
  }

  Future<void> _applyStagedCuts() async {
    final keeps = _pendingKeeps;
    if (keeps == null) return;
    _pushHistory();
    _texts.removeWhere((t) => t.isCaption); // stale after a re-cut
    _model.applyKeepRanges(keeps);
    setState(() {
      _pendingKeeps = null;
      _stagedCutsSrc = const [];
      _stagedLabel = '';
    });
    await _reload(seekTo: 0);
  }

  void _discardStagedCuts() {
    setState(() {
      _pendingKeeps = null;
      _stagedCutsSrc = const [];
      _stagedLabel = '';
    });
  }

  /// The review bar shown while cuts are staged.
  Widget _stagedBar() {
    final n = _stagedCutsSrc.length;
    var removedMs = 0;
    for (final r in _stagedCutsSrc) {
      removedMs += r[1] - r[0];
    }
    return Container(
      padding: const EdgeInsets.fromLTRB(14, 9, 10, 9),
      decoration: BoxDecoration(
        color: const Color(0xFF2A1520),
        border: Border(top: BorderSide(color: const Color(0xFFFF5D6C).withValues(alpha: 0.5))),
      ),
      child: Row(
        children: [
          const Icon(Icons.visibility_outlined, size: 17, color: Color(0xFFFF9BA6)),
          const SizedBox(width: 9),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('$_stagedLabel — $n cut${n == 1 ? '' : 's'} previewed',
                    style: const TextStyle(color: Ec.text, fontSize: 12.5, fontWeight: FontWeight.w600)),
                Text('removes ${(removedMs / 1000).toStringAsFixed(1)}s · nothing changed yet',
                    style: const TextStyle(color: Color(0xFFB08A93), fontSize: 10.5)),
              ],
            ),
          ),
          GestureDetector(
            onTap: _discardStagedCuts,
            behavior: HitTestBehavior.opaque,
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Text('Discard', style: TextStyle(color: Ec.textMute, fontSize: 12.5)),
            ),
          ),
          GestureDetector(
            onTap: _applyStagedCuts,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              decoration: BoxDecoration(color: Ec.indigo, borderRadius: BorderRadius.circular(9)),
              child: const Text('Apply',
                  style: TextStyle(color: Colors.white, fontSize: 12.5, fontWeight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
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
      await _ensureTranscript(onProgress: (p, m) => prog.value = m);
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
      await _ensureTranscript(onProgress: (p, m) => prog.value = m);
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
          _selectedImage = null;
          _selectedAudio = -1;
          _selected = false;
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
      _selectClip(_model.clipIndexAt(_positionMs));
    } else {
      _import();
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_preparing) return _preparationView();
    final screenH = MediaQuery.of(context).size.height;
    if (_previewExpanded) {
      // Fullscreen preview: just the top bar, the stage filling everything, and
      // the transport (whose expand button collapses back).
      return Scaffold(
        backgroundColor: Ec.bg,
        body: SafeArea(
          child: Column(
            children: [
              _topBar(),
              Expanded(child: _stage(screenH, fill: true)),
              _transport(),
            ],
          ),
        ),
      );
    }
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
            if (_pendingKeeps != null) _stagedBar(),
            (_selected || _selectedImage != null)
                ? SelectedToolbar(
                    overlay: _selectedImage != null,
                    video: _selectedImage?.isVideo == true,
                    onCollapse: _clearSelection,
                    onTool: _selectedImage != null ? _onOverlayTool : _onSelectedTool,
                    onDelete: _selectedImage != null ? _deleteSelectedOverlay : _deleteSelected,
                  )
                : ToolDock(
                    hasSelection: false,
                    onEdit: _onEdit,
                    onMusic: _openAudio,
                    onText: _openText,
                    onEaseTools: _openEaseTools,
                    onCaptions: _openCaptions,
                  ),
          ],
        ),
      ),
    );
  }

  Widget _preparationView() {
    return Scaffold(
      backgroundColor: Ec.bg,
      body: SafeArea(
        child: Center(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 34),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const SizedBox(
                  width: 42,
                  height: 42,
                  child: CircularProgressIndicator(strokeWidth: 3, color: Ec.indigo),
                ),
                const SizedBox(height: 22),
                Text(
                  _preparingMessage,
                  textAlign: TextAlign.center,
                  style: const TextStyle(color: Ec.text, fontSize: 16, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 12),
                ClipRRect(
                  borderRadius: BorderRadius.circular(5),
                  child: LinearProgressIndicator(
                    value: (_preparingProgress / 100).clamp(0.0, 1.0),
                    minHeight: 7,
                    backgroundColor: Ec.card2,
                    color: Ec.indigo,
                  ),
                ),
                const SizedBox(height: 9),
                Text(
                  '${_preparingProgress.round()}% · Preparing your media for editing',
                  style: const TextStyle(color: Ec.textMute, fontSize: 12),
                ),
              ],
            ),
          ),
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

  /// The nearest common name for the source's aspect ratio (falls back to the
  /// rounded ratio, e.g. "1.85"), shown in the top-bar badge.
  String get _aspectLabel {
    const named = {'9:16': 9 / 16, '3:4': 3 / 4, '4:5': 4 / 5, '1:1': 1.0, '4:3': 4 / 3, '16:9': 16 / 9};
    var best = '';
    var bestD = 0.06; // within ~6% counts as that ratio
    named.forEach((name, r) {
      final d = (_aspect - r).abs() / r;
      if (d < bestD) {
        bestD = d;
        best = name;
      }
    });
    return best.isNotEmpty ? best : _aspect.toStringAsFixed(2);
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
                  child: const Icon(Icons.arrow_back, size: 22, color: Ec.text),
                ),
              ),
              const Spacer(),
              GestureDetector(
                onTap: _openLayers,
                behavior: HitTestBehavior.opaque,
                child: const SizedBox(
                  width: 34,
                  height: 34,
                  child: Icon(Icons.layers_outlined, size: 20, color: Color(0xFFBDBDC4)),
                ),
              ),
              const SizedBox(width: 4),
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
          // The source's REAL aspect (this used to read "9:16" for every video,
          // landscape included). Tapping opens Export, where the output aspect lives.
          GestureDetector(
            onTap: _hasBase ? _openExport : null,
            behavior: HitTestBehavior.opaque,
            child: Container(
              width: _aspect >= 1 ? 25 : 16,
              height: _aspect >= 1 ? 16 : 25,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                border: Border.all(color: Colors.white, width: 1.6),
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(_aspectLabel,
                  style: const TextStyle(fontSize: 6.5, fontWeight: FontWeight.w700, color: Colors.white)),
            ),
          ),
        ],
      ),
    );
  }

  /// Cover-zoom the preview to the crop of the clip under the playhead (per-clip,
  /// matching the export Crop effect).
  /// Colour adjust + fade-to-black for the clip under the playhead, wrapped
  /// around the texture so the preview matches what the exporter bakes.
  Widget _graded(Widget child) {
    final idx = _model.clipIndexAt(_positionMs);
    if (idx < 0 || idx >= _model.clips.length) return child;
    final c = _model.clips[idx];
    var out = child;

    if (c.brightness != 0 || c.contrast != 0 || c.saturation != 1) {
      // Contrast pivots around mid-grey, brightness is an offset, saturation is
      // the standard luma-weighted mix — the same maths the export effects use.
      final ct = (1.0 + c.contrast).clamp(0.0, 2.0);
      final br = c.brightness * 255.0;
      final off = (1.0 - ct) * 127.5 + br;
      final sa = c.saturation.clamp(0.0, 2.0);
      const lr = 0.2126, lg = 0.7152, lb = 0.0722;
      double m(double w, bool diag) => ct * (w * (1 - sa) + (diag ? sa : 0));
      out = ColorFiltered(
        colorFilter: ColorFilter.matrix(<double>[
          m(lr, true), m(lg, false), m(lb, false), 0, off,
          m(lr, false), m(lg, true), m(lb, false), 0, off,
          m(lr, false), m(lg, false), m(lb, true), 0, off,
          0, 0, 0, 1, 0,
        ]),
        child: out,
      );
    }

    // Fade in / out, measured against this clip's own span on the timeline.
    if (c.fadeInMs > 0 || c.fadeOutMs > 0) {
      final start = _model.clipStartMs(idx);
      final len = c.timelineLenMs;
      final into = _positionMs - start;
      var dim = 0.0;
      if (c.fadeInMs > 0 && into < c.fadeInMs) {
        dim = (1.0 - into / c.fadeInMs).clamp(0.0, 1.0);
      }
      final left = len - into;
      if (c.fadeOutMs > 0 && left < c.fadeOutMs) {
        final d = (1.0 - left / c.fadeOutMs).clamp(0.0, 1.0);
        if (d > dim) dim = d;
      }
      if (dim > 0) {
        out = Stack(fit: StackFit.expand, children: [
          out,
          IgnorePointer(child: Container(color: Colors.black.withValues(alpha: dim))),
        ]);
      }
    }
    return out;
  }

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

  /// Only the small edit affordance belongs over the preview. Timeline trim,
  /// delete, and timing actions remain in the existing editor controls.
  Widget _textControlBar(TextOverlay t) {
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTap: () => _editOverlayText(t),
      child: Container(
        width: 34,
        height: 34,
        decoration: BoxDecoration(
          color: Ec.sheet.withValues(alpha: 0.94),
          shape: BoxShape.circle,
          border: Border.all(color: Ec.hair2),
        ),
        child: const Icon(Icons.edit_outlined, size: 17, color: Ec.text),
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

  List<Widget> _visualOverlayWidgets(Size frame) {
    final layers = <_VisualLayer>[];
    for (final o in _images) {
      if (!o.activeAt(_positionMs) && !identical(o, _selectedImage)) continue;
      final selected = identical(o, _selectedImage);
      final key = ValueKey('${o.videoPath ?? 'image'}:${identityHashCode(o)}');
      layers.add(_VisualLayer(
        o.zIndex,
        o.isVideo
            ? EditableVideoOverlay(
                key: key,
                o: o,
                frame: frame,
                selected: selected,
                playing: _playing,
                positionMs: _positionMs,
                onSelect: () => _selectImage(o),
                onDeselect: _clearSelection,
                onChange: () {
                  setState(() {});
                  _scheduleSave();
                },
              )
            : EditableImageOverlay(
                key: key,
                o: o,
                frame: frame,
                selected: selected,
                onSelect: () => _selectImage(o),
                onDeselect: _clearSelection,
                onChange: () {
                  setState(() {});
                  _scheduleSave();
                },
              ),
      ));
    }
    for (final t in _texts) {
      if (!t.activeAt(_positionMs) && !identical(t, _selectedText)) continue;
      layers.add(_VisualLayer(
        t.zIndex,
        EditableOverlay(
          key: ValueKey('text:${identityHashCode(t)}'),
          t: t,
          frame: frame,
          selected: identical(t, _selectedText),
          onSelect: () => _selectText(t),
          onDeselect: _clearSelection,
          onChange: () {
            setState(() {});
            _scheduleSave();
          },
        ),
      ));
    }
    layers.sort((a, b) => a.z.compareTo(b.z));
    return [for (final layer in layers) layer.widget];
  }

  Widget _stage(double screenH, {bool fill = false}) {
    final h = (screenH * _stageFrac).clamp(160.0, screenH * 0.58);
    return SizedBox(
      height: fill ? double.infinity : h,
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
                    final mainIndex = _model.clipIndexAt(_positionMs);
                    final mainClip = mainIndex >= 0 ? _model.clips[mainIndex] : null;
                    final mainMask = mainClip == null || mainClip.bgMode == 0
                        ? null
                        : mainClip.maskAt(_positionMs - _model.clipStartMs(mainIndex));
                    final basePreview = _graded(_cropped(Texture(textureId: _textureId!)));
                    return Stack(
                      fit: StackFit.expand,
                      clipBehavior: Clip.hardEdge,
                      children: [
                        GestureDetector(
                          behavior: HitTestBehavior.opaque,
                          onTap: _clearSelection,
                          child: mainMask == null
                              ? basePreview
                              : MaskedMedia(maskPath: mainMask, child: basePreview),
                        ),
                        ..._visualOverlayWidgets(frame),
                        if (_selectedText != null)
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
    // Keep the play control centered on the editor viewport itself. The timeline
    // below may scroll horizontally, but this row never participates in it.
    return Container(
      height: 58,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: Stack(
        fit: StackFit.expand,
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: _icBtn(_previewExpanded ? Icons.close_fullscreen : Icons.open_in_full,
                () => setState(() => _previewExpanded = !_previewExpanded), enabled: _hasBase),
          ),
          Align(
            alignment: Alignment.center,
            child: GestureDetector(
              onTap: _togglePlay,
              behavior: HitTestBehavior.opaque,
              child: Container(
                width: 44,
                height: 44,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: _hasBase ? Colors.white.withValues(alpha: 0.08) : Colors.transparent,
                ),
                child: Icon(_playing ? Icons.pause : Icons.play_arrow,
                    size: 30, color: _hasBase ? Colors.white : Ec.disabled),
              ),
            ),
          ),
          Align(
            alignment: Alignment.centerRight,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                _loopToggle(),
                const SizedBox(width: 8),
                _icBtn(Icons.undo, _undo, enabled: _undoStack.isNotEmpty),
                const SizedBox(width: 2),
                _icBtn(Icons.redo, _redo, enabled: _redoStack.isNotEmpty),
              ],
            ),
          ),
        ],
      ),
    );
  }

  /// Loop-playback toggle — teal with an ON caption when active (the transport
  /// slot the web editor uses for its state toggle).
  Widget _loopToggle() {
    const teal = Color(0xFF2DD4BF);
    return GestureDetector(
      onTap: () => setState(() => _loop = !_loop),
      behavior: HitTestBehavior.opaque,
      child: SizedBox(
        width: 34,
        height: 40,
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.repeat, size: 19, color: _loop ? teal : Ec.textDim),
            const SizedBox(height: 1),
            Text(_loop ? 'ON' : 'OFF',
                style: TextStyle(
                    fontSize: 7.5,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.4,
                    color: _loop ? teal : Ec.textFaint)),
          ],
        ),
      ),
    );
  }

  Widget _icBtn(IconData icon, VoidCallback onTap, {bool enabled = true}) {
    return GestureDetector(
      onTap: enabled ? onTap : null,
      child: SizedBox(width: 34, height: 34, child: Icon(icon, size: 21, color: enabled ? Ec.textDim : Ec.disabled)),
    );
  }

  /// All main clips muted? (drives the gutter mute tile's state)
  bool get _clipsMuted =>
      _model.clips.isNotEmpty && _model.clips.every((c) => c.volume <= 0.001);

  /// Toggle every main clip's audio (the CapCut "Mute clip audio" tile).
  Future<void> _toggleMuteClips() async {
    if (!_hasBase) return;
    _pushHistory();
    final target = _clipsMuted ? 1.0 : 0.0;
    for (final c in _model.clips) {
      c.volume = target;
    }
    _toast(target == 0.0 ? 'Clip audio muted' : 'Clip audio unmuted');
    await _reload(seekTo: _positionMs);
    _scheduleSave();
    setState(() {});
  }

  Widget _timeline() {
    return Container(
      decoration: const BoxDecoration(border: Border(top: BorderSide(color: Ec.hair))),
      child: MiniTimeline(
        model: _model,
        clipName: _clipName ?? '',
        stagedCuts: _stagedTimelineRanges,
        muted: _clipsMuted,
        onToggleMute: _toggleMuteClips,
        onAddOverlay: _addOverlay,
        onAddText: _openText,
        onAddAudio: _openAudio,
        positionMs: _positionMs,
        totalMs: _totalMs,
        media: _media,
        audios: _audios,
        selectedAudio: _selectedAudio,
        texts: _texts,
        images: _images,
        selectedImage: _selectedImage,
        selectedText: _selectedText,
        onClearSelection: _clearSelection,
        onScrubStart: () => _scrubbing = true,
        onScrub: (ms) => setState(() => _positionMs = ms),
        onScrubEnd: (ms) async {
          _scrubbing = false;
          await _seek(ms);
        },
        onSelectClip: (i) => _selectClip(i),
        // Hold-drag a main clip to reorder it in the sequence. The grabbed clip
        // floats under the finger; the reorder is committed once, on release, then
        // the native player is rebuilt for the new order.
        onClipReorderStart: () => _selectClip(_model.selected),
        onClipReorder: (from, to) {
          _pushHistory();
          _model.moveClip(from, to);
        },
        onClipDemote: _demotePrimaryClip,
        onClipReorderEnd: () async {
          // Reordering changes which primary frame occupies a composition time;
          // it must not retime independent overlays or jump the user's playhead to
          // the moved clip. Reload the native composition at the same global time.
          final compositionTime = _positionMs.clamp(0, _totalMs).toInt();
          final resumePlaying = _playing;
          _scheduleSave();
          if (_hasBase) {
            await _loadSource(seekTo: compositionTime, resumePlaying: resumePlaying);
          }
        },
        onSelectText: (t) async {
          _selectText(t);
          await _seek(t.startMs.clamp(0, _totalMs > 0 ? _totalMs : t.startMs)); // jump so it's visible + editable
        },
        onSelectImage: (o) async {
          _selectImage(o);
          await _seek(o.startMs.clamp(0, _totalMs > 0 ? _totalMs : o.startMs));
        },
        onSelectAudio: (i) async {
          _selectAudio(i);
          if (i >= 0 && i < _audios.length) {
            await _seek(_audios[i].timelineStartMs.clamp(0, _totalMs > 0 ? _totalMs : _audios[i].timelineStartMs));
          }
        },
        onAudioEditStart: (i) {
          if (_selectedAudio != i) _selectAudio(i);
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
        onOverlayEditStart: (t) {
          if (!identical(_selectedText, t)) _selectText(t);
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
        onImageEditStart: (o) {
          if (!identical(_selectedImage, o)) _selectImage(o);
          _pushHistory();
        },
        onImageMove: (o, dMs) {
          setState(() {
            _selectedImage = o;
            final len = o.endMs - o.startMs;
            // Overlay tracks are independent timed layers: horizontal movement
            // changes only this overlay's global composition interval. It must not
            // move it to another track or modify the primary sequence.
            final start = (o.startMs + dMs).clamp(0, (_totalMs - len).clamp(0, 1 << 30)).toInt();
            o.startMs = start;
            o.endMs = start + len;
          });
        },
        onImageLaneChange: (o, lane) {
          setState(() {
            _selectedImage = o;
            o.lane = lane;
            // Remove empty visual lanes while preserving the relative order of
            // every remaining overlay track.
            final used = _images.map((x) => x.lane).toSet().toList()..sort();
            for (final x in _images) x.lane = used.indexOf(x.lane);
          });
        },
        onImagePromote: _promoteVideoOverlay,
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
class _VisualLayer {
  final int z;
  final Widget widget;
  const _VisualLayer(this.z, this.widget);
}

class _EditSnap {
  final List<EcClip> clips;
  final List<TextOverlay> texts;
  final List<AudioTrack> audios;
  final List<ImageOverlay> images;
  _EditSnap(this.clips, this.texts, this.audios, this.images);
}
