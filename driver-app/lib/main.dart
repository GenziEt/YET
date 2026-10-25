import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
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
import 'platform/battery_source.dart';
import 'platform/location_source.dart';
import 'platform/sensor_source.dart';

/// Phase 1 kill-switch: if the SQLite/composition-root bootstrap throws on a
/// low-end device, the app degrades to the proven Phase 0 flow (consent ->
/// permissions -> trip home) instead of crash-looping.
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
  GeolocatorPositionSource? _positionSource;
  SensorsPlusSource? _sensorSource;
  StreamSubscription<List<ConnectivityResult>>? _connectivitySub;

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
      // ── Default production bootstrap: REAL device sources, no seams left
      // dangling (§Phase 1: "a real position source is constructed and
      // injected into AppRuntime by the default main.dart bootstrap").
      final positionSource = GeolocatorPositionSource();
      final sensorSource = SensorsPlusSource();
      _positionSource = positionSource;
      _sensorSource = sensorSource;

      final rt = await AppRuntime.bootstrap(
        tokenStore: widget.tokenStore,
        positionSource: positionSource.asFactory(),
        sensorSource: sensorSource.asFactory(),
        batteryReader: BatteryPlusReader().asReader(),
        networkTypeProvider: _currentNetworkType,
      );
      if (!mounted) {
        rt.dispose();
        return;
      }
      setState(() => _runtime = rt);

      // §1.8.1 sync trigger: any connectivity change that yields a usable
      // network schedules an immediate drain (SyncWorker filters internally).
      _connectivitySub = Connectivity()
          .onConnectivityChanged
          .listen((results) => _onConnectivityChanged(results, rt));
      // Seed the network label immediately (the stream only fires on CHANGE);
      // diagnostics rows need a correct network_type from the first sample.
      try {
        final initial = await Connectivity().checkConnectivity();
        if (mounted) _onConnectivityChanged(initial, rt);
      } catch (_) {
        // Plugin unavailable on this host: label stays 'unknown' (schema-valid).
      }
    } catch (e, s) {
      // Degrade to Phase 0 behaviour rather than brick the driver's only tool.
      debugPrint('Phase 1 pipeline disabled after bootstrap failure: $e\n$s');
      _pipelineEnabled = false;
    }
  }

  /// True when at least one active interface can carry uploads
  /// (mobile or wifi). None/bluetooth/vpn-only states do not trigger a drain.
  static bool _hasUsableConnection(List<ConnectivityResult> results) =>
      results.contains(ConnectivityResult.mobile) ||
      results.contains(ConnectivityResult.wifi);

  void _onConnectivityChanged(
      List<ConnectivityResult> results, AppRuntime rt) {
    _lastNetworkType = _networkLabel(results);
    if (_hasUsableConnection(results)) rt.onNetworkAvailable();
  }

  /// connectivity_plus-backed network_type label for /ingest/diagnostics rows.
  /// Mirrors backend DiagnosticsPayloadSchema (modules/ingest/service.ts):
  /// 'wifi' | 'cellular' | 'none' | 'unknown'. The plugin does not expose the
  /// radio generation on Android, so any mobile interface maps to 'cellular'.
  static String _networkLabel(List<ConnectivityResult> results) {
    if (results.contains(ConnectivityResult.wifi)) return 'wifi';
    if (results.contains(ConnectivityResult.mobile)) return 'cellular';
    if (results.isEmpty || results.contains(ConnectivityResult.none)) {
      return 'none';
    }
    return 'unknown';
  }

  String _currentNetworkType() => _lastNetworkType;

  String _lastNetworkType = 'unknown';

  @override
  void dispose() {
    _connectivitySub?.cancel();
    unawaited(_positionSource?.dispose());
    unawaited(_sensorSource?.dispose());
    _runtime?.dispose();
    super.dispose();
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
