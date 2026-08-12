import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../cloud/backend.dart';
import '../cloud/cowork.dart';
import '../local/app_settings.dart';
import '../theme.dart';
import 'editor_screen.dart';

/// Cloud Cowork (mobile) — spaces with shared folders + projects. Open a shared
/// project (downloads it as a local editable copy) or share a local one up.
class CoworkScreen extends StatefulWidget {
  const CoworkScreen({super.key});

  @override
  State<CoworkScreen> createState() => _CoworkScreenState();
}

class _CoworkScreenState extends State<CoworkScreen> {
  CoworkMe? _me;
  List<Space> _spaces = [];
  String? _spaceId;
  List<SpaceFolder> _folders = [];
  String? _folder; // null = All
  List<CoworkProject> _projects = [];
  int _used = 0, _quota = 100 * 1073741824;
  bool _loading = true;
  String? _error;

  Space? get _space {
    for (final s in _spaces) {
      if (s.id == _spaceId) return s;
    }
    return null;
  }

  bool get _isOwner => _space != null && _me != null && _space!.ownerId == _me!.id;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    try {
      final me = await Cowork.me();
      final spaces = await Cowork.ensureDefaultSpace();
      if (!mounted) return;
      setState(() {
        _me = me;
        _spaces = spaces;
        _spaceId = spaces.isNotEmpty ? spaces.first.id : null;
      });
      await _reload();
    } catch (e) {
      if (mounted) setState(() => _error = _err(e));
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _reloadSpaces() async {
    _spaces = await Cowork.listSpaces();
    if (mounted) setState(() {});
  }

  Future<void> _reload() async {
    final id = _spaceId;
    if (id == null) return;
    try {
      final u = await Cowork.usage(id);
      final f = await Cowork.listFolders(id);
      final p = await Cowork.listProjects(id);
      if (!mounted) return;
      setState(() {
        _used = u.used;
        _quota = u.quota;
        _folders = f;
        _projects = p;
      });
    } catch (e) {
      if (mounted) _toast(_err(e));
    }
  }

  // ---- helpers ----
  String _err(Object e) => e.toString().replaceFirst('Exception: ', '');
  void _toast(String m) {
    if (!mounted) return;
    if (!AppSettings.showStatusMessages) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: Ec.card));
  }

  String _fmtBytes(int n) {
    if (n >= 1073741824) return '${(n / 1073741824).toStringAsFixed(n >= 10 * 1073741824 ? 0 : 1)} GB';
    if (n >= 1048576) return '${(n / 1048576).round()} MB';
    if (n >= 1024) return '${(n / 1024).round()} KB';
    return '$n B';
  }

  String _rel(String iso) {
    final t = DateTime.tryParse(iso);
    if (t == null) return '';
    final d = DateTime.now().difference(t);
    if (d.inMinutes < 1) return 'just now';
    if (d.inMinutes < 60) return '${d.inMinutes}m ago';
    if (d.inHours < 24) return '${d.inHours}h ago';
    return '${d.inDays}d ago';
  }

  Future<String?> _prompt(String title, {String? initial, String hint = ''}) async {
    final ctrl = TextEditingController(text: initial ?? '');
    return showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        title: Text(title, style: const TextStyle(color: Ec.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(color: Ec.text),
          decoration: InputDecoration(hintText: hint, hintStyle: const TextStyle(color: Ec.textFaint)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel', style: TextStyle(color: Ec.textMute))),
          TextButton(onPressed: () => Navigator.pop(context, ctrl.text.trim()), child: const Text('OK', style: TextStyle(color: Ec.indigoText))),
        ],
      ),
    );
  }

  Future<void> _runWithProgress(Future<void> Function(void Function(String)) task) async {
    final msg = ValueNotifier<String>('Starting…');
    showDialog(
      context: context,
      barrierDismissible: false,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        content: Row(children: [
          const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Ec.indigo)),
          const SizedBox(width: 16),
          Expanded(
            child: ValueListenableBuilder<String>(
              valueListenable: msg,
              builder: (_, v, __) => Text(v, style: const TextStyle(color: Ec.textDim, fontSize: 13)),
            ),
          ),
        ]),
      ),
    );
    try {
      await task((s) => msg.value = s);
      if (mounted) Navigator.of(context).pop();
    } catch (e) {
      if (mounted) Navigator.of(context).pop();
      _toast(_err(e));
    } finally {
      msg.dispose();
    }
  }

  // ---- actions ----
  Future<void> _open(CoworkProject cp) async {
    String? newId;
    await _runWithProgress((step) async {
      final doc = await Cowork.openProject(cp, onStep: step);
      step('Preparing local copy…');
      final meta = await Backend.createProject(cp.name);
      await Backend.saveProject(meta.id, doc);
      newId = meta.id;
    });
    if (newId != null && mounted) {
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => EditorScreen(projectId: newId)));
    }
  }

  Future<void> _share() async {
    final id = _spaceId;
    if (id == null) return;
    List<ProjectMeta> locals;
    try {
      locals = await Backend.listProjects();
    } catch (e) {
      _toast(_err(e));
      return;
    }
    if (!mounted) return;
    final picked = await showModalBottomSheet<ProjectMeta>(
      context: context,
      backgroundColor: Ec.sheet,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(padding: EdgeInsets.all(16), child: Text('Upload a local project', style: TextStyle(color: Ec.text, fontSize: 15, fontWeight: FontWeight.w600))),
            if (locals.isEmpty)
              const Padding(padding: EdgeInsets.all(24), child: Text('No local projects to upload.', style: TextStyle(color: Ec.textMute)))
            else
              Flexible(
                child: ListView(
                  shrinkWrap: true,
                  children: [
                    for (final p in locals)
                      ListTile(
                        title: Text(p.name, style: const TextStyle(color: Ec.text, fontSize: 14)),
                        onTap: () => Navigator.pop(context, p),
                      ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
    if (picked == null) return;
    await _runWithProgress((step) async {
      step('Loading project…');
      final doc = await Backend.loadProject(picked.id);
      if (doc == null) throw Exception('Could not load that project');
      await Cowork.shareProject(id, doc, picked.name, folderId: _folder, onStep: step);
      await _reload();
    });
    _toast('“${picked.name}” uploaded.');
  }

  Future<void> _newFolder() async {
    final id = _spaceId;
    if (id == null) return;
    final name = await _prompt('New folder', hint: 'Folder name');
    if (name == null || name.isEmpty) return;
    try {
      final f = await Cowork.createFolder(id, name);
      await _reload();
      if (mounted) setState(() => _folder = f.id);
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _renameFolder(SpaceFolder f) async {
    final name = await _prompt('Rename folder', initial: f.name);
    if (name == null || name.isEmpty) return;
    try {
      await Cowork.renameFolder(f.id, name);
      await _reload();
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _deleteFolder(SpaceFolder f) async {
    try {
      await Cowork.deleteFolder(f.id);
      if (_folder == f.id) setState(() => _folder = null);
      await _reload();
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _moveProject(CoworkProject cp) async {
    final target = await showModalBottomSheet<Object?>(
      context: context,
      backgroundColor: Ec.sheet,
      builder: (_) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Padding(padding: EdgeInsets.all(16), child: Text('Move to folder', style: TextStyle(color: Ec.text, fontSize: 15, fontWeight: FontWeight.w600))),
            ListTile(
              leading: const Icon(Icons.inbox_outlined, color: Ec.textMute, size: 20),
              title: const Text('No folder', style: TextStyle(color: Ec.text, fontSize: 14)),
              onTap: () => Navigator.pop(context, '__none'),
            ),
            for (final f in _folders)
              ListTile(
                leading: const Icon(Icons.folder_outlined, color: Ec.indigoText, size: 20),
                title: Text(f.name, style: const TextStyle(color: Ec.text, fontSize: 14)),
                onTap: () => Navigator.pop(context, f.id),
              ),
          ],
        ),
      ),
    );
    if (target == null) return;
    try {
      await Cowork.moveProjectToFolder(cp.id, target == '__none' ? null : target as String);
      await _reload();
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _newSpace() async {
    final name = await _prompt('New space', hint: 'Space name');
    if (name == null) return;
    try {
      final s = await Cowork.createSpace(name);
      await _reloadSpaces();
      setState(() {
        _spaceId = s.id;
        _folder = null;
      });
      await _reload();
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _spaceMenu(String v) async {
    final sp = _space;
    if (sp == null) return;
    switch (v) {
      case 'rename':
        final name = await _prompt('Rename space', initial: sp.name);
        if (name != null && name.isNotEmpty) {
          await Cowork.renameSpace(sp.id, name);
          await _reloadSpaces();
        }
        break;
      case 'delete':
        final ok = await _confirm('Delete “${sp.name}” and everything in it?');
        if (ok) {
          await Cowork.deleteSpace(sp.id);
          await _reloadSpaces();
          setState(() {
            _spaceId = _spaces.isNotEmpty ? _spaces.first.id : null;
            _folder = null;
          });
          await _reload();
        }
        break;
      case 'members':
        await _showMembers();
        break;
      case 'join':
        await _join();
        break;
      case 'newfolder':
        await _newFolder();
        break;
    }
  }

  Future<bool> _confirm(String msg) async {
    final r = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        content: Text(msg, style: const TextStyle(color: Ec.textDim)),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context, false), child: const Text('Cancel', style: TextStyle(color: Ec.textMute))),
          TextButton(onPressed: () => Navigator.pop(context, true), child: const Text('Delete', style: TextStyle(color: Color(0xFFFF9B9B)))),
        ],
      ),
    );
    return r == true;
  }

  Future<void> _join() async {
    final key = await _prompt('Join a space', hint: 'Space key');
    if (key == null || key.isEmpty) return;
    try {
      final res = await Cowork.requestJoinByKey(key);
      _toast(res == 'already_member'
          ? 'You’re already a member.'
          : res == 'pending'
              ? 'You already have a request waiting.'
              : 'Request sent — the owner needs to approve you.');
    } catch (e) {
      _toast(_err(e));
    }
  }

  Future<void> _showMembers() async {
    final id = _spaceId;
    final sp = _space;
    if (id == null || sp == null) return;
    await showModalBottomSheet(
      context: context,
      backgroundColor: Ec.sheet,
      isScrollControlled: true,
      builder: (_) => _MembersSheet(spaceId: id, joinKey: sp.joinKey, isOwner: _isOwner, onChanged: _reload),
    );
  }

  @override
  Widget build(BuildContext context) {
    final visible = _folder == null ? _projects : _projects.where((p) => p.folderId == _folder).toList();
    final pct = _quota > 0 ? (_used / _quota * 100).clamp(0, 100).round() : 0;
    return Scaffold(
      backgroundColor: Ec.bg,
      appBar: AppBar(
        backgroundColor: Ec.bg,
        elevation: 0,
        title: Row(
          children: [
            const Text('Cowork', style: TextStyle(color: Ec.text, fontSize: 17, fontWeight: FontWeight.w700)),
            const SizedBox(width: 10),
            if (_spaces.length > 1)
              DropdownButton<String>(
                value: _spaceId,
                dropdownColor: Ec.card,
                underline: const SizedBox.shrink(),
                iconEnabledColor: Ec.textMute,
                style: const TextStyle(color: Ec.textDim, fontSize: 13),
                items: [for (final s in _spaces) DropdownMenuItem(value: s.id, child: Text(s.name))],
                onChanged: (v) async {
                  setState(() {
                    _spaceId = v;
                    _folder = null;
                  });
                  await _reload();
                },
              ),
          ],
        ),
        actions: [
          IconButton(icon: const Icon(Icons.cloud_upload_outlined, color: Ec.textDim), tooltip: 'Upload a project', onPressed: _share),
          PopupMenuButton<String>(
            color: Ec.card,
            icon: const Icon(Icons.more_vert, color: Ec.textDim),
            onSelected: _spaceMenu,
            itemBuilder: (_) => [
              const PopupMenuItem(value: 'newfolder', child: Text('New folder', style: TextStyle(color: Ec.text))),
              const PopupMenuItem(value: 'members', child: Text('Members & key', style: TextStyle(color: Ec.text))),
              const PopupMenuItem(value: 'join', child: Text('Join a space', style: TextStyle(color: Ec.text))),
              if (_isOwner) const PopupMenuItem(value: 'rename', child: Text('Rename space', style: TextStyle(color: Ec.text))),
              if (_isOwner) const PopupMenuItem(value: 'delete', child: Text('Delete space', style: TextStyle(color: Color(0xFFFF9B9B)))),
            ],
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        backgroundColor: Ec.indigo,
        onPressed: _newSpace,
        icon: const Icon(Icons.add, color: Colors.white),
        label: const Text('New space', style: TextStyle(color: Colors.white)),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator(color: Ec.indigo))
          : _error != null
              ? Center(child: Text(_error!, style: const TextStyle(color: Ec.textFaint)))
              : _space == null
                  ? const Center(child: Text('No space selected.', style: TextStyle(color: Ec.textMute)))
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Padding(
                          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                          child: Row(children: [
                            Text('Storage', style: const TextStyle(color: Ec.textDim, fontSize: 12.5, fontWeight: FontWeight.w600)),
                            const SizedBox(width: 8),
                            Text('${_fmtBytes(_used)} of ${_fmtBytes(_quota)} · $pct%', style: const TextStyle(color: Ec.textMute, fontSize: 11.5)),
                          ]),
                        ),
                        SizedBox(
                          height: 44,
                          child: ListView(
                            scrollDirection: Axis.horizontal,
                            padding: const EdgeInsets.symmetric(horizontal: 12),
                            children: [
                              _chip('All', _folder == null, () => setState(() => _folder = null)),
                              for (final f in _folders)
                                _chip(f.name, _folder == f.id, () => setState(() => _folder = f.id),
                                    onLong: () => _folderMenu(f)),
                              GestureDetector(
                                onTap: _newFolder,
                                child: Container(
                                  margin: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
                                  padding: const EdgeInsets.symmetric(horizontal: 12),
                                  alignment: Alignment.center,
                                  decoration: BoxDecoration(borderRadius: BorderRadius.circular(9), border: Border.all(color: Ec.border)),
                                  child: const Text('+ Folder', style: TextStyle(color: Ec.textMute, fontSize: 12.5)),
                                ),
                              ),
                            ],
                          ),
                        ),
                        Expanded(
                          child: visible.isEmpty
                              ? Center(
                                  child: Text(
                                    _folder != null ? 'This folder is empty.' : 'No shared projects yet — upload one with ☁.',
                                    style: const TextStyle(color: Ec.textMute, fontSize: 13),
                                  ),
                                )
                              : ListView.builder(
                                  padding: const EdgeInsets.fromLTRB(12, 6, 12, 90),
                                  itemCount: visible.length,
                                  itemBuilder: (_, i) => _projectTile(visible[i]),
                                ),
                        ),
                      ],
                    ),
    );
  }

  Widget _chip(String label, bool active, VoidCallback onTap, {VoidCallback? onLong}) {
    return GestureDetector(
      onTap: onTap,
      onLongPress: onLong,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 8, horizontal: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: active ? Ec.indigoTint : Colors.transparent,
          borderRadius: BorderRadius.circular(9),
          border: Border.all(color: active ? Ec.indigo : Ec.border),
        ),
        child: Text(label, style: TextStyle(color: active ? Ec.indigoText : Ec.textDim, fontSize: 12.5)),
      ),
    );
  }

  void _folderMenu(SpaceFolder f) {
    showModalBottomSheet(
      context: context,
      backgroundColor: Ec.sheet,
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ListTile(leading: const Icon(Icons.edit_outlined, color: Ec.textDim, size: 20), title: const Text('Rename folder', style: TextStyle(color: Ec.text)), onTap: () { Navigator.pop(context); _renameFolder(f); }),
          ListTile(leading: const Icon(Icons.delete_outline, color: Color(0xFFFF9B9B), size: 20), title: const Text('Delete folder', style: TextStyle(color: Color(0xFFFF9B9B))), onTap: () { Navigator.pop(context); _deleteFolder(f); }),
        ]),
      ),
    );
  }

  Widget _projectTile(CoworkProject p) {
    return Container(
      margin: const EdgeInsets.only(bottom: 9),
      padding: const EdgeInsets.fromLTRB(14, 12, 10, 12),
      decoration: BoxDecoration(color: Ec.card2, borderRadius: BorderRadius.circular(11), border: Border.all(color: Ec.border)),
      child: Row(children: [
        Container(
          width: 34, height: 34,
          decoration: BoxDecoration(color: Ec.indigoTint, borderRadius: BorderRadius.circular(9)),
          child: const Icon(Icons.movie_outlined, color: Ec.indigoText, size: 18),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(p.name, maxLines: 1, overflow: TextOverflow.ellipsis, style: const TextStyle(color: Ec.text, fontSize: 14, fontWeight: FontWeight.w500)),
            const SizedBox(height: 3),
            Text('${_fmtBytes(p.mediaBytes)} · ${_rel(p.updatedAt)}', style: const TextStyle(color: Ec.textFaint, fontSize: 11.5)),
          ]),
        ),
        TextButton(onPressed: () => _open(p), child: const Text('Open', style: TextStyle(color: Ec.indigoText, fontWeight: FontWeight.w600))),
        GestureDetector(onTap: () => _moveProject(p), child: const Padding(padding: EdgeInsets.all(6), child: Icon(Icons.drive_file_move_outline, color: Ec.textMute, size: 18))),
      ]),
    );
  }
}

/// Members + join key + invite + pending requests, in a bottom sheet.
class _MembersSheet extends StatefulWidget {
  final String spaceId;
  final String joinKey;
  final bool isOwner;
  final Future<void> Function() onChanged;
  const _MembersSheet({required this.spaceId, required this.joinKey, required this.isOwner, required this.onChanged});

  @override
  State<_MembersSheet> createState() => _MembersSheetState();
}

class _MembersSheetState extends State<_MembersSheet> {
  List<Member> _members = [];
  List<JoinRequest> _requests = [];
  final _invite = TextEditingController();
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final m = await Cowork.listMembers(widget.spaceId);
      final r = widget.isOwner ? await Cowork.listJoinRequests(widget.spaceId) : <JoinRequest>[];
      if (mounted) setState(() { _members = m; _requests = r; _loading = false; });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String m) {
    if (!AppSettings.showStatusMessages) return;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(m), backgroundColor: Ec.card));
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: EdgeInsets.only(left: 18, right: 18, top: 16, bottom: MediaQuery.of(context).viewInsets.bottom + 16),
        child: _loading
            ? const Padding(padding: EdgeInsets.all(30), child: Center(child: CircularProgressIndicator(color: Ec.indigo)))
            : SingleChildScrollView(
                child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                  Row(children: [
                    const Text('Members', style: TextStyle(color: Ec.text, fontSize: 16, fontWeight: FontWeight.w600)),
                    const Spacer(),
                    GestureDetector(
                      onTap: () { Clipboard.setData(ClipboardData(text: widget.joinKey)); _toast('Key copied'); },
                      child: Container(
                        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                        decoration: BoxDecoration(color: Ec.indigoTint, borderRadius: BorderRadius.circular(7), border: Border.all(color: Ec.indigo)),
                        child: Text('Key: ${widget.joinKey}  ⧉', style: const TextStyle(color: Ec.indigoText, fontSize: 12)),
                      ),
                    ),
                  ]),
                  const SizedBox(height: 14),
                  if (widget.isOwner && _requests.isNotEmpty) ...[
                    const Text('Requests to join', style: TextStyle(color: Ec.indigoText, fontSize: 12.5, fontWeight: FontWeight.w600)),
                    const SizedBox(height: 8),
                    for (final r in _requests)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(children: [
                          Expanded(child: Text(r.username.isNotEmpty ? '@${r.username}' : r.name, style: const TextStyle(color: Ec.text, fontSize: 13.5))),
                          TextButton(onPressed: () async { await Cowork.decideJoinRequest(r.id, true); await _load(); await widget.onChanged(); }, child: const Text('Approve', style: TextStyle(color: Ec.green))),
                          TextButton(onPressed: () async { await Cowork.decideJoinRequest(r.id, false); await _load(); }, child: const Text('Decline', style: TextStyle(color: Ec.textMute))),
                        ]),
                      ),
                    const SizedBox(height: 10),
                  ],
                  for (final m in _members)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 8),
                      child: Row(children: [
                        Expanded(
                          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                            Text(m.username.isNotEmpty ? '@${m.username}' : m.name, style: const TextStyle(color: Ec.text, fontSize: 13.5)),
                            if (m.email.isNotEmpty) Text(m.email, style: const TextStyle(color: Ec.textFaint, fontSize: 11)),
                          ]),
                        ),
                        Container(
                          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                          decoration: BoxDecoration(color: Ec.indigoTint, borderRadius: BorderRadius.circular(20)),
                          child: Text(m.role, style: const TextStyle(color: Ec.indigoText, fontSize: 10.5)),
                        ),
                        if (widget.isOwner && m.role != 'owner')
                          GestureDetector(onTap: () async { await Cowork.removeMember(widget.spaceId, m.userId); await _load(); await widget.onChanged(); }, child: const Padding(padding: EdgeInsets.only(left: 8), child: Icon(Icons.close, color: Ec.textMute, size: 16))),
                      ]),
                    ),
                  if (widget.isOwner) ...[
                    const SizedBox(height: 8),
                    Row(children: [
                      Expanded(
                        child: TextField(
                          controller: _invite,
                          style: const TextStyle(color: Ec.text, fontSize: 13),
                          decoration: const InputDecoration(hintText: 'Invite by @username or email', hintStyle: TextStyle(color: Ec.textFaint)),
                        ),
                      ),
                      TextButton(
                        onPressed: () async {
                          try {
                            await Cowork.inviteMember(widget.spaceId, _invite.text);
                            _invite.clear();
                            _toast('Invite sent (in-app).');
                          } catch (e) {
                            _toast(e.toString().replaceFirst('Exception: ', ''));
                          }
                        },
                        child: const Text('Invite', style: TextStyle(color: Ec.indigoText)),
                      ),
                    ]),
                    const Text('Invites appear in-app for people with an EaseCut account. For others, share the space key.', style: TextStyle(color: Ec.textFaint, fontSize: 11)),
                  ],
                ]),
              ),
      ),
    );
  }
}
