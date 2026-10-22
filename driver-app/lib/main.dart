import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/config/app_config.dart';
import 'features/consent/consent_repository.dart';
import 'features/consent/consent_screen.dart';
import 'features/permissions/permissions_screen.dart';
import 'features/trip/trip_home_screen.dart';
import 'l10n/app_localizations.dart';

/// YET driver app — Phase 0.
/// Cold-start budget (§1.9.1): <=3s to a usable screen on 2GB RAM Android 10.
/// Therefore: no heavy work in main(); consent flag read from SharedPreferences is
/// the only boot I/O; SQLite pre-warm happens off the critical path after first frame.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final consent = ConsentRepository();
  await consent.loadLocal(); // tiny KV read, cached thereafter
  runApp(YetApp(consent: consent));
}

class YetApp extends StatefulWidget {
  const YetApp({super.key, required this.consent});
  final ConsentRepository consent;

  @override
  State<YetApp> createState() => _YetAppState();
}

class _YetAppState extends State<YetApp> {
  Locale _locale = AppConfig.defaultLocale;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'YET',
      locale: _locale,
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [
        AppLocalizations.delegate,
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF14532D)),
        useMaterial3: true,
        // Large touch targets & text for drivers on low-end phones while moving.
        snackBarTheme: const SnackBarThemeData(contentTextStyle: TextStyle(fontSize: 18)),
      ),
      home: _rootForLocale(),
    );
  }

  /// Flow gate: consent (PDPP §1.7) -> permissions explainer -> trip home.
  /// Language toggle lives on consent + home screens so switching is one tap.
  Widget _rootForLocale() {
    if (!widget.consent.accepted) {
      return ConsentScreen(
        repo: widget.consent,
        onAccepted: () => setState(() {}),
        onToggleLocale: () => setState(() {
          _locale = _locale.languageCode == 'en'
              ? const Locale('am')
              : const Locale('en');
        }),
      );
    }
    if (!widget.consent.permissionsAcknowledged) {
      return PermissionsScreen(
        repo: widget.consent,
        onDone: () => setState(() {}),
      );
    }
    return TripHomeScreen(
      consent: widget.consent,
      onToggleLocale: () => setState(() {
        _locale = _locale.languageCode == 'en' ? const Locale('am') : const Locale('en');
      }),
    );
  }
}
