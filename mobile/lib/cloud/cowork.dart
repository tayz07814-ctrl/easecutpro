import 'dart:convert';
import 'dart:io';

import 'package:supabase_flutter/supabase_flutter.dart';

import 'edge.dart';

/// Dart client for Cloud Cowork — same Supabase backend + R2 storage the web app
/// uses (spaces, members, folders, shared projects, join-by-key approval). Media
/// (the source video files a project references) is uploaded to Cloudflare R2 via
/// the r2-sign edge function; the edit doc's file paths are swapped for
/// `ecmedia://<id>` tokens on upload and restored to local paths on open.
class Cowork {
  static SupabaseClient get _c => Supabase.instance.client;
  static final HttpClient _http = HttpClient();

  // ---- identity -----------------------------------------------------------
  static Future<CoworkMe> me() async {
    final u = _c.auth.currentUser;
    final email = u?.email ?? '';
    var name = email.contains('@') ? email.split('@').first : (email.isEmpty ? 'Me' : email);
    var username = '';
    if (u != null) {
      try {
        final p = await _c.from('profiles').select('display_name,username').eq('id', u.id).maybeSingle();
        if (p != null) {
          final un = p['username'] as String?;
          final dn = p['display_name'] as String?;
          if (un != null && un.isNotEmpty) username = un;
          if (dn != null && dn.isNotEmpty) {
            name = dn;
          } else if (username.isNotEmpty) {
            name = username;
          }
        }
      } catch (_) {}
    }
    return CoworkMe(u?.id ?? '', email, name, username);
  }

  static Future<void> setUsername(String username) async {
    final u = _c.auth.currentUser;
    if (u == null) throw Exception('Not signed in');
    final clean = username.trim().replaceFirst(RegExp(r'^@'), '');
    if (!RegExp(r'^[a-zA-Z0-9_.]{3,24}$').hasMatch(clean)) {
      throw Exception('Usernames are 3–24 chars: letters, numbers, _ or .');
    }
    try {
      await _c.from('profiles').update({'username': clean}).eq('id', u.id);
    } on PostgrestException catch (e) {
      if (RegExp('duplicate|unique', caseSensitive: false).hasMatch(e.message)) {
        throw Exception('That username is taken');
      }
      rethrow;
    }
  }

  // ---- spaces -------------------------------------------------------------
  static Future<List<Space>> listSpaces() async {
    final rows = await _c.from('spaces').select('id,name,owner_id,quota_bytes,is_paid,join_key').order('created_at');
    return (rows as List).map((r) => Space.fromRow(r as Map<String, dynamic>)).toList();
  }

  static Future<List<Space>> ensureDefaultSpace() async {
    final spaces = await listSpaces();
    if (spaces.isNotEmpty) return spaces;
    await createSpace('My space');
    return listSpaces();
  }

  static Future<Space> createSpace(String name) async {
    final row = await _c
        .from('spaces')
        .insert({'name': name.trim().isEmpty ? 'Untitled space' : name.trim()})
        .select('id,name,owner_id,quota_bytes,is_paid,join_key')
        .single();
    return Space.fromRow(row);
  }

  static Future<void> renameSpace(String id, String name) async {
    await _c.from('spaces').update({'name': name.trim()}).eq('id', id);
  }

  static Future<void> deleteSpace(String id) async {
    await _c.from('spaces').delete().eq('id', id);
  }

  static Future<String> regenerateJoinKey(String spaceId) async {
    final res = await _c.rpc('cowork_regen_key', params: {'p_space': spaceId});
    final key = res.toString();
    if (key == 'forbidden') throw Exception('Only the space owner can regenerate the key.');
    return key;
  }

  // ---- members + join -----------------------------------------------------
  static Future<List<Member>> listMembers(String spaceId) async {
    final res = await _c.rpc('cowork_members', params: {'p_space': spaceId});
    return ((res as List?) ?? []).map((r) => Member.fromRow((r as Map).cast<String, dynamic>())).toList();
  }

  static Future<void> inviteMember(String spaceId, String identifier) async {
    final id = identifier.trim();
    if (id.isEmpty) throw Exception('Enter a username or email');
    final res = await _c.rpc('cowork_invite', params: {'p_space': spaceId, 'p_identifier': id});
    final status = res.toString();
    if (status == 'no_account') throw Exception('No EaseCut account matches that username or email.');
    if (status == 'already_member') throw Exception('They are already in this space.');
    if (status == 'forbidden') throw Exception('Only the space owner can invite members.');
    if (status != 'ok') throw Exception('Could not send the invite.');
  }

  static Future<void> removeMember(String spaceId, String userId) async {
    await _c.from('space_members').delete().eq('space_id', spaceId).eq('user_id', userId);
  }

  /// Ask to join by key — creates a pending request the owner must approve.
  static Future<String> requestJoinByKey(String key) async {
    final k = key.trim();
    if (k.isEmpty) throw Exception('Enter a space key');
    final res = await _c.rpc('cowork_request_join', params: {'p_key': k});
    final s = res.toString();
    if (s == 'not_found') throw Exception('No space matches that key.');
    return s; // 'requested' | 'pending' | 'already_member'
  }

  static Future<List<JoinRequest>> listJoinRequests(String spaceId) async {
    final res = await _c.rpc('cowork_list_requests', params: {'p_space': spaceId});
    return ((res as List?) ?? []).map((r) => JoinRequest.fromRow((r as Map).cast<String, dynamic>())).toList();
  }

  static Future<void> decideJoinRequest(String requestId, bool approve) async {
    final res = await _c.rpc('cowork_decide_request', params: {'p_request': requestId, 'p_approve': approve});
    if (res.toString() == 'forbidden') throw Exception('Only the space owner can do that.');
  }

  // ---- folders ------------------------------------------------------------
  static Future<List<SpaceFolder>> listFolders(String spaceId) async {
    final rows = await _c.from('space_folders').select('id,name').eq('space_id', spaceId).order('created_at');
    return (rows as List).map((r) => SpaceFolder.fromRow(r as Map<String, dynamic>)).toList();
  }

  static Future<SpaceFolder> createFolder(String spaceId, String name) async {
    final row = await _c
        .from('space_folders')
        .insert({'space_id': spaceId, 'name': name.trim().isEmpty ? 'New folder' : name.trim()})
        .select('id,name')
        .single();
    return SpaceFolder.fromRow(row);
  }

  static Future<void> renameFolder(String id, String name) async {
    await _c.from('space_folders').update({'name': name.trim()}).eq('id', id);
  }

  static Future<void> deleteFolder(String id) async {
    await _c.from('space_folders').delete().eq('id', id);
  }

  static Future<void> moveProjectToFolder(String projectId, String? folderId) async {
    final res = await _c.rpc('cowork_move_project', params: {'p_project': projectId, 'p_folder': folderId});
    if (res.toString() == 'forbidden') throw Exception('Only space members can move projects.');
  }

  // ---- projects -----------------------------------------------------------
  static Future<List<CoworkProject>> listProjects(String spaceId) async {
    final rows = await _c
        .from('space_projects')
        .select('id,space_id,name,media_bytes,updated_at,folder_id')
        .eq('space_id', spaceId)
        .order('updated_at', ascending: false);
    return (rows as List).map((r) => CoworkProject.fromRow(r as Map<String, dynamic>)).toList();
  }

  static Future<({int used, int quota})> usage(String spaceId) async {
    final sp = await _c.from('spaces').select('quota_bytes').eq('id', spaceId).maybeSingle();
    final projs = await _c.from('space_projects').select('media_bytes').eq('space_id', spaceId);
    final quota = ((sp?['quota_bytes'] as num?) ?? (100 * 1073741824)).toInt();
    var used = 0;
    for (final r in (projs as List)) {
      used += ((r as Map)['media_bytes'] as num?)?.toInt() ?? 0;
    }
    return (used: used, quota: quota);
  }

  static Future<List<String>> _editVersions(String projectId) async {
    final rows = await _c
        .from('space_project_edits')
        .select('user_id,updated_at')
        .eq('project_id', projectId)
        .order('updated_at', ascending: false);
    return (rows as List).map((r) => (r as Map)['user_id'] as String).toList();
  }

  // ---- R2 keys + transport ------------------------------------------------
  static String _mediaKey(String pid, String id) => 'projects/$pid/media/$id';
  static String _manifestKey(String pid) => 'projects/$pid/manifest.json';
  static String _editKey(String pid, String uid) => 'projects/$pid/edits/$uid.json';

  static Future<String> _presign(String op, String spaceId, String key, {int? contentLength, bool countsToQuota = false}) async {
    final body = <String, dynamic>{'op': op, 'spaceId': spaceId, 'key': key};
    if (contentLength != null) body['contentLength'] = contentLength;
    if (countsToQuota) body['countsToQuota'] = true;
    final r = await invokeEdge('r2-sign', body);
    return r['url'] as String;
  }

  static Future<void> _putFile(String url, File f, int len) async {
    final req = await _http.putUrl(Uri.parse(url));
    req.contentLength = len;
    await req.addStream(f.openRead());
    final resp = await req.close();
    await resp.drain();
    if (resp.statusCode < 200 || resp.statusCode >= 300) throw Exception('Upload failed (${resp.statusCode})');
  }

  static Future<void> _putBytes(String url, List<int> bytes) async {
    final req = await _http.putUrl(Uri.parse(url));
    req.contentLength = bytes.length;
    req.add(bytes);
    final resp = await req.close();
    await resp.drain();
    if (resp.statusCode < 200 || resp.statusCode >= 300) throw Exception('Upload failed (${resp.statusCode})');
  }

  static Future<void> _getToFile(String url, File out) async {
    final req = await _http.getUrl(Uri.parse(url));
    final resp = await req.close();
    if (resp.statusCode < 200 || resp.statusCode >= 300) throw Exception('Download failed (${resp.statusCode})');
    final sink = out.openWrite();
    await resp.pipe(sink);
  }

  static Future<String> _getString(String url) async {
    final req = await _http.getUrl(Uri.parse(url));
    final resp = await req.close();
    if (resp.statusCode < 200 || resp.statusCode >= 300) throw Exception('Download failed (${resp.statusCode})');
    return resp.transform(utf8.decoder).join();
  }

  // ---- media-path helpers -------------------------------------------------
  static String _fsPath(String uri) => uri.startsWith('file://') ? Uri.parse(uri).toFilePath() : uri;
  static String _basename(String uri) => _fsPath(uri).split('/').last;
  static String _ext(String uri) {
    final b = _basename(uri);
    final i = b.lastIndexOf('.');
    return i >= 0 ? b.substring(i + 1) : 'mp4';
  }

  /// Every source-video / audio file path the project's `mobile` doc references.
  static List<String> _collectUris(Map<String, dynamic> mobile) {
    final out = <String>{};
    final sp = mobile['sourcePath'];
    if (sp is String && sp.isNotEmpty) out.add(sp);
    for (final c in (mobile['clips'] as List? ?? [])) {
      final s = (c as Map)['src'];
      if (s is String && s.isNotEmpty) out.add(s);
    }
    for (final a in (mobile['audio'] as List? ?? [])) {
      final u = (a as Map)['uri'];
      if (u is String && u.isNotEmpty) out.add(u);
    }
    return out.toList();
  }

  static void _rewrite(Map<String, dynamic>? mobile, Map<String, String> map) {
    if (mobile == null) return;
    final sp = mobile['sourcePath'];
    if (sp is String && map.containsKey(sp)) mobile['sourcePath'] = map[sp];
    for (final c in (mobile['clips'] as List? ?? [])) {
      final s = (c as Map)['src'];
      if (s is String && map.containsKey(s)) c['src'] = map[s];
    }
    for (final a in (mobile['audio'] as List? ?? [])) {
      final u = (a as Map)['uri'];
      if (u is String && map.containsKey(u)) a['uri'] = map[u];
    }
  }

  // ---- share / open -------------------------------------------------------
  /// Upload the current editor doc + its media to a space (optionally into a
  /// folder). Returns the created space project.
  static Future<CoworkProject> shareProject(
    String spaceId,
    Map<String, dynamic> doc,
    String name, {
    String? folderId,
    void Function(String)? onStep,
  }) async {
    final u = await me();
    final rec = await _c.from('space_projects').insert({
      'space_id': spaceId,
      'name': name.trim().isEmpty ? 'Untitled' : name.trim(),
      'created_by': u.id,
      'folder_id': folderId,
    }).select('id,space_id,name,media_bytes,updated_at,folder_id').single();
    final pid = rec['id'] as String;

    final mobile = (doc['mobile'] as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{};
    final uris = _collectUris(mobile);
    final manifest = <String, dynamic>{};
    final idByUri = <String, String>{};
    var total = 0;
    for (var i = 0; i < uris.length; i++) {
      final uri = uris[i];
      final id = 'm$i';
      idByUri[uri] = 'ecmedia://$id';
      final f = File(_fsPath(uri));
      final len = await f.length();
      onStep?.call('Uploading ${_basename(uri)}…');
      final url = await _presign('put', spaceId, _mediaKey(pid, id), contentLength: len, countsToQuota: true);
      await _putFile(url, f, len);
      manifest[id] = {'name': _basename(uri), 'ext': _ext(uri)};
      total += len;
    }

    // Rewrite a deep copy of the doc so on-device paths become portable tokens.
    final outDoc = jsonDecode(jsonEncode(doc)) as Map<String, dynamic>;
    _rewrite((outDoc['mobile'] as Map?)?.cast<String, dynamic>(), idByUri);

    onStep?.call('Saving project…');
    final mBytes = utf8.encode(jsonEncode(manifest));
    await _putBytes(await _presign('put', spaceId, _manifestKey(pid), contentLength: mBytes.length), mBytes);
    final eBytes = utf8.encode(jsonEncode(outDoc));
    await _putBytes(await _presign('put', spaceId, _editKey(pid, u.id), contentLength: eBytes.length), eBytes);

    final now = DateTime.now().toUtc().toIso8601String();
    await _c.from('space_projects').update({'media_bytes': total, 'updated_at': now}).eq('id', pid);
    await _c.from('space_project_edits').upsert(
      {'project_id': pid, 'user_id': u.id, 'member_name': u.name, 'bytes': eBytes.length, 'updated_at': now},
      onConflict: 'project_id,user_id',
    );
    return CoworkProject.fromRow({...rec, 'media_bytes': total});
  }

  /// Download a shared project's edit doc + media to local files and return a
  /// ready-to-open project doc (media tokens rewritten to local paths).
  static Future<Map<String, dynamic>> openProject(CoworkProject cp, {void Function(String)? onStep}) async {
    final spaceId = cp.spaceId;
    final pid = cp.id;
    final versions = await _editVersions(pid);
    final uid = versions.isNotEmpty ? versions.first : (await me()).id;

    onStep?.call('Loading project…');
    final doc = jsonDecode(await _getString(await _presign('get', spaceId, _editKey(pid, uid)))) as Map<String, dynamic>;

    var manifest = <String, dynamic>{};
    try {
      manifest = jsonDecode(await _getString(await _presign('get', spaceId, _manifestKey(pid)))) as Map<String, dynamic>;
    } catch (_) {}

    final dir = Directory('${Directory.systemTemp.path}/eccowork/$pid');
    await dir.create(recursive: true);
    final tokenToPath = <String, String>{};
    for (final entry in manifest.entries) {
      final id = entry.key;
      final meta = (entry.value as Map);
      final ext = (meta['ext'] as String?) ?? 'mp4';
      onStep?.call('Downloading ${meta['name'] ?? id}…');
      final out = File('${dir.path}/$id.$ext');
      if (!(await out.exists())) {
        await _getToFile(await _presign('get', spaceId, _mediaKey(pid, id)), out);
      }
      tokenToPath['ecmedia://$id'] = out.path;
    }
    _rewrite((doc['mobile'] as Map?)?.cast<String, dynamic>(), tokenToPath);
    return doc;
  }
}

// ---- models ---------------------------------------------------------------
class CoworkMe {
  final String id, email, name, username;
  const CoworkMe(this.id, this.email, this.name, this.username);
}

class Space {
  final String id, name, ownerId, joinKey;
  final int quotaBytes;
  final bool isPaid;
  const Space(this.id, this.name, this.ownerId, this.joinKey, this.quotaBytes, this.isPaid);
  factory Space.fromRow(Map<String, dynamic> r) => Space(
        r['id'] as String,
        (r['name'] as String?) ?? 'Space',
        (r['owner_id'] as String?) ?? '',
        (r['join_key'] as String?) ?? '',
        (r['quota_bytes'] as num?)?.toInt() ?? (100 * 1073741824),
        r['is_paid'] == true,
      );
}

class Member {
  final String userId, role, username, email, name;
  const Member(this.userId, this.role, this.username, this.email, this.name);
  factory Member.fromRow(Map<String, dynamic> r) => Member(
        (r['user_id'] as String?) ?? '',
        (r['role'] as String?) ?? 'editor',
        (r['username'] as String?) ?? '',
        (r['email'] as String?) ?? '',
        (r['name'] as String?) ?? 'Member',
      );
}

class JoinRequest {
  final String id, userId, username, email, name, createdAt;
  const JoinRequest(this.id, this.userId, this.username, this.email, this.name, this.createdAt);
  factory JoinRequest.fromRow(Map<String, dynamic> r) => JoinRequest(
        (r['id'] as String?) ?? '',
        (r['user_id'] as String?) ?? '',
        (r['username'] as String?) ?? '',
        (r['email'] as String?) ?? '',
        (r['name'] as String?) ?? 'Member',
        (r['created_at'] as String?) ?? '',
      );
}

class SpaceFolder {
  final String id, name;
  const SpaceFolder(this.id, this.name);
  factory SpaceFolder.fromRow(Map<String, dynamic> r) => SpaceFolder(r['id'] as String, (r['name'] as String?) ?? 'Folder');
}

class CoworkProject {
  final String id, spaceId, name, updatedAt;
  final int mediaBytes;
  final String? folderId;
  const CoworkProject(this.id, this.spaceId, this.name, this.updatedAt, this.mediaBytes, this.folderId);
  factory CoworkProject.fromRow(Map<String, dynamic> r) => CoworkProject(
        r['id'] as String,
        (r['space_id'] as String?) ?? '',
        (r['name'] as String?) ?? 'Untitled',
        (r['updated_at'] as String?) ?? '',
        (r['media_bytes'] as num?)?.toInt() ?? 0,
        r['folder_id'] as String?,
      );
}
