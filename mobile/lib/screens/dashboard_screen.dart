import 'package:flutter/material.dart';

import '../theme.dart';
import '../sheets/new_project_wizard.dart';
import 'auth_screen.dart';
import 'editor_screen.dart';

class ProjectItem {
  final String id;
  String name;
  final String sub;
  final double? progress; // 0..1 while processing, null when ready
  ProjectItem(this.id, this.name, this.sub, {this.progress});
}

/// Home / dashboard (MobileDashboard.tsx). UI + navigation only for now; real
/// project sync (Supabase) is wired in the next pass.
class DashboardScreen extends StatefulWidget {
  const DashboardScreen({super.key});

  @override
  State<DashboardScreen> createState() => _DashboardScreenState();
}

class _DashboardScreenState extends State<DashboardScreen> {
  final List<ProjectItem> _projects = [
    ProjectItem('1', 'Gym reel — final', 'Edited 2h ago · 0:42'),
    ProjectItem('2', 'Podcast clip #7', 'Edited yesterday · 1:16'),
    ProjectItem('3', 'Store b-roll', 'Processing…', progress: 0.6),
  ];
  String _query = '';

  void _openEditor() {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => const EditorScreen()));
  }

  void _newProject() {
    showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: Colors.transparent,
      builder: (_) => NewProjectWizard(onCreate: () {
        Navigator.of(context).pop();
        _openEditor();
      }),
    );
  }

  void _logout() {
    Navigator.of(context).pushReplacement(MaterialPageRoute(builder: (_) => const AuthScreen()));
  }

  @override
  Widget build(BuildContext context) {
    final filtered = _query.isEmpty
        ? _projects
        : _projects.where((p) => p.name.toLowerCase().contains(_query.toLowerCase())).toList();
    return Scaffold(
      backgroundColor: const Color(0xFF17181C),
      body: SafeArea(
        child: Column(
          children: [
            _topBar(),
            Expanded(
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
                  if (filtered.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 40),
                      child: Text('No projects yet — tap ＋ New project to start.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: Ec.textFaint, fontSize: 13)),
                    )
                  else
                    ...filtered.map(_projectCard),
                ],
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
          // Logo mark: rounded indigo square + rotated white diamond
          Container(
            width: 22,
            height: 22,
            decoration: BoxDecoration(color: Ec.indigo, borderRadius: BorderRadius.circular(6)),
            alignment: Alignment.center,
            child: Transform.rotate(
              angle: 0.785398, // 45°
              child: Container(width: 8, height: 8, color: Colors.white),
            ),
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
              const PopupMenuItem(
                enabled: false,
                child: Text('tayz07814@gmail.com', style: TextStyle(color: Ec.textMute, fontSize: 12)),
              ),
              const PopupMenuItem(value: 'logout', child: Text('Log out', style: TextStyle(color: Ec.text))),
            ],
            child: Container(
              width: 34,
              height: 34,
              decoration: const BoxDecoration(color: Color(0xFF33364A), shape: BoxShape.circle),
              alignment: Alignment.center,
              child: const Text('TZ',
                  style: TextStyle(color: Ec.indigoText, fontSize: 12, fontWeight: FontWeight.w700)),
            ),
          ),
        ],
      ),
    );
  }

  Widget _search() {
    return Container(
      height: 44,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: BoxDecoration(
        color: Ec.card,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: Ec.border),
      ),
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
                boxShadow: [
                  BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6)),
                ],
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
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: Ec.border),
            ),
            child: const Text('Batch', style: TextStyle(color: Ec.textDim, fontSize: 14.5)),
          ),
        ),
      ],
    );
  }

  Widget _projectCard(ProjectItem p) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: GestureDetector(
        onTap: p.progress == null ? _openEditor : null,
        child: Container(
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: Ec.card,
            borderRadius: BorderRadius.circular(13),
            border: Border.all(color: Ec.border),
          ),
          child: Row(
            children: [
              Container(
                width: 76,
                height: 50,
                decoration: BoxDecoration(color: Ec.chip, borderRadius: BorderRadius.circular(8)),
                alignment: Alignment.center,
                child: p.progress == null
                    ? const Icon(Icons.play_arrow, color: Ec.textFaint, size: 22)
                    : Text('${(p.progress! * 100).round()}%',
                        style: const TextStyle(color: Ec.indigoText, fontSize: 13, fontWeight: FontWeight.w600)),
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
                    Text(p.sub, style: const TextStyle(color: Color(0xFF9BA0AC), fontSize: 12)),
                    if (p.progress != null) ...[
                      const SizedBox(height: 8),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(2),
                        child: LinearProgressIndicator(
                          value: p.progress,
                          minHeight: 3,
                          backgroundColor: Ec.chip,
                          valueColor: const AlwaysStoppedAnimation(Ec.indigo),
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              PopupMenuButton<String>(
                icon: const Icon(Icons.more_horiz, color: Ec.textFaint, size: 20),
                color: const Color(0xFF262932),
                shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
                onSelected: (v) {
                  if (v == 'delete') setState(() => _projects.remove(p));
                },
                itemBuilder: (_) => [
                  const PopupMenuItem(value: 'rename', child: Text('Rename', style: TextStyle(color: Ec.text))),
                  const PopupMenuItem(
                      value: 'delete', child: Text('Delete', style: TextStyle(color: Color(0xFFD9686E)))),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
