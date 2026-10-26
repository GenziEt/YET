import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:http/http.dart' as http;

import '../../core/config/app_config.dart';

/// Local + server-side consent state (PDPP §1.7, Phase 0 gate).
/// The local flag unblocks the UI immediately (offline-first); the server record is
/// the compliance artifact. If the POST fails offline, we retry on next app start —
/// consent is stored locally first so nothing is ever collected before acceptance.
class ConsentRepository {
  static const _kAccepted = 'consent_accepted_v1';
  static const _kScopes = 'consent_scopes';
  static const _kPermsAck = 'permissions_acknowledged';
  static const _kPendingSync = 'consent_pending_sync';

  bool accepted = false;
  bool permissionsAcknowledged = false;

  Future<void> loadLocal() async {
    final sp = await SharedPreferences.getInstance();
    accepted = sp.getBool(_kAccepted) ?? false;
    permissionsAcknowledged = sp.getBool(_kPermsAck) ?? false;
    final scopes = _decodeScopes(sp.getString(_kScopes));
    if (accepted && (sp.getBool(_kPendingSync) ?? false)) {
      // Fire-and-forget replay of a consent that was accepted while offline.
      _syncToServer(scopes).ignore();
    }
  }

  /// Explicit opt-in. Stores locally FIRST (so collection may begin), then records
  /// server-side. Max-3-tap rule (§1.2): this is one tap from the consent screen.
  Future<void> accept({required List<String> scopes, String? token}) async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(_kAccepted, true);
    await sp.setString(_kScopes, jsonEncode(scopes));
    accepted = true;
    final ok = await _syncToServer(scopes, token: token);
    await sp.setBool(_kPendingSync, !ok);
  }

  Future<void> decline() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(_kAccepted, false);
    accepted = false;
  }

  Future<void> acknowledgePermissions() async {
    final sp = await SharedPreferences.getInstance();
    await sp.setBool(_kPermsAck, true);
    permissionsAcknowledged = true;
  }

  Future<bool> _syncToServer(List<String> scopes, {String? token}) async {
    try {
      final res = await http
          .post(Uri.parse('${AppConfig.apiBaseUrl}/consent'), headers: {
            'content-type': 'application/json',
            if (token != null) 'authorization': 'Bearer $token',
          })
          .timeout(const Duration(seconds: 15))
          .then((r) => r);
      // 401 until login exists (P1) — local consent still valid; queued for sync.
      return res.statusCode == 201 || res.statusCode == 200;
    } catch (_) {
      return false;
    }
  }

  static List<String> _decodeScopes(String? raw) {
    if (raw == null) return const [];
    try {
      return (jsonDecode(raw) as List).cast<String>();
    } catch (_) {
      return const [];
    }
  }
}
