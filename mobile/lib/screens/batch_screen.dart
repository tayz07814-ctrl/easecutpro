import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../cloud/backend.dart';
import '../sheets/enhance_options.dart';
import '../theme.dart';
import 'editor_screen.dart';

enum _Status { queued, processing, done, error }

class _BatchItem {
  final String? path;
  final String name;
  _Status status;
  _BatchItem({required this.path, required this.name, this.status = _Status.queued});
}

/// Batch cleaning — pick several videos and run the same enhancements across all
/// of them. Adding videos asks which enhancements to run (cut silences / captions
/// / auto zoom), exactly like the New Project wizard does. Each item is driven
/// through the editor's enhance pipeline: we create a Supabase project for it,
/// then open the editor with those flags so the existing passes run. Items are
/// processed one at a time; when you finish (export / back out of) an item, the
/// next opens automatically.
///
/// Deferred: a fully-headless batch (running the cut pipeline with no editor UI)
/// isn't wired up — the enhance/cut logic currently lives inside EditorScreen, so
/// we reuse it by opening each clip there rather than reimplementing it here.
class BatchScreen extends StatefulWidget {
  /// Called once the queue finishes so the dashboard can refresh its project list.
  final VoidCallback? onFinished;
  const BatchScreen({super.key, this.onFinished});

  @override
  State<BatchScreen> createState() => _BatchScreenState();
}

class _BatchScreenState extends State<BatchScreen> {
  final List<_BatchItem> _items = [];
  bool _running = false;
  // What every queued clip gets. Asked for on each add (like the projects wizard)
  // and re-editable from the summary row.
  EnhanceOptions _opts = const EnhanceOptions();

  Future<void> _pick() async {
    final res = await FilePicker.pickFiles(type: FileType.video, allowMultiple: true);
    if (res == null || res.files.isEmpty) return;
    setState(() {
      for (final f in res.files) {
        _items.add(_BatchItem(path: f.path, name: f.name));
      }
    });
    if (!mounted) return;
    // Ask what to run on them — same question the New Project wizard asks.
    await _editOptions(confirmLabel: 'Add to queue');
  }

  /// Open the shared enhance-options sheet. Backing out keeps the current choice.
  Future<void> _editOptions({String confirmLabel = 'Save'}) async {
    final next = await showEnhanceOptions(
      context,
      initial: _opts,
      title: 'Enhance every clip',
      subtitle: 'Runs automatically on each video in the queue.',
      confirmLabel: confirmLabel,
    );
    if (next != null && mounted) setState(() => _opts = next);
  }

  void _remove(int i) {
    if (_running) return;
    setState(() => _items.removeAt(i));
  }

  Future<void> _cleanAll() async {
    if (_running || _items.isEmpty) return;
    setState(() => _running = true);
    for (final item in _items) {
      if (item.status == _Status.done) continue;
      if (item.path == null) {
        setState(() => item.status = _Status.error);
        continue;
      }
      setState(() => item.status = _Status.processing);
      String? projectId;
      try {
        final meta = await Backend.createProject(item.name);
        projectId = meta.id;
      } catch (_) {
        // Offline / no cloud project — still open locally so the clean can run.
      }
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => EditorScreen(
          initialClipPath: item.path,
          initialClipName: item.name,
          projectId: projectId,
          enhanceCutSilence: _opts.cutSilence,
          enhanceCaptions: _opts.autoCaptions,
          enhanceAutoZoom: _opts.autoZoom,
        ),
      ));
      if (!mounted) return;
      setState(() => item.status = _Status.done);
    }
    if (!mounted) return;
    setState(() => _running = false);
    widget.onFinished?.call();
  }

  @override
  Widget build(BuildContext context) {
    final pending = _items.where((e) => e.status != _Status.done).length;
    final canRun = !_running && pending > 0;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Expanded(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 20),
            children: [
              const Text('Batch cleaning',
                  style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600, color: Ec.text)),
              const SizedBox(height: 4),
              const Text('Enhance many clips in one go. Each opens in the editor and runs automatically.',
                  style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13)),
              const SizedBox(height: 16),
              GestureDetector(
                onTap: _running ? null : _pick,
                child: Container(
                  padding: const EdgeInsets.all(16),
                  decoration: BoxDecoration(
                    color: Ec.indigo.withValues(alpha: 0.08),
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: Ec.indigo.withValues(alpha: 0.5), width: 1.5),
                  ),
                  child: Center(
                    child: Text(
                      _items.isEmpty ? '＋ Select video files' : 'Add more videos',
                      style: const TextStyle(color: Ec.indigoText, fontSize: 14, fontWeight: FontWeight.w600),
                    ),
                  ),
                ),
              ),
              if (_items.isNotEmpty) ...[
                const SizedBox(height: 10),
                _optionsRow(),
              ],
              const SizedBox(height: 14),
              if (_items.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 40),
                  child: Text('No videos queued yet.',
                      textAlign: TextAlign.center, style: TextStyle(color: Ec.textFaint, fontSize: 13)),
                )
              else
                ..._items.asMap().entries.map((e) => _row(e.key, e.value)),
            ],
          ),
        ),
        if (_items.isNotEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: GestureDetector(
              onTap: canRun ? _cleanAll : null,
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 15),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: canRun ? Ec.indigo : const Color(0xFF2A2B33),
                  borderRadius: BorderRadius.circular(12),
                  boxShadow: canRun
                      ? [BoxShadow(color: Ec.indigo.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 6))]
                      : null,
                ),
                child: Text(
                  _running ? 'Cleaning…' : 'Clean all · $pending',
                  style: TextStyle(
                      color: canRun ? Colors.white : const Color(0xFF6B6F79),
                      fontSize: 14.5,
                      fontWeight: FontWeight.w600),
                ),
              ),
            ),
          ),
      ],
    );
  }

  /// What every queued clip will get, and a tap to change it.
  Widget _optionsRow() {
    return GestureDetector(
      onTap: _running ? null : _editOptions,
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
        decoration: BoxDecoration(
          color: Ec.indigo.withValues(alpha: 0.07),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: Ec.indigo.withValues(alpha: 0.28)),
        ),
        child: Row(
          children: [
            const Icon(Icons.auto_fix_high, size: 15, color: Ec.indigoText),
            const SizedBox(width: 9),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text('Runs on every clip',
                      style: TextStyle(color: Ec.textMute, fontSize: 10.5, fontWeight: FontWeight.w600)),
                  const SizedBox(height: 1),
                  Text(_opts.summary,
                      style: const TextStyle(color: Ec.text, fontSize: 12.5, fontWeight: FontWeight.w500)),
                ],
              ),
            ),
            if (!_running)
              const Text('Change', style: TextStyle(color: Ec.indigoText, fontSize: 12, fontWeight: FontWeight.w600)),
          ],
        ),
      ),
    );
  }

  Widget _row(int i, _BatchItem item) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 9),
      child: Container(
        padding: const EdgeInsets.fromLTRB(12, 11, 8, 11),
        decoration: BoxDecoration(color: Ec.card, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.border)),
        child: Row(
          children: [
            _statusIcon(item.status),
            const SizedBox(width: 11),
            Expanded(
              child: Text(item.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(color: Ec.text, fontSize: 13.5, fontWeight: FontWeight.w500)),
            ),
            const SizedBox(width: 8),
            Text(_statusLabel(item.status), style: TextStyle(color: _statusColor(item.status), fontSize: 11.5)),
            if (!_running && item.status != _Status.done)
              GestureDetector(
                onTap: () => _remove(i),
                child: const Padding(padding: EdgeInsets.only(left: 4), child: Icon(Icons.close, color: Ec.textFaint, size: 16)),
              ),
          ],
        ),
      ),
    );
  }

  Widget _statusIcon(_Status s) {
    switch (s) {
      case _Status.processing:
        return const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Ec.indigo));
      case _Status.done:
        return const Icon(Icons.check_circle, color: Ec.green, size: 20);
      case _Status.error:
        return const Icon(Icons.error_outline, color: Color(0xFFD9686E), size: 20);
      case _Status.queued:
        return const Icon(Icons.movie_outlined, color: Ec.textFaint, size: 20);
    }
  }

  String _statusLabel(_Status s) {
    switch (s) {
      case _Status.processing:
        return 'Cleaning…';
      case _Status.done:
        return 'Done';
      case _Status.error:
        return 'Skipped';
      case _Status.queued:
        return 'Queued';
    }
  }

  Color _statusColor(_Status s) {
    switch (s) {
      case _Status.processing:
        return Ec.indigoText;
      case _Status.done:
        return Ec.green;
      case _Status.error:
        return const Color(0xFFD9686E);
      case _Status.queued:
        return Ec.textFaint;
    }
  }
}
