import 'dart:async';

import 'package:flutter/foundation.dart';

import '../native/exporter.dart';

/// One rendered flat proxy: a single pre-encoded MP4 of the whole cut sequence.
class _ProxyEntry {
  final String path;
  final int durationMs;
  const _ProxyEntry(this.path, this.durationMs);
}

/// Renders and caches a "flatten-and-play" preview proxy for the current timeline.
///
/// A single pre-rendered file plays back seamlessly across cut boundaries (no live
/// decoder re-seek), giving CapCut-smooth preview. The proxy is the export's pass-1
/// base — trimmed/concatenated video with crop, speed, output size and per-clip volume
/// baked at low resolution, with NO overlays and NO extra audio (music/voiceover stay
/// live in the player). Text/image overlays keep compositing live on top in the editor.
///
/// Flow: the editor calls [update] whenever the cut list changes (debounced here). When
/// a render — or a cache hit — produces a proxy for the current cuts it notifies
/// listeners; the editor then swaps the player onto [path] if it still [matches] what
/// is on screen. A failed or skipped render simply leaves the editor on the live
/// player, so the proxy is a pure enhancement layer that can never break preview.
class PreviewProxy extends ChangeNotifier {
  PreviewProxy(this._exporter);

  final NativeExporter _exporter;

  /// True only while a proxy render is actually in flight — drives the editor's
  /// "Updating preview…" chip. Stays false during the debounce window.
  final ValueNotifier<bool> rendering = ValueNotifier<bool>(false);

  _ProxyEntry? _ready; // the proxy that corresponds to [_readyHash]
  String? _readyHash;
  String? _wantHash; // hash of the most recent update() — anything else is stale

  Timer? _debounce;
  Object? _renderToken; // identity of the latest in-flight render

  final Map<String, _ProxyEntry> _cache = <String, _ProxyEntry>{};
  static const int _cacheMax = 4;
  static const Duration _debounceFor = Duration(milliseconds: 600);

  /// The ready proxy's file path (null until one has rendered).
  String? get path => _ready?.path;

  /// The ready proxy's timeline duration (ms) — ~equal to the editor's totalMs.
  int? get durationMs => _ready?.durationMs;

  /// The ready proxy's segment hash.
  String? get hash => _readyHash;

  /// True when the ready proxy corresponds exactly to [segments].
  bool matches(List<Map<String, dynamic>> segments) =>
      _ready != null && _readyHash == _hashOf(segments);

  /// Note a new cut list (debounced ~600ms). If it already equals the ready proxy →
  /// no-op; if it is cached (undo/redo/revisit) → promote instantly, no re-render;
  /// otherwise schedule a render. Fire-and-forget: never blocks the caller.
  Future<void> update(List<Map<String, dynamic>> segments, {double aspect = 16 / 9}) async {
    final h = _hashOf(segments);
    _wantHash = h;
    if (_ready != null && _readyHash == h) return; // already showing this proxy
    final cached = _cache[h];
    if (cached != null) {
      _ready = cached;
      _readyHash = h;
      notifyListeners(); // let the editor swap onto the cached proxy
      return;
    }
    final segs = List<Map<String, dynamic>>.from(segments);
    _debounce?.cancel();
    _debounce = Timer(_debounceFor, () {
      _render(segs, h, aspect);
    });
  }

  Future<void> _render(List<Map<String, dynamic>> segments, String h, double aspect) async {
    if (_wantHash != h) return; // superseded during the debounce window
    final token = Object();
    _renderToken = token;
    rendering.value = true;
    final res = await _exporter.renderProxy(segments, aspect: aspect);
    if (_renderToken != token) return; // a newer render took over — it owns the flag
    rendering.value = false;
    if (res == null || _wantHash != h) return; // failed → stay live; or user moved on
    final entry = _ProxyEntry(res.path, res.durationMs);
    _cache[h] = entry;
    _evict(h);
    _ready = entry;
    _readyHash = h;
    notifyListeners();
  }

  /// Keep only the most recent [_cacheMax] proxies; never evict [keep].
  void _evict(String keep) {
    if (_cache.length <= _cacheMax) return;
    for (final k in _cache.keys.toList()) {
      if (_cache.length <= _cacheMax) break;
      if (k != keep) _cache.remove(k);
    }
  }

  /// Stable identity of the cut list: uri + trim + speed + volume + crop per segment.
  String _hashOf(List<Map<String, dynamic>> segs) {
    final b = StringBuffer();
    for (final s in segs) {
      b
        ..write(s['uri'])
        ..write('|')
        ..write(s['startMs'])
        ..write('|')
        ..write(s['endMs'])
        ..write('|')
        ..write(s['speed'])
        ..write('|')
        ..write(s['volume'])
        ..write('|')
        ..write(s['cropL'])
        ..write(',')
        ..write(s['cropT'])
        ..write(',')
        ..write(s['cropR'])
        ..write(',')
        ..write(s['cropB'])
        ..write(';');
    }
    return b.toString();
  }

  /// Drop all state (e.g. when the project closes or a new clip is imported).
  void reset() {
    _debounce?.cancel();
    _debounce = null;
    _renderToken = null;
    _ready = null;
    _readyHash = null;
    _wantHash = null;
    _cache.clear();
    rendering.value = false;
  }

  @override
  void dispose() {
    _debounce?.cancel();
    rendering.dispose();
    super.dispose();
  }
}
