import 'package:flutter/material.dart';

/// EaseCut design tokens — mirrored 1:1 from the React app (styles.css +
/// newui/screens/MobileEditor.tsx) so the Flutter UI matches pixel-close.
class Ec {
  // Backgrounds
  static const bg = Color(0xFF0B0B0D); // app / editor
  static const stage = Color(0xFF000000); // preview stage
  static const sheet = Color(0xFF141418); // bottom sheets
  static const card = Color(0xFF1E2026); // list cards
  static const card2 = Color(0xFF17171B); // panel cards
  static const chip = Color(0xFF23252B); // thumbs / chips

  // Hairline borders
  static const hair = Color(0x0FFFFFFF); // rgba(255,255,255,.06)
  static const hair2 = Color(0x17FFFFFF); // rgba(255,255,255,.09)
  static const border = Color(0x12FFFFFF); // rgba(255,255,255,.07)

  // Accent — purple gradient (Export, primary actions)
  static const accentA = Color(0xFF7C5CFF);
  static const accentB = Color(0xFFA468FF);
  static const gradient = LinearGradient(
    begin: Alignment(-0.9, -0.3),
    end: Alignment(0.9, 0.3),
    colors: [accentA, accentB],
  );

  // Indigo accents (Media/Audio import, "Base" chip)
  static const indigo = Color(0xFF6E6AE8);
  static const indigoText = Color(0xFFB7B5F4);
  static const indigoTint = Color(0x296E6AE8); // rgba(110,106,232,.16)

  // Text
  static const text = Color(0xFFE7E7EA); // bright
  static const textDim = Color(0xFFC6C9D2);
  static const textMute = Color(0xFF8F8F96);
  static const textFaint = Color(0xFF686E7B);
  static const disabled = Color(0xFF4A4F5B);

  // Signals
  static const green = Color(0xFF7ED957);

  static const mono = 'IBMPlexMono';

  static ThemeData themeData() {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: bg,
      colorScheme: const ColorScheme.dark(
        primary: accentA,
        secondary: indigo,
        surface: sheet,
      ),
      fontFamily: 'InstrumentSans',
      splashFactory: InkRipple.splashFactory,
    );
  }
}

/// A pill button filled with the EaseCut purple gradient (e.g. Export).
class GradientButton extends StatelessWidget {
  final String label;
  final IconData? icon;
  final VoidCallback? onTap;
  final EdgeInsets padding;
  final double fontSize;
  const GradientButton({
    super.key,
    required this.label,
    this.icon,
    this.onTap,
    this.padding = const EdgeInsets.symmetric(horizontal: 18, vertical: 8),
    this.fontSize = 13,
  });

  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Container(
        padding: padding,
        decoration: BoxDecoration(
          gradient: Ec.gradient,
          borderRadius: BorderRadius.circular(10),
          boxShadow: [
            BoxShadow(
              color: Ec.accentA.withValues(alpha: 0.35),
              blurRadius: 12,
              offset: const Offset(0, 2),
            ),
          ],
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(icon, size: fontSize + 5, color: Colors.white),
              const SizedBox(width: 7),
            ],
            Text(
              label,
              style: TextStyle(
                color: Colors.white,
                fontSize: fontSize,
                fontWeight: FontWeight.w700,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
