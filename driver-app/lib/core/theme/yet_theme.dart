import 'package:flutter/material.dart';

/// YET driver app — custom brand theme (Phase 4 UI polish).
///
/// A warm, high-contrast palette that reads at a glance through a windshield:
/// deep green primary, extra-large touch targets, and semantic status colors
/// shared with [TripHomeScreen] so banners/buttons never fight the theme.
abstract final class YetTheme {
  // Brand palette.
  static const Color primary = Color(0xFF1B5E20); // deep fleet green
  static const Color onPrimary = Colors.white;
  static const Color tracking = Color(0xFFC62828); // red — trip active (END)
  static const Color idle = Color(0xFF2E7D32); // green — ready to start
  static const Color surfaceTint = Color(0xFFF3F7F2); // soft card background

  /// Status-banner colors: (background, foreground text/icon).
  static const Color warnBg = Color(0xFFFFF6DE);
  static const Color warnFg = Color(0xFF7A5B00);
  static const Color errorBg = Color(0xFFFDECEC);
  static const Color errorFg = Color(0xFFB3261E);
  static const Color okBg = Color(0xFFE7F6EA);
  static const Color okFg = Color(0xFF1B5E20);

  /// App canvas — warm off-white; cards float on pure white (the layered
  /// "cards on canvas" composition used by modern logistics/fintech apps).
  static const Color canvas = Color(0xFFF5F7F4);
  static const Color ink = Color(0xFF16241A); // high-contrast headline text
  static const Color inkSoft = Color(0xFF4A5B4E); // secondary text

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
      primary: primary,
      onPrimary: onPrimary,
      surface: Colors.white,
    );
    final base = ThemeData(useMaterial3: true, colorScheme: scheme);
    return base.copyWith(
      scaffoldBackgroundColor: canvas,
      appBarTheme: AppBarTheme(
        backgroundColor: primary,
        foregroundColor: onPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        titleTextStyle: const TextStyle(
          color: onPrimary, fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: 0.2,
        ),
        iconTheme: const IconThemeData(color: onPrimary),
        actionsIconTheme: const IconThemeData(color: onPrimary),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: primary,
          foregroundColor: onPrimary,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 20),
          textStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: 0.4),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: primary,
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      cardTheme: CardTheme(
        color: Colors.white,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
          side: BorderSide(color: const Color(0x14000000)),
        ),
      ),
      snackBarTheme: base.snackBarTheme.copyWith(
        behavior: SnackBarBehavior.floating,
        backgroundColor: ink,
        contentTextStyle: const TextStyle(fontSize: 17, color: Colors.white),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      ),
      dividerTheme: const DividerThemeData(space: 1),
    );
  }
}
