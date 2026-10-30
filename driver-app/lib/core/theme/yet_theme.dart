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

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(
      seedColor: primary,
      brightness: Brightness.light,
      primary: primary,
      onPrimary: onPrimary,
    );
    final base = ThemeData(useMaterial3: true, colorScheme: scheme);
    return base.copyWith(
      scaffoldBackgroundColor: const Color(0xFFFAFBFA),
      appBarTheme: AppBarTheme(
        backgroundColor: primary,
        foregroundColor: onPrimary,
        elevation: 0,
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
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
          padding: const EdgeInsets.symmetric(vertical: 18, horizontal: 20),
          textStyle: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          foregroundColor: primary,
          textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        ),
      ),
      cardTheme: CardTheme(
        color: surfaceTint,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: BorderSide(color: const Color(0x0F000000)),
        ),
      ),
      snackBarTheme: base.snackBarTheme.copyWith(
        contentTextStyle: const TextStyle(fontSize: 18),
      ),
      dividerTheme: const DividerThemeData(space: 1),
    );
  }
}
