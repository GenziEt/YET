import 'dart:io' show HttpClient;

import 'package:http/http.dart' as http;
import 'package:http/io_client.dart';

/// Shared, handshake-optimised HTTP clients (§STARTUP-OPTIMIZATION.md §5.4).
///
/// Rationale — the "buttery smooth" first upload / first API call depends on
/// how many round trips the *first* request pays for:
///  * DNS resolution          (1 UDP RTT, or more with IPv6 fallback)
///  * TCP handshake           (1 RTT)
///  * TLS handshake           (1–2 RTTs; 0-RTT not used by Dart's stack)
///  * HTTP/1.1 per-request    (no connection reuse ⇒ all of the above, again)
///
/// A single long-lived [HttpClient] behind an [http.Client] amortises ALL of
/// that across every request the app makes (sync uploads, /me assignment
/// checks, config fetches, push-token registration, tile prefetch): the very
/// first request warms the socket pool + keep-alive connections, and every
/// later call rides an already-open connection — zero handshakes.
///
/// This is deliberately ONE process-wide instance (`shared`), created lazily
/// so merely importing this file costs nothing at startup. It replaces the
/// previous per-call-site `http.Client()` defaults, each of which spun up its
/// own fresh DNS+TCP+TLS cycle per burst of traffic.
class AppHttp {
  AppHttp._();

  /// Idle time before a pooled keep-alive connection is retired. Must stay
  /// BELOW the edge gateway's `keepalive_timeout` (infra/nginx.conf: 75 s) so
  /// the client never hands out a connection the server has already closed
  /// (which would force a silent reconnect + fresh handshake mid-upload).
  static const Duration idleTimeout = Duration(seconds: 60);

  /// Per-host connection cap. Uploads, /me checks and tile prefetch can
  /// overlap; 8 keeps bursts parallel without tripping nginx rate zones.
  static const int maxConnectionsPerHost = 8;

  /// Lazily-created, process-wide optimised IO client.
  ///
  /// IMPORTANT: never call `close()` on [shared] — it is a singleton reused by
  /// SyncWorker, PilotService, PushService and Preconnect alike. Disposing a
  /// shared HttpClient mid-trip would kill in-flight keep-alive pools and
  /// force full re-handshakes exactly when the driver needs latency lowest.
  static final http.Client shared = _build();

  static http.Client _build() {
    final inner = HttpClient()
      ..idleTimeout = idleTimeout
      ..maxConnectionsPerHost = maxConnectionsPerHost
      // Ethiopian networks frequently traverse captive proxies; honour the
      // system proxy env so corporate/pilot SIMs with APN proxies still work.
      ..findProxy = HttpClient.findProxyFromEnvironment;
    return IOClient(inner);
  }

  /// Test seam only: build an isolated optimised client (the caller owns and
  /// must dispose it). Production code must use [shared].
  static http.Client newOptimisedClient() => _build();
}
