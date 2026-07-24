/// An imported audio track (music / voiceover) placed on the timeline.
/// [inMs]/[outMs] window the SOURCE; [timelineStartMs] is where it begins on the
/// timeline; [durMs] bounds trims to the real file length.
class AudioTrack {
  final String uri; // file://…
  String name;
  int inMs;
  int outMs;
  int durMs;
  int timelineStartMs;
  double volume; // 0..1 gain

  AudioTrack({
    required this.uri,
    required this.name,
    this.inMs = 0,
    required this.outMs,
    required this.durMs,
    this.timelineStartMs = 0,
    this.volume = 1.0,
  });

  int get lenMs => outMs > inMs ? outMs - inMs : 0;
  int get timelineEndMs => timelineStartMs + lenMs;

  AudioTrack copy() => AudioTrack(
        uri: uri,
        name: name,
        inMs: inMs,
        outMs: outMs,
        durMs: durMs,
        timelineStartMs: timelineStartMs,
        volume: volume,
      );

  Map<String, dynamic> toJson() => {
        'uri': uri,
        'name': name,
        'in': inMs,
        'out': outMs,
        'dur': durMs,
        'tl': timelineStartMs,
        'vol': volume,
      };

  factory AudioTrack.fromJson(Map j) {
    final out = (j['out'] as num?)?.toInt() ?? (j['endMs'] as num?)?.toInt() ?? 0;
    final dur = (j['dur'] as num?)?.toInt() ?? out;
    return AudioTrack(
      uri: (j['uri'] as String?) ?? '',
      name: (j['name'] as String?) ?? 'Audio',
      inMs: (j['in'] as num?)?.toInt() ?? (j['startMs'] as num?)?.toInt() ?? 0,
      outMs: out,
      durMs: dur > 0 ? dur : out,
      timelineStartMs: (j['tl'] as num?)?.toInt() ?? 0,
      volume: (j['vol'] as num?)?.toDouble() ?? 1.0,
    );
  }
}
