import 'package:flutter/material.dart';

import '../theme.dart';

/// Toggle switch — 32×18 track, ON #6E6AE8 + white knob right, OFF #3A3E48 + grey knob.
class EcToggle extends StatelessWidget {
  final bool value;
  final ValueChanged<bool> onChanged;
  const EcToggle({super.key, required this.value, required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: () => onChanged(!value),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 140),
        width: 32,
        height: 18,
        padding: const EdgeInsets.all(2),
        decoration: BoxDecoration(
          color: value ? Ec.indigo : const Color(0xFF3A3E48),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Align(
          alignment: value ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              color: value ? Colors.white : const Color(0xFF9BA0AC),
              shape: BoxShape.circle,
            ),
          ),
        ),
      ),
    );
  }
}

/// Labelled slider row: label (left) · mono value (right) · track below.
class EcSliderRow extends StatelessWidget {
  final String label;
  final String valueLabel;
  final double value;
  final double min;
  final double max;
  final ValueChanged<double> onChanged;
  const EcSliderRow({
    super.key,
    required this.label,
    required this.valueLabel,
    required this.value,
    required this.min,
    required this.max,
    required this.onChanged,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(label, style: const TextStyle(color: Ec.textDim, fontSize: 13)),
            Text(valueLabel, style: const TextStyle(color: Ec.indigoText, fontSize: 12)),
          ],
        ),
        SliderTheme(
          data: SliderTheme.of(context).copyWith(
            trackHeight: 4,
            activeTrackColor: Ec.indigo,
            inactiveTrackColor: const Color(0xFF2A2D36),
            thumbColor: const Color(0xFFE9EAEE),
            thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 7),
            overlayShape: const RoundSliderOverlayShape(overlayRadius: 14),
          ),
          child: Slider(value: value.clamp(min, max), min: min, max: max, onChanged: onChanged),
        ),
      ],
    );
  }
}

/// Pill chip — active = filled indigo tint.
class EcChip extends StatelessWidget {
  final String label;
  final bool active;
  final VoidCallback onTap;
  const EcChip({super.key, required this.label, required this.active, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          color: active ? Ec.indigo.withValues(alpha: 0.12) : Colors.transparent,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: active ? Ec.indigo : Ec.border),
        ),
        child: Text(label,
            style: TextStyle(
                color: active ? Ec.indigoText : const Color(0xFF9BA0AC),
                fontSize: 11.5,
                fontWeight: FontWeight.w500)),
      ),
    );
  }
}

/// A settings row: label + trailing control.
class EcRow extends StatelessWidget {
  final String label;
  final Widget trailing;
  const EcRow({super.key, required this.label, required this.trailing});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: Row(
        children: [
          Expanded(child: Text(label, style: const TextStyle(color: Ec.textDim, fontSize: 13.5))),
          trailing,
        ],
      ),
    );
  }
}
