import 'package:flutter/material.dart';

import '../cloud/backend.dart';
import '../theme.dart';
import '../sheets/new_project_wizard.dart';
import 'auth_screen.dart';
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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final list = await Backend.listProjects();
      if (mounted) setState(() { _projects = list; _loading = false; });
    } catch (e) {
      if (mounted) setState(() { _error = 'Couldn’t load projects. Pull to retry.'; _loading = false; });
    }
  }

  void _openEditor({String? clipPath, String? clipName, String? projectId}) {
    Navigator.of(context)
        .push(MaterialPageRoute(
            builder: (_) => EditorScreen(
                initialClipPath: clipPath, initialClipName: clipName, projectId: projectId)))
        .then((_) => _load());
  }

  void _newProject() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => NewProjectWizard(onCreate: (path, name) async {
        Navigator.of(context).pop();
        String? id;
        try {
          final meta = await Backend.createProject(name ?? 'New project');
          id = meta.id;
        } catch (_) {}
        if (mounted) _openEditor(clipPath: path, clipName: name, projectId: id);
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
    final filtered = _query.isEmpty
        ? _projects
        : _projects.where((p) => p.name.toLowerCase().contains(_query.toLowerCase())).toList();
    final now = DateTime.now();
    return Scaffold(
      backgroundColor: const Color(0xFF17181C),
      body: SafeArea(
        child: Column(
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
          onTap: () {},
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
