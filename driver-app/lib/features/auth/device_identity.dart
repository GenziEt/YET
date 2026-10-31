import 'dart:io' show Platform;

import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

/// Stable per-install device identity — the credential that REPLACES a
/// password for drivers (Module 1: registration without traditional login).
///
/// The backend pairs this id to the driver account at POST /auth/register and
/// re-validates it on every silent session refresh (POST /auth/session/refresh)
/// and OTP re-pairing (POST /auth/pair-device). It is NOT secret material:
/// possession of the install + phone OTP is what authenticates, mirroring the
/// server-side device_identities registry.
///
/// Lifecycle rules (docs/DRIVER-ONBOARDING.md):
///  * Generated exactly once per install (first read writes it durably).
///  * Survives app restarts/upgrades via SharedPreferences (same persistence
///    pattern as TokenStore — no platform-ID APIs, which change on OS updates
///    or factory resets and would silently break pairing).
///  * A factory reset / reinstall mints a NEW id ⇒ the old pairing stays valid
///    server-side until revoked, and the new install re-pairs via phone OTP.
///    That is intentional: an attacker wiping the app cannot take over the
///    account without also receiving the SMS to the driver's SIM.
class DeviceIdentity {
  static const _kDeviceId = 'device_identity_v1';
  static const _kFirstSeen = 'device_identity_first_seen_v1';

  String? _deviceId;

  /// The stable id sent as `device_id` in every auth call. Never null after
  /// [ensureLoaded] completes.
  String get deviceId => _deviceId!;

  /// Coarse platform label stored server-side for admin transparency
  /// (GET /admin/drivers/:id shows paired installs with their platform).
  String get platformLabel {
    try {
      if (Platform.isAndroid) return 'android';
      if (Platform.isIOS) return 'ios';
    } catch (_) {
      // Headless test host without dart:io platform bindings.
    }
    return 'unknown';
  }

  /// Read-or-create the install UUID. Idempotent; safe to await from main()
  /// before runApp (a single SharedPreferences lookup on the cold path, same
  /// budget as TokenStore.load()).
  Future<void> ensureLoaded() async {
    final sp = await SharedPreferences.getInstance();
    var id = sp.getString(_kDeviceId);
    if (id == null || id.length < 8) {
      // uuid v4 — 36 chars, within the server's 8..128 device_id bounds.
      id = const Uuid().v4();
      await sp.setString(_kDeviceId, id);
      await sp.setString(_kFirstSeen, DateTime.now().toUtc().toIso8601String());
    }
    _deviceId = id;
  }

  /// Test seam only: force a specific id (production must go through
  /// [ensureLoaded] so the value is durably persisted first).
  Future<void> seedForTest(String id) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kDeviceId, id);
    _deviceId = id;
  }
}
