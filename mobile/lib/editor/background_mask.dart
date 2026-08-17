/// A foreground-alpha mask sampled at a local composition time.
/// The PNG is white/opaque for pixels to keep and transparent for pixels to remove.
class BackgroundMaskFrame {
  final int timeMs;
  final String path;

  const BackgroundMaskFrame(this.timeMs, this.path);

  Map<String, dynamic> toJson() => {'t': timeMs, 'p': path};

  factory BackgroundMaskFrame.fromJson(Map json) => BackgroundMaskFrame(
        (json['t'] as num?)?.toInt() ?? 0,
        json['p'] as String? ?? '',
      );
}

List<BackgroundMaskFrame> maskFramesFromJson(dynamic raw) {
  if (raw is! List) return const [];
  return [
    for (final item in raw)
      if (item is Map)
        BackgroundMaskFrame.fromJson(item).path.isNotEmpty
            ? BackgroundMaskFrame.fromJson(item)
            : const BackgroundMaskFrame(0, ''),
  ].where((m) => m.path.isNotEmpty).toList(growable: false);
}

String? nearestMaskPath(List<BackgroundMaskFrame> frames, int localMs) {
  if (frames.isEmpty) return null;
  var best = frames.first;
  var distance = (best.timeMs - localMs).abs();
  for (final frame in frames.skip(1)) {
    final nextDistance = (frame.timeMs - localMs).abs();
    if (nextDistance < distance) {
      best = frame;
      distance = nextDistance;
    }
  }
  return best.path.isEmpty ? null : best.path;
}
