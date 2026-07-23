import 'dart:io';

import 'package:supabase_flutter/supabase_flutter.dart';

import 'edge.dart';

/// A transcribed word with source-timeline seconds.
class Word {
  final String text;
  final double start;
  final double end;
  Word(this.text, this.start, this.end);
}

typedef Progress = void Function(double pct, String msg);

/// Transcribe an audio file via the `stt` edge function (AssemblyAI → Deepgram),
/// mirroring cloud/stt.ts. Uploads to the private stt-audio bucket, transcribes,
/// then deletes the temp object.
Future<List<Word>> transcribe(String audioPath, {Progress? onProgress}) async {
  final client = Supabase.instance.client;
  final status = await invokeEdge('stt', {'action': 'status'});
  final providers = <String>[];
  if (status['assemblyai'] == true) providers.add('assemblyai');
  if (status['deepgram'] == true) providers.add('deepgram');
  if (providers.isEmpty) throw Exception('Transcription isn’t configured on the server.');

  final bytes = await File(audioPath).readAsBytes();
  Object? lastErr;
  for (final p in providers) {
    String? path;
    try {
      onProgress?.call(16, 'Uploading your audio…');
      final sign = await invokeEdge('stt', {'action': 'sign-upload', 'ext': 'm4a'});
      path = sign['path'] as String;
      final token = sign['token'] as String;
      await client.storage.from('stt-audio').uploadBinaryToSignedUrl(path, token, bytes);
      final words = p == 'assemblyai' ? await _aai(path, onProgress) : await _deepgram(path);
      invokeEdge('stt', {'action': 'cleanup', 'path': path}).ignore();
      if (words.isNotEmpty) return words;
    } catch (e) {
      lastErr = e;
      if (path != null) invokeEdge('stt', {'action': 'cleanup', 'path': path}).ignore();
    }
  }
  throw Exception('Transcription failed${lastErr != null ? ' ($lastErr)' : ''}.');
}

Future<List<Word>> _aai(String path, Progress? onProgress) async {
  final start = await invokeEdge('stt', {'action': 'aai-start', 'path': path});
  final id = start['id'] as String;
  var fails = 0;
  while (true) {
    await Future<void>.delayed(const Duration(milliseconds: 2500));
    Map<String, dynamic> t;
    try {
      t = await invokeEdge('stt', {'action': 'aai-poll', 'id': id});
    } catch (e) {
      if (++fails >= 8) rethrow;
      continue;
    }
    fails = 0;
    onProgress?.call(34, 'Transcribing every word…');
    final st = t['status'];
    if (st == 'error') throw Exception(t['error'] ?? 'Transcription failed.');
    if (st == 'completed') {
      final ws = (t['words'] as List?) ?? [];
      return ws.map((w) {
        final m = w as Map;
        return Word(
          (m['text'] as String).trim(),
          (m['start'] as num).toDouble() / 1000.0, // AssemblyAI = ms
          (m['end'] as num).toDouble() / 1000.0,
        );
      }).toList();
    }
  }
}

Future<List<Word>> _deepgram(String path) async {
  final r = await invokeEdge('stt', {'action': 'deepgram', 'path': path});
  final ws = (r['words'] as List?) ?? [];
  return ws.map((w) {
    final m = w as Map;
    final text = ((m['punctuated_word'] ?? m['word']) as String).trim();
    return Word(text, (m['start'] as num).toDouble(), (m['end'] as num).toDouble()); // Deepgram = seconds
  }).toList();
}
