import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart' show debugPrint;
import 'package:http/http.dart' as http;

import '../../core/config/app_config.dart';

/// One notification received while the app is in the foreground. Mirrors the
/// FCM data payload produced by backend dispatchers.ts (rendered via
/// notification/kernel.ts renderMessage — title/body already localized per
/// recipient locale, so the banner just displays them verbatim).
class PushMessage {
  const PushMessage({
    required this.title,
    required this.body,
    this.eventType,
    this.tripId,
  });

  final String title;
  final String body;
  final String? eventType; // TRIP_STARTED | TRIP_ENDED | DRIVER_SEPARATION_TIMER | GEOFENCE_ENTER | GEOFENCE_EXIT
  final String? tripId;

  factory PushMessage.fromData(Map<String, dynamic> data) => PushMessage(
        title: (data['title'] ?? '') as String,
        body: (data['body'] ?? '') as String,
        eventType: data['event_type'] as String?,
        tripId: data['trip_id'] as String?,
      );
}

/// Seam for the FCM plugin (firebase_messaging), deliberately NOT imported
/// here: push registration is a Phase 5 deliverable and this module must stay
/// compilable until then. Following the typedef-injection precedent (see
/// pilot_service.dart BatteryReader), the Phase 5 bootstrap wires a
/// FirebaseMessaging-backed implementation into [PushService].
abstract class PushTokenSource {
  /// Current FCM registration token (min 20 chars server-side; TokenSchema in
  /// backend/src/modules/notification/routes.ts).
  Future<String?> getToken();

  /// Fires whenever the platform rotates the token (FCM refreshes periodically;
  /// re-registration must follow or alerts silently stop — the ledger would show
  /// SKIPPED because the user holds no valid token row).
  Stream<String> get onTokenRefresh;

  /// Foreground messages -> in-app banner stream. Return null for messages that
  /// should fall through to the system tray instead.
  Stream<PushMessage> get onForegroundMessage;
}

/// Response of POST /notifications/token ({registered, token_id}).
typedef TokenRegistrar = Future<bool> Function(String token);

/// Default registrar: plain HTTP POST with the driver JWT. Auth header supplied
/// via [authHeaderProvider] seam so this file stays decoupled from the auth store.
Future<TokenRegistrar> httpTokenRegistrar(
    http.Client client, Future<String?> Function() authHeaderProvider) async {
  return (String token) async {
    final auth = await authHeaderProvider();
    if (auth == null) return false; // signed out: nothing to register against
    final res = await client
        .post(
          Uri.parse('${AppConfig.apiBaseUrl}/notifications/token'),
          headers: {'content-type': 'application/json', 'authorization': auth},
          body: jsonEncode({
            'token': token,
            'platform': defaultTargetPlatform == TargetPlatform.iOS ? 'ios' : 'android',
            // device_id/locale optional server-side; locale omitted => the
            // users.locale column decides template language (pickLocale fallback en).
          }),
        )
        .timeout(const Duration(seconds: 15));
    // 201 first registration, 200 on UPSERT refresh — both mean "registered".
    return res.statusCode == 201 || res.statusCode == 200;
  };
}

/// Phase 5 (E) — push-token lifecycle + foreground banner bus.
///
/// Rules:
///  * registration is fire-and-forget with retry: offline drivers buffer nothing
///    (a token POST is tiny and idempotent server-side — global UNIQUE token
///    UPSERT per migration 0012 rationale), we simply retry on next app start;
///  * every token rotation re-registers immediately (stale token => UNREGISTERED
///    => honest SKIPPED rows in the delivery ledger, never silent loss);
///  * foreground messages are published on [banners]; the UI layer decides how to
///    render them (MaterialBanner/SnackBar) using l10n keys notif* only as a
///    FALLBACK when the server payload lacks localized text.
class PushService {
  PushService({
    required PushTokenSource source,
    required TokenRegistrar registrar,
  })  : _source = source,
        _registrar = registrar;

  final PushTokenSource _source;
  final TokenRegistrar _registrar;
  final StreamController<PushMessage> _banners = StreamController.broadcast();

  Stream<PushMessage> get banners => _banners.stream;

  StreamSubscription<String>? _tokenSub;
  StreamSubscription<PushMessage>? _msgSub;
  bool _lastRegisterOk = false;

  /// Wire the streams. Call once after consent + login (§1.2: notifications are
  /// operational safety features, not tracking — but still post-consent only).
  void start() {
    _tokenSub = _source.onTokenRefresh.listen(_register);
    _msgSub = _source.onForegroundMessage.listen((m) {
      if (!_banners.isClosed) _banners.add(m);
    });
  }

  /// Initial acquisition (idempotent server-side, safe to call on every start).
  Future<bool> registerFromDevice() async {
    final token = await _source.getToken();
    if (token == null || token.length < 20) {
      _lastRegisterOk = false;
      return false;
    }
    _lastRegisterOk = await _register(token);
    return _lastRegisterOk;
  }

  /// Retry hook for connectivity transitions (AppRuntime.onNetworkAvailable).
  Future<void> retryIfPending() async {
    if (!_lastRegisterOk) await registerFromDevice();
  }

  Future<bool> _register(String token) async {
    try {
      final ok = await _registrar(token);
      if (!ok) debugPrint('push: token registration rejected');
      return ok;
    } catch (e) {
      debugPrint('push: registration failed ($e) — will retry');
      return false;
    }
  }

  Future<void> dispose() async {
    await _tokenSub?.cancel();
    await _msgSub?.cancel();
    await _banners.close();
  }
}
