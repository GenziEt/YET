import 'dart:async';

// DEFAULT production entrypoint (main.dart) constructs this class — the
// firebase_messaging dependency is a Phase 5 deliverable (§Master: "push
// notifications via FCM" wired end-to-end, not stubbed). IdlePushTokenSource
// remains only as an explicit opt-out for headless tests / plugin-less builds.
import 'package:firebase_messaging/firebase_messaging.dart';

import 'push_service.dart';

/// Backend data-payload contract — MUST stay in sync with
/// backend/src/modules/notification/dispatchers.ts buildDataPayload(), which
/// emits snake-case keys {event_type, trip_id, separation_id, geofence_id}
/// alongside the localized notification title/body.
PushMessage _toPushMessage(RemoteMessage m) => PushMessage(
      title: m.notification?.title ?? (m.data['title'] as String? ?? ''),
      body: m.notification?.body ?? (m.data['body'] as String? ?? ''),
      eventType: m.data['event_type'] as String?,
      tripId: m.data['trip_id'] as String?,
    );

/// Real FCM [PushTokenSource] (Phase 5 deliverable E): replaces the plugin-free
/// idle default in the production bootstrap so drivers actually receive
/// TRIP_STARTED / TRIP_ENDED / GEOFENCE_* / DRIVER_SEPARATION_TIMER alerts.
///
/// Lifecycle rules mirrored from push_service.dart:
///  * [getToken] returns the CURRENT device token (awaited fresh on every call;
///    FCM caches it after first acquisition, so post-first-call latency ≈ 0);
///    `null` on any failure (no google-services.json, Play Services missing on
///    Chinese-market handsets common in Ethiopian fleets, permission denied on
///    iOS) — PushService then records an honest failed registration and retries
///    via retryIfPending() on the next connectivity flip, never a fake success.
///  * [onTokenRefresh] forwards FCM's rotation stream — a stale token otherwise
///    silently degrades every dispatch to SKIPPED in the delivery ledger.
///  * [onForegroundMessage] maps foreground RemoteMessages onto the banner bus;
///    background messages are rendered by the system tray from the OS-level
///    notification block (no client code runs — that is why the backend sends
///    BOTH notification + data, see dispatchers.ts).
class FirebasePushTokenSource implements PushTokenSource {
  FirebasePushTokenSource({FirebaseMessaging? messaging})
      : _messaging = messaging ?? FirebaseMessaging.instance;

  final FirebaseMessaging _messaging;

  StreamController<String>? _refreshCtl;
  StreamController<PushMessage>? _msgCtl;
  StreamSubscription<String>? _onTokenSub;
  StreamSubscription<RemoteMessage>? _onMessageSub;
  bool _initialized = false;

  /// Idempotent lazy init: request authorization (iOS; no-op accepted on
  /// Android), subscribe to the two long-lived FCM streams, and kick off the
  /// first token acquisition. Called from getToken()/stream getters so even a
  /// PushService that never calls start() still works, and a bootstrap failure
  /// (Firebase.initializeApp missing) degrades to null tokens instead of
  /// crashing the driver's only tool (same kill-switch philosophy as main.dart).
  void _ensureInit() {
    if (_initialized) return;
    _initialized = true;
    try {
      // Best-effort: authorization errors surface as null token later.
      unawaited(_messaging.requestPermission());
      _onTokenSub = _messaging.onTokenRefresh.listen((token) {
        _refreshCtl?.add(token);
      });
      _onMessageSub = _messaging.onMessage.listen((msg) {
        _msgCtl?.add(_toPushMessage(msg));
      });
    } catch (_) {
      // Plugin unavailable at runtime (e.g. Google Play Services absent):
      // streams stay empty, getToken() stays null — honest no-push mode.
    }
  }

  @override
  Future<String?> getToken() async {
    _ensureInit();
    try {
      return await _messaging.getToken();
    } catch (_) {
      return null;
    }
  }

  @override
  Stream<String> get onTokenRefresh {
    _ensureInit();
    return (_refreshCtl ??= StreamController<String>.broadcast()).stream;
  }

  @override
  Stream<PushMessage> get onForegroundMessage {
    _ensureInit();
    return (_msgCtl ??= StreamController<PushMessage>.broadcast()).stream;
  }

  /// Release the broadcast controllers and FCM subscriptions (widget dispose).
  Future<void> dispose() async {
    await _onTokenSub?.cancel();
    await _onMessageSub?.cancel();
    await _refreshCtl?.close();
    await _msgCtl?.close();
    _refreshCtl = null;
    _msgCtl = null;
    _initialized = false;
  }
}
