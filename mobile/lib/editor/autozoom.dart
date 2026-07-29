import 'dart:convert';

import '../cloud/edge.dart';

/// Auto Zoom judge (mirrors web cloud/autoZoom.ts): asks Gemma via the
/// `auto-zoom-judge` edge function which segments deserve a punch-in. On the
/// phone the zoom itself is a centred crop (see editor _autoZoom), so we only
/// need the segment index + level here.
class ZoomPick {
  final int i;
  final double level;
  const ZoomPick(this.i, this.level);
}

const _gemma = 'google/gemma-4-31b-it';

double _clampLevel(dynamic v) {
  var n = (v is num) ? v.toDouble() : 1.12;
  if (n > 3) {
    n = n / 100; // model emitted a percentage (115)
  } else if (n < 1) {
    n = 1 + n; // model emitted a delta (0.15)
  }
  return n.clamp(1.04, 1.2);
}

/// segments: [{i, t, d}] → picks. Returns [] on any failure (caller falls back).
Future<List<ZoomPick>> judgeZooms(List<Map<String, dynamic>> segments) async {
  try {
    final res = await invokeEdge('auto-zoom-judge', {'segments': jsonEncode(segments), 'model': _gemma});
    final raw = res['raw'] as String?;
    if (raw == null || raw.isEmpty) return [];
    dynamic parsed;
    try {
      parsed = jsonDecode(raw);
    } catch (_) {
      // salvage the first {...} block if the model wrapped the JSON in prose
      final s = raw.indexOf('{');
      final e = raw.lastIndexOf('}');
      if (s < 0 || e <= s) return [];
      parsed = jsonDecode(raw.substring(s, e + 1));
    }
    final zooms = (parsed is Map && parsed['zooms'] is List)
        ? parsed['zooms'] as List
        : (parsed is List ? parsed : const []);
    final out = <ZoomPick>[];
    for (final z in zooms) {
      if (z is Map && z['i'] is num) out.add(ZoomPick((z['i'] as num).toInt(), _clampLevel(z['level'])));
    }
    return out;
  } catch (_) {
    return [];
  }
}

/// Deterministic fallback: zoom the longest, non-adjacent segments (≤55%).
List<ZoomPick> fallbackZooms(List<Map<String, dynamic>> segs) {
  final budget = (segs.length * 0.55).floor().clamp(1, segs.isEmpty ? 1 : segs.length);
  final byLen = [...segs]..sort((a, b) => (b['d'] as num).compareTo(a['d'] as num));
  final chosen = <int>{};
  for (final s in byLen) {
    if (chosen.length >= budget) break;
    final i = s['i'] as int;
    if (chosen.contains(i - 1) || chosen.contains(i + 1)) continue;
    chosen.add(i);
  }
  var k = 0;
  return [for (final i in chosen) ZoomPick(i, (k++ % 2 == 0) ? 1.1 : 1.14)];
}
