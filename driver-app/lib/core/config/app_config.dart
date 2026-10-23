import 'dart:io' show Platform;
import 'package:flutter/foundation.dart' show kDebugMode;
import 'package:flutter/widgets.dart' show Locale;

/// Single place for environment endpoints. Production API MUST be served from an
/// Ethiopian data center (PDPP §1.7 data sovereignty) — enforced by deployment,
/// documented here so engineers cannot silently point builds at foreign clouds.
class AppConfig {
  static String apiBaseUrl = kDebugMode
      ? 'http://10.0.2.2:3000' // Android emulator host loopback
      : 'https://api.yet.et';   // Ethiopian-hosted gateway (nginx -> api container)

  /// Self-hosted tile server URL template (blueprint §1.6). Public OSM tiles are
  /// forbidden in production (§1.9.3) — flutter_map in Phase 1 must use this only.
  static String tileUrlTemplate = kDebugMode
      ? 'http://10.0.2.2:8082/styles/bright/{z}/{x}/{y}.png'
      : 'https://tiles.yet.et/{z}/{x}/{y}.png';

  static const consentPolicyVersion = 'consent-v1';

  /// Offline Contract §1.8.1 sync worker cadence.
  static const syncIntervalActiveTrip = Duration(seconds: 60);
  static const maxBatchFixes = 100;               // per Phase 1 deliverable
  static const backoffCap = Duration(minutes: 5); // exponential backoff cap
  static const storageWarnBytes = 80 * 1024 * 1024; // §1.8.6 warn threshold
  static const storageHardCapBytes = 100 * 1024 * 1024;
  static const ackedRetention = Duration(days: 7); // ACKED pruned after 7 days (§1.8.1)

  static bool get isAndroid => Platform.isAndroid;

  /// Amharic-first at launch (§1.2 driver interaction). Falls back to device locale.
  static get defaultLocale => const Locale('am');
}
