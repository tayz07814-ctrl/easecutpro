import 'package:flutter/material.dart';

import '../theme.dart';

/// The EaseCut bottom-sheet chrome (MobileEditor.tsx `Sheet`): #141418 panel,
/// 18px top corners, drag handle, optional header row.
class SheetScaffold extends StatelessWidget {
  final String? title;
  final Widget? trailing;
  final Widget child;
  final double heightFactor;
  const SheetScaffold({
    super.key,
    this.title,
    this.trailing,
    required this.child,
    this.heightFactor = 0.82,
  });

  @override
  Widget build(BuildContext context) {
    return FractionallySizedBox(
      heightFactor: heightFactor,
      child: Container(
        decoration: const BoxDecoration(
          color: Ec.sheet,
          borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
          border: Border(top: BorderSide(color: Ec.hair2)),
        ),
        child: Column(
          children: [
            const SizedBox(height: 8),
            Container(
              width: 38,
              height: 4,
              decoration: BoxDecoration(
                color: Colors.white.withValues(alpha: 0.18),
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            if (title != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
                child: Row(
                  children: [
                    Text(title!,
                        style: const TextStyle(
                            fontSize: 15, fontWeight: FontWeight.w600, color: Ec.text)),
                    const Spacer(),
                    ?trailing,
                  ],
                ),
              ),
            Expanded(child: child),
          ],
        ),
      ),
    );
  }
}
