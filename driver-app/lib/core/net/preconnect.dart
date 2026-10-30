import 'dart:async';

import 'package:flutter/foundation.dart' show debugPrint, kDebugMode;
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import 'http_clients.dart';

/// Post-first-frame network warm-up (§STARTUP-OPTIMIZATION.md §5.4).
///
/// The cold-start budget (§1.9.1) forbids ANY network I/O before the usable
/// screen paints — so instead we pay the DNS + TCP + TLS handshake cost
/// immediately AFTER the first frame, off the critical path. By the time the
/// driver taps "Start Trip" (or the sync cadence fires), the connection pool
/// is already warm and the first real API call is a single RTT on an existing
/// keep-alive socket instead of a full cold handshake chain.
///
/// Guarantees:
///  * Non-blocking: fire-and-forget ([preconnectAfterFirstFrame]) — callers
///    never await it and errors never propagate to the UI.
///  * Cheap: one small GET; any status code (even 404/401) proves the
///    handshake succeeded — we care about the socket, not the response.
///  * Honest failure: timeouts / offline just log in debug; the next real
///    request behaves exactly like today's cold path. No retry storms — a
///    single best-effort attempt per call site.
Future<void> preconnectAfterFirstFrame({
  http.Client? client,
  String? baseUrl,
  Duration timeout = const Duration(seconds: 10),
}) async {
  final c = client ?? AppHttp.shared;
  final url = baseUrl ?? AppConfig.apiBaseUrl;
  try {
    await c.get(Uri.parse('$url/api/')).timeout(timeout);
  } catch (e) {
    // Offline / slow cell: fine. Warm-up is best-effort by design.
    if (kDebugMode) debugPrint('preconnect skipped: $e');
  }
}
