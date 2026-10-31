import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// Driver auth token cache (Identity module pairing, Phase 1 scope).
///
/// Privacy rule (§1.7 data minimization): the app stores ONLY the JWT and a
/// non-secret driver identifier — never credentials, never contacts, never
/// photos. The token is what authorizes POST /ingest/locations; when it is
/// absent the sync worker still claims+releases safely (401 → permanent-error
/// path, rows stay PENDING, no data loss).
class TokenStore {
  static const _kToken = 'auth_token_v1';
  static const _kDriverId = 'driver_id';
  static const _kVehicleId = 'vehicle_id';
  // Module 1 (onboarding without login): the phone the driver verified with OTP.
  // NOT a credential — just the recovery handle for POST /auth/pair-device when
  // this install's session has lapsed. Stored in cleartext by design (PDPP §1.7:
  // it is the driver's own number, already on the device).
  static const _kPhone = 'driver_phone_e164';
  static const _kRegistrationTicket = 'registration_ticket_v1';

  String? _token;
  String? _driverId;
  String? _vehicleId;
  String? _phone;
  String? _registrationTicket;

  /// Live accessor used by SyncWorker.httpUploader via a closure so a token
  /// refreshed mid-trip is picked up on the very next batch.
  String? get accessToken => _token;
  String? get driverId => _driverId;
  String? get vehicleId => _vehicleId;
  bool get hasToken => _token != null && _token!.isNotEmpty;

  /// Verified phone (E.164) for the silent session-restore / re-pairing flow.
  String? get phone => _phone;
  bool get hasPhone => _phone != null && _phone!.isNotEmpty;

  /// One-time OTP-verified registration ticket (15-min server TTL). Cleared by
  /// [clearRegistrationTicket] once /auth/register succeeds — never reused.
  String? get registrationTicket => _registrationTicket;

  Future<void> load() async {
    final sp = await SharedPreferences.getInstance();
    _token = sp.getString(_kToken);
    _driverId = sp.getString(_kDriverId);
    _vehicleId = sp.getString(_kVehicleId);
    _phone = sp.getString(_kPhone);
    _registrationTicket = sp.getString(_kRegistrationTicket);
  }

  /// Persist a successful login/pairing response.
  Future<void> save({
    required String token,
    String? driverId,
    String? vehicleId,
    String? phone,
  }) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kToken, token);
    if (driverId != null) await sp.setString(_kDriverId, driverId);
    if (vehicleId != null) await sp.setString(_kVehicleId, vehicleId);
    if (phone != null) await sp.setString(_kPhone, phone);
    _token = token;
    _driverId = driverId ?? _driverId;
    _vehicleId = vehicleId ?? _vehicleId;
    _phone = phone ?? _phone;
  }

  /// Remember the OTP-verified registration ticket between screens (and across
  /// process death) so the driver can fill the long form without re-entering
  /// the code. The SERVER enforces one-shot consumption at /auth/register.
  Future<void> saveRegistrationTicket(String ticket) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kRegistrationTicket, ticket);
    _registrationTicket = ticket;
  }

  Future<void> clearRegistrationTicket() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kRegistrationTicket);
    _registrationTicket = null;
  }

  /// Erasure hook (PDPP §1.7 item 4 companion): wipe local credentials.
  Future<void> clear() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken);
    await sp.remove(_kRegistrationTicket);
    _token = null;
    _registrationTicket = null;
  }

  /// Decode the `sub`/`role` claims of a JWT for diagnostics WITHOUT trusting
  /// them (signature verification belongs to the backend; this is display-only
  /// and used by the Phase 4 feedback payload). Never throws.
  Map<String, Object?> claimsSafe() {
    final t = _token;
    if (t == null) return const {};
    try {
      final parts = t.split('.');
      if (parts.length < 2) return const {};
      final normalized = base64Url.normalize(parts[1]);
      final decoded = jsonDecode(utf8.decode(base64Url.decode(normalized)));
      return decoded is Map<String, Object?> ? decoded : const {};
    } catch (_) {
      return const {};
    }
  }
}
