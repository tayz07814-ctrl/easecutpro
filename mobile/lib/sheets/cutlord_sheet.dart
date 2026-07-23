import 'dart:async';

import 'package:flutter/material.dart';

import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// Cut Lord / Retake Cleaner (RetakeCleanerPanel.tsx). Full UI with idle →
/// analyzing → results states. The model buttons currently drive a local preview
/// of the flow; the real Cut Lord (procut-judge edge function) wires in next.
class CutLordSheet extends StatefulWidget {
  final VoidCallback onOpenSilence;
  const CutLordSheet({super.key, required this.onOpenSilence});

  @override
  State<CutLordSheet> createState() => _CutLordSheetState();
}

enum _St { idle, analyzing, results }

class _CutLordSheetState extends State<CutLordSheet> {
  _St _state = _St.idle;
  bool _smartSilence = true;
  double _pct = 0;
  Timer? _timer;

  static const _sample =
      'So today I want to show you — I want to show you this new feature. Um, it basically, '
      'it lets you cut all the dead air automatically. And, and the retakes too. Pretty cool right.';
  final Set<int> _cut = {3, 4, 12, 13, 14}; // struck-through words (preview)

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _run(String model) {
    setState(() {
      _state = _St.analyzing;
      _pct = 0;
    });
    _timer?.cancel();
    _timer = Timer.periodic(const Duration(milliseconds: 120), (t) {
      setState(() => _pct += 7);
      if (_pct >= 100) {
        t.cancel();
        setState(() => _state = _St.results);
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    return SheetScaffold(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 4, 18, 8),
            child: Row(
              children: [
                const Text('Retake Cleaner',
                    style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: Ec.text)),
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                  decoration: BoxDecoration(
                    color: Ec.indigo.withValues(alpha: 0.18),
                    borderRadius: BorderRadius.circular(5),
                  ),
                  child: const Text('BETA',
                      style: TextStyle(color: Ec.indigoText, fontSize: 9, fontWeight: FontWeight.w700)),
                ),
                const Spacer(),
                const Icon(Icons.more_horiz, color: Ec.textFaint, size: 20),
              ],
            ),
          ),
          Expanded(
            child: SingleChildScrollView(
              padding: const EdgeInsets.fromLTRB(18, 0, 18, 20),
              child: switch (_state) {
                _St.idle => _idle(),
                _St.analyzing => _analyzing(),
                _St.results => _results(),
              },
            ),
          ),
        ],
      ),
    );
  }

  Widget _idle() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text('Cleans up your video — removes silences, filler and bad takes.',
            style: TextStyle(color: Color(0xFF9BA0AC), fontSize: 13, height: 1.5)),
        const SizedBox(height: 16),
        Row(
          children: [
            _model('Retake Beta', const Color(0xFF6E6AE8), () => _run('retake')),
            const SizedBox(width: 8),
            _model('Ultracut Beta', const Color(0xFFE8843A), () => _run('ultracut')),
            const SizedBox(width: 8),
            _model('Premium Cut', const Color(0xFF2E9C6A), () => _run('premium')),
          ],
        ),
        const SizedBox(height: 10),
        const Text('Retake Beta = Opus · Ultracut = DeepSeek · Premium = Gemini (listens)',
            textAlign: TextAlign.center,
            style: TextStyle(color: Ec.textFaint, fontSize: 11)),
        const SizedBox(height: 16),
        GestureDetector(
          onTap: widget.onOpenSilence,
          child: Container(
            padding: const EdgeInsets.symmetric(vertical: 12),
            alignment: Alignment.center,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(10),
              border: Border.all(color: Ec.border),
            ),
            child: const Text('Silence Settings', style: TextStyle(color: Ec.textDim, fontSize: 13.5)),
          ),
        ),
        const SizedBox(height: 6),
        EcRow(
          label: 'Smart Silence Cutter',
          trailing: EcToggle(value: _smartSilence, onChanged: (v) => setState(() => _smartSilence = v)),
        ),
        const SizedBox(height: 8),
        _executeButton(enabled: false),
      ],
    );
  }

  Widget _analyzing() {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(color: Ec.card2, borderRadius: BorderRadius.circular(12)),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const Text('Analyzing your video', style: TextStyle(color: Ec.text, fontSize: 14)),
              Text('${_pct.clamp(0, 100).round()}%',
                  style: const TextStyle(color: Ec.indigoText, fontSize: 13)),
            ],
          ),
          const SizedBox(height: 12),
          ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: LinearProgressIndicator(
              value: (_pct / 100).clamp(0, 1),
              minHeight: 4,
              backgroundColor: const Color(0xFF2A2D36),
              valueColor: const AlwaysStoppedAnimation(Ec.indigo),
            ),
          ),
          const SizedBox(height: 10),
          const Text('Finding silences, filler words and retakes…',
              style: TextStyle(color: Ec.textFaint, fontSize: 12)),
        ],
      ),
    );
  }

  Widget _results() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            _stat('12 cuts', const Color(0xFFD9868B)),
            const SizedBox(width: 14),
            _stat('8 silence', const Color(0xFFD9A44A)),
            const SizedBox(width: 14),
            _stat('0:34 saved', const Color(0xFF46A57C)),
          ],
        ),
        const SizedBox(height: 14),
        _executeButton(enabled: true),
        const SizedBox(height: 6),
        EcRow(
          label: 'Smart Silence Cutter',
          trailing: EcToggle(value: _smartSilence, onChanged: (v) => setState(() => _smartSilence = v)),
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            const Text('Review transcript',
                style: TextStyle(color: Ec.textMute, fontSize: 12, fontWeight: FontWeight.w600)),
            const Spacer(),
            GestureDetector(
              onTap: () => setState(() => _state = _St.idle),
              child: const Text('Clear', style: TextStyle(color: Ec.textFaint, fontSize: 12)),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _transcript(),
      ],
    );
  }

  Widget _transcript() {
    final words = _sample.split(' ');
    return RichText(
      text: TextSpan(
        style: const TextStyle(fontSize: 13.5, height: 1.9, color: Ec.textDim),
        children: [
          for (int i = 0; i < words.length; i++)
            TextSpan(
              text: '${words[i]} ',
              style: _cut.contains(i)
                  ? const TextStyle(
                      color: Color(0xFFD9868B),
                      decoration: TextDecoration.lineThrough,
                      decorationColor: Color(0xFFD9868B))
                  : null,
            ),
        ],
      ),
    );
  }

  Widget _model(String label, Color c, VoidCallback onTap) {
    return Expanded(
      child: GestureDetector(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(vertical: 11),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: c,
            borderRadius: BorderRadius.circular(10),
            boxShadow: [BoxShadow(color: c.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 4))],
          ),
          child: Text(label,
              textAlign: TextAlign.center,
              style: const TextStyle(color: Colors.white, fontSize: 11, fontWeight: FontWeight.w600)),
        ),
      ),
    );
  }

  Widget _stat(String label, Color c) {
    return Text(label, style: TextStyle(color: c, fontSize: 13, fontWeight: FontWeight.w600));
  }

  Widget _executeButton({required bool enabled}) {
    return GestureDetector(
      onTap: enabled
          ? () => ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Execute cuts — wires to the timeline in the next build'), backgroundColor: Ec.card))
          : null,
      child: Container(
        padding: const EdgeInsets.symmetric(vertical: 14),
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: enabled ? Ec.indigo : const Color(0xFF22242B),
          borderRadius: BorderRadius.circular(12),
        ),
        child: Text(enabled ? 'Execute 12 cuts' : 'Execute cuts',
            style: TextStyle(
                color: enabled ? Colors.white : const Color(0xFF565C68),
                fontSize: 14,
                fontWeight: FontWeight.w700)),
      ),
    );
  }
}
