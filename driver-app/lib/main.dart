import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/app_runtime.dart';
import 'core/config/app_config.dart';
import 'core/config/startup_config.dart';
import 'core/net/http_clients.dart';
import 'core/net/preconnect.dart';
import 'features/auth/token_store.dart';
import 'features/consent/consent_repository.dart';
import 'features/consent/consent_screen.dart';
import 'features/notifications/firebase_push_source.dart';
import 'features/notifications/push_banner.dart';
import 'features/notifications/push_service.dart';
import 'features/permissions/permissions_screen.dart';
import 'features/trip/trip_home_screen.dart';
import 'l10n/app_localizations.dart';
import 'platform/battery_source.dart';
import 'platform/location_source.dart';
import 'platform/sensor_source.dart';

/// Phase 1 kill-switch: if the SQLite/composition-root bootstrap throws on a
/// low-end device, the app degrades to the proven Phase 0 flow (consent ->
/// permissions -> trip home) instead of crash-looping. Seeded from the
/// compile-time `PIPELINE_ENABLED` dart-define (§STARTUP-OPTIMIZATION.md §5.3):
/// in AOT builds an unset flag constant-folds to `true`, so this read is free.
bool _pipelineEnabled = StartupConfig.pipelineEnabled;

/// §Phase 4 (G4): platform bridge for battery-optimization exemption and
/// "Allow all the time" location settings. Kotlin side:
/// android/app/src/main/kotlin/com/yet/driver/MainActivity.kt handles
/// ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (with the POWER_MANAGER
/// settings-screen fallback) and ACTION_LOCATION_SOURCE_SETTINGS. Kept as a
/// plain MethodChannel call (no plugin dependency) so this package stays
/// testable headless — off-platform the channel simply returns null and the
/// explainer text + runbook fallback remain (§docs/PILOT-RUNBOOK.md).
const batteryExemptionChannel = MethodChannel('yet.dev/battery_exemption');

Future<void> _openPhoneSettings() async {
  try {
    await batteryExemptionChannel.invokeMethod<void>('requestIgnoreBatteryOptimizations');
    await batteryExemptionChannel.invokeMethod<void>('openLocationSettings');
  } catch (_) {
    // Headless host / missing native handler: the screen's explainer copy and
    // PILOT-RUNBOOK manual steps are the documented fallback. Never throw out
    // of the UI thread — the driver must still be able to acknowledge.
  }
}

/// YET driver app — Phase 0 + Phase 1 ingest pipeline.
/// Cold-start budget (§1.9.1): <=3s to a usable screen on 2GB RAM Android 10.
/// Therefore: no heavy work in main(); consent flag read from SharedPreferences is
/// the only boot I/O; SQLite pre-warm happens off the critical path after first
/// frame ([AppRuntime.bootstrap] runs AFTER runApp and swaps itself in via
/// ListenableBuilder).
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Compile-time env overrides (dart-defines) — const reads + two field
  // writes, zero I/O (§STARTUP-OPTIMIZATION.md §5.3).
  StartupConfig.apply();
  // P4 (§STARTUP-OPTIMIZATION.md): the two boot KV reads are independent
  // SharedPreferences lookups on separate instances — run them concurrently so
  // main() blocks for max(t1, t2) instead of t1 + t2. Still zero network I/O;
  // startup_flattening_test's "no request before first frame" invariant holds.
  final consent = ConsentRepository();
  final tokenStore = TokenStore();
  await Future.wait<void>([consent.loadLocal(), tokenStore.load()]);
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
  /// §Phase 5 (E): foreground push-banner bus with the REAL FCM token source.
  /// firebase_messaging is now a declared dependency and FirebasePushTokenSource
  /// replaces the Phase-4 IdlePushTokenSource default — getToken()/onTokenRefresh/
  /// onForegroundMessage all hit the live plugin. The idle source remains for
  /// headless tests and plugin-less builds only. Registration itself stays
  /// post-consent + post-login (see _registerPushToken).
  PushService? _push;
  FirebasePushTokenSource? _pushSource;

  @override
  void initState() {
    super.initState();
    // §Phase 4 (G5): banner bus is cheap to construct (no I/O in the ctor), so
    // it exists before the first frame — anything that publishes on
    // PushService.banners (Phase 5 FCM source, local event hooks, tests) has a
    // live surface from t=0. Token registration itself stays post-consent.
    _push = _makePushService()..start();
    if (_pipelineEnabled) {
      // Off the cold-start critical path (§1.9.1): first frame renders with a
      // null runtime; the cache opens right after and notifies this state.
      Future.microtask(_bootstrapPipeline);
    }
  }

  /// Build the foreground-banner bus once: real HTTP registrar against
  /// POST /notifications/token, and — §Phase 5 (E) — the REAL FCM token source.
  /// FirebasePushTokenSource degrades honestly to `null` tokens when the plugin
  /// cannot initialize (no google-services.json, no Play Services, iOS
  /// permission denied), in which case PushService records a failed
  /// registration and retries via retryIfPending() — never a fake success.
  PushService _makePushService() {
    // §5.4: shared keep-alive pool — push registration rides the SAME warm
    // sockets as uploads instead of paying its own DNS+TCP+TLS cycle.
    final source = FirebasePushTokenSource();
    _pushSource = source;
    return PushService(
      source: source,
      registrar: httpTokenRegistrar(AppHttp.shared, () async {
        final t = widget.tokenStore.accessToken;
        return (t == null || t.isEmpty) ? null : 'Bearer $t';
      }),
    );
  }

  Future<void> _bootstrapPipeline() async {
    // §5.4 handshake pre-pay: fire-and-forget the DNS+TCP+TLS warm-up against
    // the API gateway BEFORE the (heavier) SQLite bootstrap is awaited, so the
    // socket pool is ready while the cache opens. Never blocks the UI isolate;
    // const-guarded so release builds can compile it out via PRECONNECT=false.
    if (StartupConfig.preconnectEnabled) {
      unawaited(preconnectAfterFirstFrame());
    }
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
        // §5.4: one keep-alive pool for uploads, /me checks, config fetches —
        // every post-boot request reuses the sockets preconnect warmed.
        httpClient: AppHttp.shared,
      );
      if (!mounted) {
        rt.dispose();
        return;
      }
      setState(() => _runtime = rt);

      // §Phase 5 (E): after consent + login (AppRuntime.bootstrap only
      // succeeds with a live session), attempt the real FCM token
      // registration off the UI thread. Honest failure is fine: PushService
      // records it and retryIfPending() re-attempts on the next connectivity
      // drain / app resume.
      unawaited(_push?.registerFromDevice());

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
    unawaited(_push?.dispose());
    unawaited(_pushSource?.dispose());
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
      // §Phase 4 (G5): PushBannerHost wraps the flow root so a fleet alert is
      // visible on ANY screen (consent, permissions, trip home, pushed routes).
      home: PushBannerHost(push: _push!, child: _rootForLocale()),
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
        // §Phase 4 (G4): real platform intents via the battery-exemption
        // MethodChannel (Kotlin handler: MainActivity.kt). The seam stays
        // injectable so headless tests never fire intents.
        openPhoneSettings: _openPhoneSettings,
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
