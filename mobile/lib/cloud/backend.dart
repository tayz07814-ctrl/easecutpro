import 'package:supabase_flutter/supabase_flutter.dart';

/// Thin Dart client over the same Supabase backend the web app uses
/// (cloud/auth.ts + cloud/projects.ts). RLS is owner-only, so every query is
/// automatically scoped to the signed-in user.
class Backend {
  static SupabaseClient get _c => Supabase.instance.client;

  // ---- Auth ----
  static bool get signedIn => _c.auth.currentSession != null;
  static String get email => _c.auth.currentUser?.email ?? '';

  /// Sign in. Throws with the Supabase message on failure.
  static Future<void> signIn(String email, String password) async {
    await _c.auth.signInWithPassword(email: email.trim(), password: password);
  }

  /// Sign up. Mirrors cloudSignup: if email confirmation is on there's no session
  /// yet — surface that instead of a silent not-logged-in state.
  static Future<void> signUp(String email, String password) async {
    final res = await _c.auth.signUp(email: email.trim(), password: password);
    if (res.session == null) {
      throw const AuthException('Check your email to confirm your account, then log in.');
    }
  }

  static Future<void> signOut() async {
    try {
      await _c.auth.signOut();
    } catch (_) {}
  }

  // ---- Projects ----
  static Future<List<ProjectMeta>> listProjects() async {
    final rows = await _c
        .from('projects')
        .select('id,name,thumb,created_at,updated_at')
        .order('updated_at', ascending: false);
    return (rows as List).map((r) => ProjectMeta.fromRow(r as Map<String, dynamic>)).toList();
  }

  static Future<ProjectMeta> createProject(String name) async {
    final row = await _c
        .from('projects')
        .insert({'name': name.isEmpty ? 'Untitled' : name})
        .select('id,name,thumb,created_at,updated_at')
        .single();
    return ProjectMeta.fromRow(row);
  }

  static Future<void> renameProject(String id, String name) async {
    await _c.from('projects').update({'name': name}).eq('id', id);
  }

  static Future<void> deleteProject(String id) async {
    await _c.from('projects').delete().eq('id', id);
  }

  /// Load the full `project` jsonb (mobile edit-state lives under the "mobile" key).
  static Future<Map<String, dynamic>?> loadProject(String id) async {
    final row = await _c.from('projects').select('project').eq('id', id).maybeSingle();
    final p = row?['project'];
    if (p is Map) return Map<String, dynamic>.from(p);
    return null;
  }

  /// Persist [fullDoc] to `project` jsonb + bump updated_at (+ optional thumb).
  static Future<void> saveProject(String id, Map<String, dynamic> fullDoc, {String? thumb}) async {
    final patch = <String, dynamic>{
      'project': fullDoc,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
    };
    if (thumb != null) patch['thumb'] = thumb;
    await _c.from('projects').update(patch).eq('id', id);
  }
}

class ProjectMeta {
  final String id;
  final String name;
  final String? thumb;
  final DateTime updatedAt;
  const ProjectMeta({required this.id, required this.name, this.thumb, required this.updatedAt});

  factory ProjectMeta.fromRow(Map<String, dynamic> r) {
    return ProjectMeta(
      id: r['id'] as String,
      name: (r['name'] as String?) ?? 'Untitled',
      thumb: r['thumb'] as String?,
      updatedAt: DateTime.tryParse((r['updated_at'] as String?) ?? '') ?? DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  /// "Edited 2h ago" style relative label from updatedAt.
  String relative(DateTime now) {
    final d = now.difference(updatedAt);
    if (d.inMinutes < 1) return 'Edited just now';
    if (d.inMinutes < 60) return 'Edited ${d.inMinutes}m ago';
    if (d.inHours < 24) return 'Edited ${d.inHours}h ago';
    if (d.inDays < 7) return 'Edited ${d.inDays}d ago';
    return 'Edited ${(d.inDays / 7).floor()}w ago';
  }
}
