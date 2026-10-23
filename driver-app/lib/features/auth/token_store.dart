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

  String? _token;
  String? _driverId;
  String? _vehicleId;

  /// Live accessor used by SyncWorker.httpUploader via a closure so a token
  /// refreshed mid-trip is picked up on the very next batch.
  String? get accessToken => _token;
  String? get driverId => _driverId;
  String? get vehicleId => _vehicleId;
  bool get hasToken => _token != null && _token!.isNotEmpty;

  Future<void> load() async {
    final sp = await SharedPreferences.getInstance();
    _token = sp.getString(_kToken);
    _driverId = sp.getString(_kDriverId);
    _vehicleId = sp.getString(_kVehicleId);
  }

  /// Persist a successful login/pairing response.
  Future<void> save({
    required String token,
    String? driverId,
    String? vehicleId,
  }) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setString(_kToken, token);
    if (driverId != null) await sp.setString(_kDriverId, driverId);
    if (vehicleId != null) await sp.setString(_kVehicleId, vehicleId);
    _token = token;
    _driverId = driverId ?? _driverId;
    _vehicleId = vehicleId ?? _vehicleId;
  }

  /// Erasure hook (PDPP §1.7 item 4 companion): wipe local credentials.
  Future<void> clear() async {
    final sp = await SharedPreferences.getInstance();
    await sp.remove(_kToken);
    _token = null;
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
