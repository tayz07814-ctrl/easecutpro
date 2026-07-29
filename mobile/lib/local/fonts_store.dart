import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/services.dart' show FontLoader;
import 'package:shared_preferences/shared_preferences.dart';

/// On-device registry of user-added fonts. Each font's family name + its raw
/// TTF/OTF bytes (base64) are persisted in a single [SharedPreferences] blob and
/// (re)registered with the Flutter engine via [FontLoader] on every launch, so
/// both the live preview (EditableOverlay) and the export rasterizer
/// (TextOverlay.bakePngBase64) can render them.
///
/// Dependency-free by design: the bytes live in prefs, so there's no
/// path_provider / documents-dir copy to manage. Fine for the handful of custom
/// fonts a user adds; each is only a few hundred KB.
class EcFonts {
  EcFonts._();
  static final EcFonts instance = EcFonts._();

  static const _key = 'ec_user_fonts_v1';

  /// The two families bundled with the app (see pubspec `flutter: fonts:`).
  static const List<String> bundled = ['InstrumentSans', 'IBMPlexMono'];

  final Map<String, String> _fonts = {}; // family -> base64(ttf/otf bytes)
  bool _loaded = false;

  /// User-added families, in the order they were added.
  List<String> get userFamilies => _fonts.keys.toList();

  /// The full pick list shown in the Font tab: bundled first, then user fonts.
  List<String> get families => [...bundled, ...userFamilies];

  /// True for a family the user added (so the UI can offer a delete affordance).
  bool isUser(String family) => _fonts.containsKey(family);

  /// Load the persisted fonts (once) and (re)register every one with the engine.
  /// Idempotent — safe to call from initState and again after adding a font.
  Future<void> ensureLoaded() async {
    if (!_loaded) {
      _loaded = true;
      try {
        final prefs = await SharedPreferences.getInstance();
        final raw = prefs.getString(_key);
        if (raw != null && raw.isNotEmpty) {
          final data = jsonDecode(raw);
          if (data is Map) {
            data.forEach((k, v) {
              if (v is String) _fonts[k.toString()] = v;
            });
          }
        }
      } catch (_) {
        _fonts.clear(); // corrupt blob — start clean rather than crash
      }
    }
    for (final e in _fonts.entries) {
      await _register(e.key, e.value);
    }
  }

  Future<void> _register(String family, String b64) async {
    try {
      final bytes = base64Decode(b64);
      final data = ByteData.view(bytes.buffer, bytes.offsetInBytes, bytes.lengthInBytes);
      final loader = FontLoader(family)..addFont(Future.value(data));
      await loader.load();
    } catch (_) {
      // ignore an unreadable font rather than break the editor
    }
  }

  /// Register + persist a picked font. [nameHint] is usually the picked file
  /// name; the extension is stripped and the family de-duplicated. Returns the
  /// family string to store on the [TextOverlay].
  Future<String> addFont(String nameHint, Uint8List bytes) async {
    if (!_loaded) await ensureLoaded();
    final family = _familyFrom(nameHint);
    final b64 = base64Encode(bytes);
    _fonts[family] = b64;
    await _register(family, b64);
    await _save();
    return family;
  }

  /// Forget a user font. (Already-loaded glyphs stay in the engine until relaunch,
  /// but the family disappears from the pick list and won't be re-registered.)
  Future<void> remove(String family) async {
    if (_fonts.remove(family) != null) await _save();
  }

  Future<void> _save() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setString(_key, jsonEncode(_fonts));
    } catch (_) {}
  }

  String _familyFrom(String hint) {
    var f = hint.trim();
    final slash = f.lastIndexOf('/');
    if (slash >= 0) f = f.substring(slash + 1);
    final dot = f.lastIndexOf('.');
    if (dot > 0) f = f.substring(0, dot);
    f = f.trim();
    if (f.isEmpty) f = 'Custom font';
    // Avoid clashing with a bundled or an existing user family.
    var name = f;
    var n = 2;
    while (bundled.contains(name) || _fonts.containsKey(name)) {
      name = '$f $n';
      n++;
    }
    return name;
  }
}
