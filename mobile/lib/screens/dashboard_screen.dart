import 'package:flutter/material.dart';

import '../cloud/backend.dart';
import '../local/folders_store.dart';
import '../theme.dart';
import '../sheets/enhance_options.dart';
import '../sheets/new_project_wizard.dart';
import 'auth_screen.dart';
import 'batch_screen.dart';
import 'cowork_screen.dart';
import 'editor_screen.dart';

/// Home / dashboard (MobileDashboard.tsx) — now backed by the real Supabase
/// `projects` table (RLS owner-only): list / create / rename / delete + logout.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  List<ProjectMeta> _projects = [];
  bool _loading = true;
  String? _error;
  String _query = '';

  // Bottom-nav: 0 Projects · 1 Folders · 2 Cowork · 3 Batch. Tabs are lazily
  // built on first visit (so Cowork/Batch don't init until opened) and then kept
  // alive by the IndexedStack so their state survives tab switches.
  int _tab = 0;
  final Set<int> _visited = {0};

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// Reload the project list. [silent] keeps the current list visible (no spinner
  /// / error swap) — used when returning to the Projects tab after work elsewhere.
  Future<void> _load({bool silent = false}) async {
    setState(() {
      if (!silent) _loading = true;
      _error = null;
    });
    try {
      final list = await Backend.listProjects();
      if (mounted) setState(() { _projects = list; _loading = false; });
    } catch (e) {
      if (mounted) setState(() {
        if (!silent) _error = 'Couldn’t load projects. Pull to retry.';
        _loading = false;
      });
    }
  }

  void _selectTab(int i) {
    if (i == _tab) return;
    setState(() {
      _tab = i;
      _visited.add(i);
    });
    // Projects may have been created in Batch/Cowork — refresh without a flash.
    if (i == 0) _load(silent: true);
  }

  void _openEditor({
    String? clipPath,
    String? clipName,
    String? projectId,
    EnhanceOptions enhance = const EnhanceOptions(cutSilence: false),
  }) {
    Navigator.of(context)
        .push(MaterialPageRoute(
            builder: (_) => EditorScreen(
                initialClipPath: clipPath,
                initialClipName: clipName,
                projectId: projectId,
                enhanceCutSilence: enhance.cutSilence,
                enhanceCaptions: enhance.autoCaptions,
                enhanceAutoZoom: enhance.autoZoom)))
        .then((_) => _load());
  }

  void _newProject() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => NewProjectWizard(onCreate: (path, name, opts) async {
        Navigator.of(context).pop();
        String? id;
        try {
          final meta = await Backend.createProject(name ?? 'New project');
          id = meta.id;
        } catch (_) {}
        if (mounted) {
          _openEditor(clipPath: path, clipName: name, projectId: id, enhance: opts);
        }
      }),
    );
  }

  Future<void> _rename(ProjectMeta p) async {
    final ctrl = TextEditingController(text: p.name);
    final name = await showDialog<String>(
      context: context,
      builder: (_) => AlertDialog(
        backgroundColor: Ec.card,
        title: const Text('Rename project', style: TextStyle(color: Ec.text, fontSize: 16)),
        content: TextField(
          controller: ctrl,
          autofocus: true,
          style: const TextStyle(color: Ec.text),
          decoration: const InputDecoration(hintText: 'Project name', hintStyle: TextStyle(color: Ec.textFaint)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel', style: TextStyle(color: Ec.textMute))),
          TextButton(onPressed: () => Navigator.pop(context, ctrl.text.trim()), child: const Text('Save', style: TextStyle(color: Ec.indigoText))),
        ],
      ),
    );
    if (name == null || name.isEmpty) return;
    try {
      await Backend.renameProject(p.id, name);
      await _load();
    } catch (_) {}
  }

  Future<void> _delete(ProjectMeta p) async {
    setState(() => _projects.remove(p));
    try {
      await Backend.deleteProject(p.id);
    } catch (_) {
      _load();
    }
  }

  Future<void> _logout() async {
    await Backend.signOut();
    if (!mounted) return;
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const AuthScreen()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFF17181C),
      body: SafeArea(
        bottom: false,
        child: IndexedStack(
          index: _tab,
          children: [
            _projectsTab(),
            _visited.contains(1) ? _foldersTab() : const SizedBox.shrink(),
            _visited.contains(2) ? const CoworkScreen() : const SizedBox.shrink(),
            _visited.contains(3) ? _batchTab() : const SizedBox.shrink(),
          ],
        ),
      ),
      bottomNavigationBar: _bottomNav(),
    );
  }

  Widget _projectsTab() {
    final filtered = _query.isEmpty
        ? _projects
        : _projects.where((p) => p.name.toLowerCase().contains(_query.toLowerCase())).toList();
    final now = DateTime.now();
    return Column(
      children: [
        _topBar(),
        Expanded(
          child: RefreshIndicator(
            onRefresh: _load,
            color: Ec.indigo,
            backgroundColor: Ec.card,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 40),
              children: [
                _search(),
                const SizedBox(height: 20),
                const Text('Your projects',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Ec.text)),
                const SizedBox(height: 4),
                const Text('Saved automatically as you edit.',
                    style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
                const SizedBox(height: 16),
                _actionRow(),
                const SizedBox(height: 16),
                if (_loading)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 40),
                    child: Center(child: CircularProgressIndicator(color: Ec.indigo)),
                  )
                else if (_error != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 40),
                    child: Text(_error!, textAlign: TextAlign.center, style: const TextStyle(color: Ec.textFaint, fontSize: 13)),
                  )
                else if (filtered.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 40),
                    child: Text(
                      _query.isEmpty ? 'No projects yet — tap ＋ New project to start.' : 'No projects match “$_query”.',
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: Ec.textFaint, fontSize: 13),
                    ),
                  )
                else
                  ...filtered.map((p) => _projectCard(p, now)),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget _foldersTab() {
    return Column(
      children: [
        _topBar(),
        Expanded(child: _FoldersTab(onOpenProject: (id) => _openEditor(projectId: id))),
      ],
    );
  }

  Widget _batchTab() {
    return Column(
      children: [
        _topBar(),
        Expanded(child: BatchScreen(onFinished: () => _load(silent: true))),
      ],
    );
  }

  Widget _bottomNav() {
    return Container(
      decoration: const BoxDecoration(
        color: Color(0xFF17181C),
        border: Border(top: BorderSide(color: Ec.hair2)),
      ),
      child: SafeArea(
        top: false,
        child: SizedBox(
          height: 58,
          child: Row(
            children: [
              _navItem(0, Icons.video_library_outlined, Icons.video_library, 'Projects'),
              _navItem(1, Icons.folder_outlined, Icons.folder_rounded, 'Folders'),
              _navItem(2, Icons.groups_outlined, Icons.groups, 'Cowork'),
              _navItem(3, Icons.auto_fix_high_outlined, Icons.auto_fix_high, 'Batch'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _navItem(int index, IconData icon, IconData activeIcon, String label) {
    final active = _tab == index;
    final color = active ? Ec.indigoText : Ec.textFaint;
    return Expanded(
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () => _selectTab(index),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(active ? activeIcon : icon, size: 22, color: color),
            const SizedBox(height: 3),
            Text(label,
                style: TextStyle(
                    fontSize: 11, color: color, fontWeight: active ? FontWeight.w600 : FontWeight.w500)),
          ],
        ),
      ),
    );
  }

  Widget _topBar() {
    return Container(
      height: 54,
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: const BoxDecoration(border: Border(bottom: BorderSide(color: Ec.hair))),
      child: Row(
        children: [
          Container(
            width: 22,
            height: 22,
            decoration: BoxDecoration(color: Ec.indigo, borderRadius: BorderRadius.circular(6)),
            alignment: Alignment.center,
            child: Transform.rotate(angle: 0.785398, child: Container(width: 8, height: 8, color: Colors.white)),
          ),
          const SizedBox(width: 9),
          const Text('Easecut',
              style: TextStyle(fontSize: 17, fontWeight: FontWeight.w700, color: Ec.text, letterSpacing: -0.3)),
          const Spacer(),
          PopupMenuButton<String>(
            offset: const Offset(0, 44),
            color: const Color(0xFF262932),
            shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
            onSelected: (v) {
              if (v == 'logout') _logout();
            },
            itemBuilder: (_) => [
              PopupMenuItem(
                enabled: false,
                child: Text(Backend.email.isEmpty ? 'Signed in' : Backend.email,
                    style: const TextStyle(color: Ec.textMute, fontSize: 12)),
              ),
              const PopupMenuItem(value: 'logout', child: Text('Log out', style: TextStyle(color: Ec.text))),
            ],
            child: Container(
              width: 34,
              height: 34,
              decoration: const BoxDecoration(color: Color(0xFF33364A), shape: BoxShape.circle),
              alignment: Alignment.center,
              child: Text(_initials(),
                  style: const TextStyle(color: Ec.indigoText, fontSize: 12, fontWeight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }

  String _initials() {
    final e = Backend.email;
    if (e.isEmpty) return '·';
    final name = e.split('@').first;
    final parts = name.split(RegExp(r'[._-]'));
    if (parts.length >= 2 && parts[0].isNotEmpty && parts[1].isNotEmpty) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return name.substring(0, name.length >= 2 ? 2 : 1).toUpperCase();
  }

  Widget _search() {
    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.border)),
      child: Row(
        children: [
          const Icon(Icons.search, size: 18, color: Ec.textFaint),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              onChanged: (v) => setState(() => _query = v),
              style: const TextStyle(color: Ec.text, fontSize: 14),
              decoration: const InputDecoration(
                isDense: true,
                border: InputBorder.none,
                hintText: 'Search projects',
                hintStyle: TextStyle(color: Ec.textFaint),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _actionRow() {
    return Row(
      children: [
        Expanded(
          child: GestureDetector(
            onTap: _newProject,
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Ec.indigo,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6))],
              ),
              child: const Text('＋ New project',
                  style: TextStyle(color: Colors.white, fontSize: 14.5, fontWeight: FontWeight.w600)),
            ),
          ),
        ),
        const SizedBox(width: 10),
        GestureDetector(
          onTap: () => _selectTab(3),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.border)),
            child: const Text('Batch', style: TextStyle(color: Ec.textDim, fontSize: 14.5)),
          ),
        ),
      ],
    );
  }

  Widget _projectCard(ProjectMeta p, DateTime now) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GestureDetector(
        onTap: () => _openEditor(projectId: p.id),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(13), border: Border.all(color: Ec.border)),
          child: Row(
            children: [
              Container(
                width: 76,
                height: 50,
                decoration: BoxDecoration(color: Ec.chip, borderRadius: BorderRadius.circular(8)),
                alignment: Alignment.center,
                child: const Icon(Icons.play_arrow, color: Ec.textFaint, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Ec.text, fontSize: 14, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 2),
                    Text(p.relative(now), style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 12)),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                icon: const Icon(Icons.more_horiz, color: Ec.textFaint, size: 20),
                color: const Color(0xFF262932),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onSelected: (v) {
                  if (v == 'rename') _rename(p);
                  if (v == 'delete') _delete(p);
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'rename', child: Text('Rename', style: TextStyle(color: Ec.text))),
                  const PopupMenuItem(value: 'delete', child: Text('Delete', style: TextStyle(color: Color(0xFFD9686E)))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// "Folders" tab — organize existing projects into on-device folders (persisted
/// via [LocalFolders]/SharedPreferences). Two views: a folder list and, when a
/// folder is opened, the projects filed inside it.
class _FoldersTab extends StatefulWidget {
  final void Function(String projectId) onOpenProject;
  const _FoldersTab({required this.onOpenProject});

  @override
  State<_FoldersTab> createState() => _FoldersTabState();
}

class _FoldersTabState extends State<_FoldersTab> {
  final LocalFolders _store = LocalFolders();
  List<ProjectMeta> _projects = [];
  bool _loading = true;
  String? _openId; // opened folder (detail view); null = folder list

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    await _store.load();
    try {
      _projects = await Backend.listProjects();
    } catch (_) {}
    if (mounted) setState(() => _loading = false);
  }

  ProjectMeta? _project(String id) {
    for (final p in _projects) {
      if (p.id == id) return p;
    }
    return null;
  }

  Future<String?> _prompt(String title, {String? initial}) {
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
          decoration: const InputDecoration(hintText: 'Folder name', hintStyle: TextStyle(color: Ec.textFaint)),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel', style: TextStyle(color: Ec.textMute))),
          TextButton(onPressed: () => Navigator.pop(context, ctrl.text.trim()), child: const Text('Save', style: TextStyle(color: Ec.indigoText))),
        ],
      ),
    );
  }

  Future<void> _newFolder() async {
    final name = await _prompt('New folder');
    if (name == null || name.isEmpty) return;
    await _store.create(name);
    if (mounted) setState(() {});
  }

  Future<void> _renameFolder(LocalFolder f) async {
    final name = await _prompt('Rename folder', initial: f.name);
    if (name == null || name.isEmpty) return;
    await _store.rename(f.id, name);
    if (mounted) setState(() {});
  }

  Future<void> _deleteFolder(LocalFolder f) async {
    await _store.delete(f.id);
    if (mounted) setState(() { if (_openId == f.id) _openId = null; });
  }

  Future<void> _assignSheet(String folderId) async {
    await showModalBottomSheet(
      context: context,
      backgroundColor: Ec.sheet,
      isScrollControlled: true,
      builder: (_) => StatefulBuilder(
        builder: (ctx, setSheet) => SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Padding(
                padding: EdgeInsets.all(16),
                child: Text('Add projects to this folder',
                    style: TextStyle(color: Ec.text, fontSize: 15, fontWeight: FontWeight.w600)),
              ),
              if (_projects.isEmpty)
                const Padding(padding: EdgeInsets.all(24), child: Text('No projects yet.', style: TextStyle(color: Ec.textMute)))
              else
                Flexible(
                  child: ListView(
                    shrinkWrap: true,
                    children: [
                      for (final p in _projects)
                        CheckboxListTile(
                          value: _store.folderOf(p.id) == folderId,
                          activeColor: Ec.indigo,
                          checkColor: Colors.white,
                          controlAffinity: ListTileControlAffinity.leading,
                          title: Text(p.name, style: const TextStyle(color: Ec.text, fontSize: 14)),
                          subtitle: (_store.folderOf(p.id) != null && _store.folderOf(p.id) != folderId)
                              ? const Text('Currently in another folder', style: TextStyle(color: Ec.textFaint, fontSize: 11))
                              : null,
                          onChanged: (v) async {
                            await _store.assign(p.id, v == true ? folderId : null);
                            setSheet(() {});
                            if (mounted) setState(() {});
                          },
                        ),
                    ],
                  ),
                ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Center(child: CircularProgressIndicator(color: Ec.indigo));
    }
    return _openId == null ? _folderList() : _folderDetail(_openId!);
  }

  Widget _folderList() {
    final folders = _store.folders;
    return RefreshIndicator(
      onRefresh: _load,
      color: Ec.indigo,
      backgroundColor: Ec.card,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 18, 16, 40),
        children: [
          const Text('Folders', style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Ec.text)),
          const SizedBox(height: 4),
          const Text('Group your projects on this device.',
              style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
          const SizedBox(height: 16),
          GestureDetector(
            onTap: _newFolder,
            child: Container(
              padding: const EdgeInsets.symmetric(vertical: 14),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: Ec.indigo,
                borderRadius: BorderRadius.circular(12),
                boxShadow: [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6))],
              ),
              child: const Text('＋ New folder',
                  style: TextStyle(color: Colors.white, fontSize: 14.5, fontWeight: FontWeight.w600)),
            ),
          ),
          const SizedBox(height: 16),
          if (folders.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 40),
              child: Text('No folders yet — create one to group your projects.',
                  textAlign: TextAlign.center, style: TextStyle(color: Ec.textFaint, fontSize: 13)),
            )
          else
            ...folders.map(_folderCard),
        ],
      ),
    );
  }

  Widget _folderCard(LocalFolder f) {
    final count = _store.projectIdsIn(f.id).where((id) => _project(id) != null).length;
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GestureDetector(
        onTap: () => setState(() => _openId = f.id),
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(13), border: Border.all(color: Ec.border)),
          child: Row(
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(color: Ec.indigoTint, borderRadius: BorderRadius.circular(10)),
                child: const Icon(Icons.folder_rounded, color: Ec.indigoText, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(f.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Ec.text, fontSize: 14, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 2),
                    Text('$count ${count == 1 ? 'project' : 'projects'}',
                        style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 12)),
                  ],
                ),
              ),
              PopupMenuButton<String>(
                icon: const Icon(Icons.more_horiz, color: Ec.textFaint, size: 20),
                color: const Color(0xFF262932),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onSelected: (v) {
                  if (v == 'rename') _renameFolder(f);
                  if (v == 'delete') _deleteFolder(f);
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'rename', child: Text('Rename', style: TextStyle(color: Ec.text))),
                  const PopupMenuItem(value: 'delete', child: Text('Delete', style: TextStyle(color: Color(0xFFD9686E)))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _folderDetail(String folderId) {
    final matches = _store.folders.where((f) => f.id == folderId);
    if (matches.isEmpty) return _folderList(); // folder was deleted — fall back
    final folder = matches.first;
    final projects = _store.projectIdsIn(folderId).map(_project).whereType<ProjectMeta>().toList();
    final now = DateTime.now();
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 40),
      children: [
        Row(
          children: [
            GestureDetector(
              onTap: () => setState(() => _openId = null),
              child: const Padding(
                padding: EdgeInsets.only(right: 8, top: 4, bottom: 4),
                child: Icon(Icons.arrow_back, color: Ec.textDim, size: 22),
              ),
            ),
            Expanded(
              child: Text(folder.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: Ec.text)),
            ),
            GestureDetector(
              onTap: () => _assignSheet(folderId),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                decoration: BoxDecoration(
                  color: Ec.indigoTint,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(color: Ec.indigo),
                ),
                child: const Text('Add', style: TextStyle(color: Ec.indigoText, fontSize: 13, fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        if (projects.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(vertical: 40),
            child: Text('This folder is empty — tap Add to file projects here.',
                textAlign: TextAlign.center, style: TextStyle(color: Ec.textFaint, fontSize: 13)),
          )
        else
          ...projects.map((p) => _projectRow(p, now)),
      ],
    );
  }

  Widget _projectRow(ProjectMeta p, DateTime now) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GestureDetector(
        onTap: () => widget.onOpenProject(p.id),
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(13), border: Border.all(color: Ec.border)),
          child: Row(
            children: [
              Container(
                width: 76,
                height: 50,
                decoration: BoxDecoration(color: Ec.chip, borderRadius: BorderRadius.circular(8)),
                alignment: Alignment.center,
                child: const Icon(Icons.play_arrow, color: Ec.textFaint, size: 22),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(p.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(color: Ec.text, fontSize: 14, fontWeight: FontWeight.w500)),
                    const SizedBox(height: 2),
                    Text(p.relative(now), style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 12)),
                  ],
                ),
              ),
              GestureDetector(
                onTap: () async {
                  await _store.assign(p.id, null);
                  if (mounted) setState(() {});
                },
                child: const Padding(
                  padding: EdgeInsets.all(6),
                  child: Icon(Icons.remove_circle_outline, color: Ec.textFaint, size: 20),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
