import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_localizations/flutter_localizations.dart';

import 'core/app_runtime.dart';
import 'core/theme/yet_theme.dart';
import 'core/config/app_config.dart';
import 'core/config/startup_config.dart';
import 'core/net/http_clients.dart';
import 'core/net/preconnect.dart';
import 'features/auth/device_identity.dart';
import 'features/auth/document_upload_screen.dart';
import 'features/auth/onboarding_repository.dart';
import 'features/auth/otp_screen.dart';
import 'features/auth/pending_review_screen.dart';
import 'features/auth/profile_screen.dart';
import 'features/auth/register_screen.dart';
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
  final deviceIdentity = DeviceIdentity();
  // Three independent SharedPreferences reads — concurrent so main() blocks
  // for max(t1,t2,t3). Still zero network I/O before the first frame; the
  // silent session refresh runs AFTER runApp (see _YetAppState.initState).
  await Future.wait<void>([
    consent.loadLocal(),
    tokenStore.load(),
    deviceIdentity.ensureLoaded(),
  ]);
  runApp(YetApp(
    consent: consent,
    tokenStore: tokenStore,
    deviceIdentity: deviceIdentity,
  ));
}

class YetApp extends StatefulWidget {
  const YetApp({
    super.key,
    required this.consent,
    required this.tokenStore,
    required this.deviceIdentity,
  });
  final ConsentRepository consent;
  final TokenStore tokenStore;
  final DeviceIdentity deviceIdentity;

  @override
  State<YetApp> createState() => _YetAppState();
}

class _YetAppState extends State<YetApp> {
  Locale _locale = AppConfig.defaultLocale;
  AppRuntime? _runtime;

  // ── Module 1: driver onboarding WITHOUT a traditional login ──────────────
  // Stages: unknown (restore in flight) -> needsOnboarding (OTP step) ->
  // form (ticket valid, registration incomplete) -> docs (license upload
  // mandatory before review) -> pending (PENDING_REVIEW / suspended hold) ->
  // ready (ACTIVE session; existing consent/permissions/trip flow).
  _AuthStage _stage = _AuthStage.unknown;
  /// True while the silent POST /auth/session/refresh is running at launch.
  bool _restoring = true;
  OnboardingRepository? _onboarding;

  OnboardingRepository get onboarding => _onboarding ??= OnboardingRepository(
        tokens: widget.tokenStore,
        device: widget.deviceIdentity,
      );

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
    // Silent session restore AFTER the first frame (never blocks cold start).
    Future.microtask(_restoreSession);
  }

  /// The "always logged in" mechanism: no credentials are typed — the stored
  /// JWT + this install's device id are re-validated server-side. Outcomes:
  ///  * 200 → ACTIVE check → ready (or docs/pending hold states);
  ///  * device_not_paired / expired token → phone known? OTP re-pairing screen;
  ///    otherwise fresh onboarding;
  ///  * account_suspended → pending screen in suspended mode;
  ///  * network error offline → optimistic: render the normal flow (sync
  ///    worker queues fixes; the next successful refresh re-gates).
  Future<void> _restoreSession() async {
    final ts = widget.tokenStore;
    // Brand-new install (or wiped): straight into registration if a driver id
    // was never stored here.
    if (!ts.hasToken && !ts.hasPhone && ts.driverId == null) {
      if (!mounted) return;
      setState(() {
        _stage = ts.registrationTicket != null
            ? _AuthStage.form
            : _AuthStage.needsOnboarding;
        _restoring = false;
      });
      return;
    }
    try {
      final ok = await onboarding.refreshSession();
      if (!mounted) return;
      if (!ok) {
        // refreshSession() already handled token persistence; a `false` here
        // means the server rejected pairing but the call did not throw —
        // fall through to re-pairing below.
        setState(() {
          _stage = _AuthStage.repairs;
          _restoring = false;
        });
        return;
      }
      await _routeByStatus();
    } on OnboardingException catch (e) {
      if (!mounted) return;
      if (e.code == 'account_suspended' || e.code == 'fleet_suspended') {
        setState(() {
          _stage = _AuthStage.pendingSuspended;
          _restoring = false;
        });
      } else if (e.isDeviceNotPaired) {
        setState(() {
          _stage = ts.hasPhone ? _AuthStage.repairs : _AuthStage.needsOnboarding;
          _restoring = false;
        });
      } else {
        // Network/server error WITH a stored token: optimistic pass-through —
        // the driver keeps their session and the pipeline drains when online.
        setState(() {
          _stage = _AuthStage.ready;
          _restoring = false;
        });
      }
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _stage = _AuthStage.ready;
        _restoring = false;
      });
    }
  }

  /// After a valid session: GET /me/profile decides between the trip flow,
  /// the mandatory-license upload hold, or the admin-review hold.
  Future<void> _routeByStatus() async {
    try {
      final profile = await onboarding.fetchProfile();
      if (!mounted) return;
      final status = profile['registration_status'] as String? ?? 'PENDING_REVIEW';
      if (status == 'SUSPENDED') {
        setState(() {
          _stage = _AuthStage.pendingSuspended;
          _restoring = false;
        });
        return;
      }
      final docs = (profile['documents'] as List?) ?? const [];
      final hasLicense = docs.any((d) =>
          d is Map && d['doc_type'] == 'DRIVING_LICENSE');
      if (!hasLicense) {
        setState(() {
          _stage = _AuthStage.docs;
          _restoring = false;
        });
        return;
      }
      if (status != 'ACTIVE') {
        setState(() {
          _stage = _AuthStage.pendingReview;
          _restoring = false;
        });
        return;
      }
      setState(() {
        _stage = _AuthStage.ready;
        _restoring = false;
      });
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() {
        _stage = e.isDeviceNotPaired
            ? _AuthStage.repairs
            : _AuthStage.pendingReview;
        _restoring = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _stage = _AuthStage.ready;
        _restoring = false;
      });
    }
  }

  /// Registration succeeded on the form screen: license upload is mandatory
  /// before the admin can verify, so go straight to the docs step.
  void _onRegistered() {
    setState(() => _stage = _AuthStage.docs);
  }

  /// Docs step complete (license uploaded) — wait for admin activation.
  void _onDocsDone() {
    setState(() => _stage = _AuthStage.pendingReview);
  }

  /// Admin approved → resume normal launch behaviour.
  void _onApproved() {
    setState(() => _stage = _AuthStage.ready);
    unawaited(_bootstrapPipelineIfEnabled());
  }

  Future<void> _bootstrapPipelineIfEnabled() async {
    if (_pipelineEnabled && _runtime == null) await _bootstrapPipeline();
  }

  /// Sign-out from the profile screen: revoke this install and re-enter
  /// onboarding (fresh OTP required — by design).
  void _onSignOut() {
    setState(() => _stage = _AuthStage.needsOnboarding);
  }
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
      // Tile host warmed in PARALLEL with the API host (separate origin ⇒
      // separate sockets). Pays DNS+TCP+TLS for tiles.yet.et off the critical
      // path so opening the offline-map screen or a live tile fetch never
      // stalls on a cold handshake mid-trip. Best-effort: offline is silent.
      final tileOrigin = StartupConfig.tileOrigin;
      if (tileOrigin != null) {
        unawaited(preconnectAfterFirstFrame(baseUrl: tileOrigin));
      }
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
      // Phase 4 UI polish: dedicated brand theme (lib/core/theme/yet_theme.dart)
      theme: YetTheme.light(),
      // §Phase 4 (G5): PushBannerHost wraps the flow root so a fleet alert is
      // visible on ANY screen (consent, permissions, trip home, pushed routes).
      home: PushBannerHost(push: _push!, child: _rootForLocale()),
    );
  }

  /// Flow gate: device session (Module 1, replaces login) -> consent (PDPP
  /// §1.7) -> permissions explainer -> trip home. Language toggle lives on
  /// consent + home screens so switching is one tap.
  Widget _rootForLocale() {
    // ── Onboarding / persistent-session gate (no passwords anywhere) ──────
    switch (_stage) {
      case _AuthStage.unknown:
        // Silent restore in flight: show a neutral splash — the driver never
        // sees a login screen because there isn't one.
        return const _RestoreSplash();
      case _AuthStage.needsOnboarding:
        return OtpScreen(
          repo: onboarding,
          initialPhone: widget.tokenStore.phone,
          onVerified: () => setState(() => _stage = _AuthStage.form),
        );
      case _AuthStage.repairs:
        // Session lost on a known phone: re-pair THIS install with one OTP.
        return OtpScreen(
          repo: onboarding,
          initialPhone: widget.tokenStore.phone,
          repairsMode: true,
          onRepairsPaired: () => setState(() => _stage = _AuthStage.ready),
          onVerified: () => setState(() => _stage = _AuthStage.ready),
        );
      case _AuthStage.form:
        final phone = widget.tokenStore.phone ?? '';
        return RegisterScreen(
          repo: onboarding,
          phone: phone,
          localeCode: _locale.languageCode,
          onRegistered: (_) => _onRegistered(),
        );
      case _AuthStage.docs:
        return DocumentUploadScreen(repo: onboarding, onDone: _onDocsDone);
      case _AuthStage.pendingReview:
        return PendingReviewScreen(repo: onboarding, onReady: _onApproved);
      case _AuthStage.pendingSuspended:
        return PendingReviewScreen(
          repo: onboarding,
          suspended: true,
          onReady: _onApproved,
        );
      case _AuthStage.ready:
        break; // fall through to the existing consent/permissions/trip flow.
    }

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
      // Self-service profile entry point: update license/truck/trailers and
      // documents WITHOUT ever re-registering or logging in again.
      onOpenProfile: () => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => ProfileScreen(repo: onboarding, onSignOut: _onSignOut),
      )),
    );
  }
}

/// Auth stages for the passwordless launch gate (Module 1).
enum _AuthStage {
  unknown,
  needsOnboarding,
  form,
  docs,
  pendingReview,
  pendingSuspended,
  repairs,
  ready,
}

/// Minimal branded placeholder shown while POST /auth/session/refresh runs.
class _RestoreSplash extends StatelessWidget {
  const _RestoreSplash();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.directions_bus_rounded,
                size: 72, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 16),
            const CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}
