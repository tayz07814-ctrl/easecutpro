import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// A user-created local folder used to group projects on the "Folders" tab.
/// Purely client-side — folder names and which projects live in them are
/// persisted in [SharedPreferences], never on the server. See [LocalFolders].
class LocalFolder {
  final String id;
  String name;
  LocalFolder({required this.id, required this.name});

  Map<String, dynamic> toJson() => {'id': id, 'name': name};

  factory LocalFolder.fromJson(Map<String, dynamic> j) =>
      LocalFolder(id: j['id'] as String, name: (j['name'] as String?) ?? 'Folder');
}

/// On-device organization of projects into named folders. Nothing here touches
/// Supabase: the folder list and a `projectId -> folderId` map are stored as one
/// JSON blob under a single [SharedPreferences] key, so folders survive app
/// restarts with no backend table or migration.
class LocalFolders {
  static const _key = 'local_folders_v1';

  final List<LocalFolder> _folders = [];
  final Map<String, String> _assign = {}; // projectId -> folderId

  List<LocalFolder> get folders => List.unmodifiable(_folders);

  /// Load persisted folders + assignments. Safe to call repeatedly.
  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_key);
    _folders.clear();
    _assign.clear();
    if (raw == null || raw.isEmpty) return;
    try {
      final data = jsonDecode(raw);
      if (data is Map) {
        final fl = data['folders'];
        if (fl is List) {
          for (final f in fl) {
            if (f is Map) _folders.add(LocalFolder.fromJson(Map<String, dynamic>.from(f)));
          }
        }
        final assigns = data['assignments'];
        if (assigns is Map) {
          assigns.forEach((k, v) {
            if (v is String) _assign[k.toString()] = v;
          });
        }
      }
    } catch (_) {
      // Corrupt blob — start clean rather than crash.
      _folders.clear();
      _assign.clear();
    }
  }

  Future<void> _save() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key,
      jsonEncode({
        'folders': _folders.map((f) => f.toJson()).toList(),
        'assignments': _assign,
      }),
    );
  }

  String _newId() => 'f${DateTime.now().microsecondsSinceEpoch}';

  Future<LocalFolder> create(String name) async {
    final n = name.trim();
    final f = LocalFolder(id: _newId(), name: n.isEmpty ? 'Folder' : n);
    _folders.add(f);
    await _save();
    return f;
  }

  Future<void> rename(String id, String name) async {
    final t = name.trim();
    if (t.isEmpty) return;
    for (final f in _folders) {
      if (f.id == id) {
        f.name = t;
        break;
      }
    }
    await _save();
  }

  Future<void> delete(String id) async {
    _folders.removeWhere((f) => f.id == id);
    _assign.removeWhere((_, folderId) => folderId == id);
    await _save();
  }

  /// The folder a project is filed under, or null if unfiled.
  String? folderOf(String projectId) => _assign[projectId];

  /// File [projectId] into [folderId], or pass null to unfile it.
  Future<void> assign(String projectId, String? folderId) async {
    if (folderId == null) {
      _assign.remove(projectId);
    } else {
      _assign[projectId] = folderId;
    }
    await _save();
  }

  /// Project ids currently filed under [folderId].
  List<String> projectIdsIn(String folderId) =>
      _assign.entries.where((e) => e.value == folderId).map((e) => e.key).toList();
}
