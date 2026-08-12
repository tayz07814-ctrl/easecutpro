import 'package:flutter/material.dart';

import '../editor/silence_settings.dart';
import '../local/app_settings.dart';
import '../theme.dart';
import '../widgets/controls.dart';
import 'sheet_scaffold.dart';

/// App settings — preferences that outlive a project. Changes persist
/// immediately via [AppSettings.save].
class SettingsSheet extends StatefulWidget {
  const SettingsSheet({super.key});

  @override
  State<SettingsSheet> createState() => _SettingsSheetState();
}

class _SettingsSheetState extends State<SettingsSheet> {
  void _commit(VoidCallback change) {
    setState(change);
    AppSettings.save();
  }

  Widget _sectionTitle(String s) => Padding(
        padding: const EdgeInsets.fromLTRB(2, 16, 2, 8),
        child: Text(s,
            style: const TextStyle(
                color: Ec.textFaint, fontSize: 10.5, fontWeight: FontWeight.w700, letterSpacing: 0.6)),
      );

  /// A segmented picker — one row of mutually exclusive chips.
  Widget _seg(List<String> labels, int active, ValueChanged<int> onPick) {
    return Row(
      children: [
        for (int i = 0; i < labels.length; i++) ...[
          if (i > 0) const SizedBox(width: 7),
          Expanded(
            child: GestureDetector(
              onTap: () => onPick(i),
              behavior: HitTestBehavior.opaque,
              child: Container(
                padding: const EdgeInsets.symmetric(vertical: 11),
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: i == active ? Ec.indigo.withValues(alpha: 0.16) : Ec.card2,
                  borderRadius: BorderRadius.circular(10),
                  border: Border.all(
                    color: i == active ? Ec.indigo.withValues(alpha: 0.6) : Ec.hair,
                    width: i == active ? 1.5 : 1,
                  ),
                ),
                child: Text(labels[i],
                    style: TextStyle(
                        color: i == active ? Ec.indigoText : Ec.textDim,
                        fontSize: 12.5,
                        fontWeight: i == active ? FontWeight.w700 : FontWeight.w500)),
              ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _hint(String s) => Padding(
        padding: const EdgeInsets.only(top: 7),
        child: Text(s, style: const TextStyle(color: Ec.textFaint, fontSize: 11, height: 1.45)),
      );

  @override
  Widget build(BuildContext context) {
    final transcriptEngine = AppSettings.silenceEngine == SilenceEngineKind.transcript;
    return SheetScaffold(
      title: 'Settings',
      heightFactor: 0.86,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
        children: [
          // ---- Transcription -------------------------------------------
          _sectionTitle('TRANSCRIPTION PROVIDER'),
          _seg(
            const ['Automatic', 'AssemblyAI', 'Deepgram'],
            AppSettings.sttProvider.index,
            (i) => _commit(() => AppSettings.sttProvider = SttProvider.values[i]),
          ),
          _hint(switch (AppSettings.sttProvider) {
            SttProvider.auto =>
              'Uses whichever provider the server has configured, AssemblyAI first.',
            SttProvider.assemblyai =>
              'AssemblyAI transcribes; Deepgram stays as a fallback if it is unavailable.',
            SttProvider.deepgram =>
              'Deepgram transcribes; AssemblyAI stays as a fallback if it is unavailable.',
          }),

          // ---- Silence engine ------------------------------------------
          _sectionTitle('SILENCE ENGINE'),
          _seg(
            const ['Silero VAD', 'Transcript'],
            transcriptEngine ? 1 : 0,
            (i) => _commit(() => AppSettings.silenceEngine =
                i == 0 ? SilenceEngineKind.silero : SilenceEngineKind.transcript),
          ),
          _hint(transcriptEngine
              ? 'Keeps every word timestamp and removes everything else. No audio '
                  'analysis, so it is instant and can never mishear — but it is only '
                  'as good as the transcript.'
              : 'Listens to the audio and cuts what it hears as silence — the same '
                  'engine the web app runs. Shaped by the presets in Silence Settings.'),

          if (transcriptEngine) ...[
            const SizedBox(height: 4),
            EcSliderRow(
              label: 'Minimum speech',
              valueLabel: '${(AppSettings.minSpeechS * 1000).round()}ms',
              value: AppSettings.minSpeechS,
              min: 0,
              max: 1,
              onChanged: (v) => _commit(() => AppSettings.minSpeechS = v),
            ),
            _hint('A kept island shorter than this is treated as a stray timestamp '
                'and dropped, so a mis-stamped word can\'t leave a fragment spliced '
                'into the edit.'),
            EcSliderRow(
              label: 'Padding around speech',
              valueLabel: '${AppSettings.transcriptPadMs}ms',
              value: AppSettings.transcriptPadMs.toDouble(),
              min: 0,
              max: 500,
              onChanged: (v) => _commit(() => AppSettings.transcriptPadMs = (v / 10).round() * 10),
            ),
            _hint('Silence kept on BOTH sides of every word span, so onsets and '
                'tails breathe instead of landing hard on the first phoneme.'),
          ],

          // ---- Seams (both engines) ------------------------------------
          _sectionTitle('CUT SEAMS'),
          EcSliderRow(
            label: 'Cross-fade at cuts',
            valueLabel: AppSettings.crossFadeMs == 0 ? 'Hard cut' : '${AppSettings.crossFadeMs}ms',
            value: AppSettings.crossFadeMs.toDouble(),
            min: 0,
            max: 60,
            onChanged: (v) => _commit(() {
              AppSettings.crossFadeMs = v.round();
              SilenceSettings.seamOverlapMs = v.round(); // export reads this
            }),
          ),
          _hint('Blends the audio across every join on export. A few milliseconds '
              'removes the click a hard splice makes; too much smears the seam.'),

          // ---- Diagnostics ----------------------------------------------
          _sectionTitle('DIAGNOSTICS'),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
            decoration: BoxDecoration(
                color: Ec.card2, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.hair)),
            child: EcRow(
              label: 'Show status messages',
              trailing: EcToggle(
                value: AppSettings.showStatusMessages,
                onChanged: (v) => _commit(() => AppSettings.showStatusMessages = v),
              ),
            ),
          ),
          _hint('Off keeps the editor quiet. On brings back the banners that say '
              'which engine ran, which provider transcribed, and why anything fell '
              'back — turn it on when something misbehaves.'),

          // ---- About ----------------------------------------------------
          _sectionTitle('ABOUT'),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            decoration: BoxDecoration(
                color: Ec.card2, borderRadius: BorderRadius.circular(12), border: Border.all(color: Ec.hair)),
            child: Row(
              children: const [
                Icon(Icons.info_outline, size: 19, color: Ec.textMute),
                SizedBox(width: 12),
                Text('EaseCut', style: TextStyle(color: Ec.text, fontSize: 13.5)),
                Spacer(),
                Text('native', style: TextStyle(color: Ec.textFaint, fontSize: 12.5)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
