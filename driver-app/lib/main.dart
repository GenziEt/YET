import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/app_runtime.dart';
import 'core/config/app_config.dart';
import 'features/auth/token_store.dart';
import 'features/consent/consent_repository.dart';
import 'features/consent/consent_screen.dart';
import 'features/permissions/permissions_screen.dart';
import 'features/trip/trip_home_screen.dart';
import 'l10n/app_localizations.dart';

/// Phase 1 kill-switch: if the SQLite/composition-root bootstrap throws on a
/// low-end device, the app degrades to the proven Phase 0 flow (consent ->
/// permissions -> trip home with placeholder counter) instead of crash-looping.
bool _pipelineEnabled = true;

/// YET driver app — Phase 0 + Phase 1 ingest pipeline.
/// Cold-start budget (§1.9.1): <=3s to a usable screen on 2GB RAM Android 10.
/// Therefore: no heavy work in main(); consent flag read from SharedPreferences is
/// the only boot I/O; SQLite pre-warm happens off the critical path after first
/// frame ([AppRuntime.bootstrap] runs AFTER runApp and swaps itself in via
/// ListenableBuilder).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final consent = ConsentRepository();
  await consent.loadLocal(); // tiny KV read, cached thereafter
  final tokenStore = TokenStore();
  await tokenStore.load(); // tiny KV read
  runApp(YetApp(consent: consent, tokenStore: tokenStore));
}

class YetApp extends StatefulWidget {
  const YetApp({super.key, required this.consent, required this.tokenStore});
  final ConsentRepository consent;
  final TokenStore tokenStore;

  @override
  State<YetApp> createState() => _YetAppState();
}

class _YetAppState extends State<YetApp> {
  Locale _locale = AppConfig.defaultLocale;
  AppRuntime? _runtime;

  @override
  void initState() {
    super.initState();
    if (_pipelineEnabled) {
      // Off the cold-start critical path (§1.9.1): first frame renders with a
      // null runtime; the cache opens right after and notifies this state.
      Future.microtask(_bootstrapPipeline);
    }
  }

  Future<void> _bootstrapPipeline() async {
    try {
      final rt = await AppRuntime.bootstrap(tokenStore: widget.tokenStore);
      if (!mounted) {
        rt.dispose();
        return;
      }
      setState(() => _runtime = rt);
    } catch (e, s) {
      // Degrade to Phase 0 behaviour rather than brick the driver's only tool.
      debugPrint('Phase 1 pipeline disabled after bootstrap failure: $e\n$s');
      _pipelineEnabled = false;
    }
  }

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
        // ColorScheme.fromSeed is const-compatible in the sandbox stub; real
        // Flutter computes tokens at runtime, so keep this non-const.
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
      runtime: _runtime,
      onToggleLocale: () => setState(() {
        _locale = _locale.languageCode == 'en' ? const Locale('am') : const Locale('en');
      }),
    );
  }
}
