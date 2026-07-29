import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// A user-saved text style preset. Captures everything the Text sheet needs to
/// reproduce a look: colour, weight, background, font family, size and
/// alignment, plus [base] — the built-in preset index it was derived from (so
/// the Style tab can re-highlight it). Persisted locally via [TextPresets].
class TextPreset {
  final String id;
  String name;
  int colorValue; // ARGB (Color.toARGB32)
  bool bold;
  bool bg;
  String? fontFamily; // null = app default font
  double size; // same units as the sheet's _size (fraction of frame height)
  String align; // 'left' | 'center' | 'right'
  int base; // built-in preset index (0..) this was saved from

  TextPreset({
    required this.id,
    required this.name,
    required this.colorValue,
    required this.bold,
    required this.bg,
    required this.fontFamily,
    required this.size,
    required this.align,
    required this.base,
  });

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'c': colorValue,
        'b': bold,
        'bg': bg,
        if (fontFamily != null) 'ff': fontFamily,
        'sz': size,
        'al': align,
        'base': base,
      };

  factory TextPreset.fromJson(Map j) => TextPreset(
        id: (j['id'] as String?) ?? 'p${DateTime.now().microsecondsSinceEpoch}',
        name: (j['name'] as String?) ?? 'Preset',
        colorValue: (j['c'] as num?)?.toInt() ?? 0xFFFFFFFF,
        bold: (j['b'] as bool?) ?? true,
        bg: (j['bg'] as bool?) ?? false,
        fontFamily: j['ff'] as String?,
        size: (j['sz'] as num?)?.toDouble() ?? 0.09,
        align: (j['al'] as String?) ?? 'center',
        base: (j['base'] as num?)?.toInt() ?? 0,
      );
}

/// On-device list of the user's custom text presets, stored as one JSON blob in
/// [SharedPreferences]. Nothing here touches Supabase.
class TextPresets {
  TextPresets._();
  static final TextPresets instance = TextPresets._();

  static const _key = 'ec_text_presets_v1';

  final List<TextPreset> _presets = [];
  bool _loaded = false;

  List<TextPreset> get presets => List.unmodifiable(_presets);

  /// Load persisted presets once. Safe to call repeatedly.
  Future<void> load() async {
    if (_loaded) return;
    _loaded = true;
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw != null && raw.isNotEmpty) {
        final data = jsonDecode(raw);
        if (data is List) {
          for (final p in data) {
            if (p is Map) _presets.add(TextPreset.fromJson(p));
          }
        }
      }
    } catch (_) {
      _presets.clear();
    }
  }

  Future<TextPreset> add({
    required String name,
    required int colorValue,
    required bool bold,
    required bool bg,
    required String? fontFamily,
    required double size,
    required String align,
    required int base,
  }) async {
    final n = name.trim();
    final p = TextPreset(
      id: 'p${DateTime.now().microsecondsSinceEpoch}',
      name: n.isEmpty ? 'Preset ${_presets.length + 1}' : n,
      colorValue: colorValue,
      bold: bold,
      bg: bg,
      fontFamily: fontFamily,
      size: size,
      align: align,
      base: base,
    );
    _presets.add(p);
    await _save();
    return p;
  }

  Future<void> delete(String id) async {
    _presets.removeWhere((p) => p.id == id);
    await _save();
  }

  Future<void> _save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(_presets.map((p) => p.toJson()).toList()));
    } catch (_) {}
  }
}
