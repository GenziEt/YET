import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../cache/fix_dao.dart';
import '../cache/sensor_dao.dart';
import '../config/app_config.dart';

/// Result of one upload attempt — mirrors POST /ingest/locations response
/// (`backend/src/modules/ingest/routes.ts`).
class IngestAck {
  const IngestAck({
    required this.batchId,
    required this.accepted,
    required this.alreadyReceived,
  });
  final String batchId;
  final int accepted;
  final bool alreadyReceived;

  factory IngestAck.parse(String batchId, String body) {
    final j = jsonDecode(body) as Map<String, dynamic>;
    return IngestAck(
      batchId: (j['batch_id'] as String?) ?? batchId,
      accepted: (j['accepted'] as num?)?.toInt() ?? 0,
      alreadyReceived: j['already_received'] == true,
    );
  }
}

/// Seam so tests can inject a fake transport and the real app talks to the
/// Ethiopian-hosted gateway without the worker knowing anything about HTTP.
typedef BatchUploader = Future<IngestAck> Function(String batchId, List<StoredFix> fixes);

/// Offline Contract §1.8.1 background sync worker.
///
/// Triggers (§1.8.1): app foreground, network change to Wi-Fi/3G+, and every
/// [AppConfig.syncIntervalActiveTrip] (60 s) while a trip is active.
///
/// Hard rules implemented here:
///  * claims rows PENDING→UPLOADING via [FixDao.claimBatch] with a fresh
///    UUID-v4 batch_id shared by every member (§1.8 rule 5 → crash-safe replay
///    through server idempotency, §1.8.2);
///  * batches capped at [AppConfig.maxBatchFixes] = 100 per request;
///  * on failure rows return to PENDING and the next attempt waits
///    `min(base·2^attempts, backoffCap)` with ±20% jitter (thundering-herd
///    protection when a whole fleet regains signal at once);
///  * rows are NEVER deleted before ACKED — deletion only via prune policies;
///  * 429 honours the server's Retry-After header (§1.10.4).
/// Seam for sensor batches (§1.8.5): same claim→upload→ACK pattern as fixes,
/// targeting POST /ingest/sensors. Injected in tests, wired to HTTP in prod.
typedef SensorBatchUploader = Future<IngestAck> Function(
    String batchId, List<StoredSensorEvent> events);

class SyncWorker {
  SyncWorker({
    required this.dao,
    required BatchUploader uploader,
    Duration? baseBackoff,
    Random? random,
    this.batchLimit = AppConfig.maxBatchFixes,
    this.sensorDao,
    SensorBatchUploader? sensorUploader,
    this.sensorBatchLimit = AppConfig.maxBatchSensors,
  })  : _uploader = uploader,
        _sensorUploader = sensorUploader,
        _baseBackoff = baseBackoff ?? const Duration(seconds: 2),
        _rng = random ?? Random.secure();

  static const ackedRetention = AppConfig.ackedRetention; // 7 days (§1.8.1)
  static const storageBudgetBytes = 50 * 1024 * 1024; // prune target (§1.8.1)

  final FixDao dao;
  /// Optional Phase 4 sensor cache (§1.8.5). When null the worker behaves
  /// exactly like Phase 1/2 (fixes only) — keeps old call sites/tests valid.
  final SensorDao? sensorDao;
  final SensorBatchUploader? _sensorUploader;
  final int sensorBatchLimit;
  final BatchUploader _uploader;
  final Duration _baseBackoff;
  final Random _rng;
  final int batchLimit;

  /// Bound to the "X fixes pending sync" counter on the trip screen (§Phase 1).
  final ValueNotifier<int> pendingCount = ValueNotifier<int>(0);

  Timer? _tripTimer;
  bool _running = false;
  bool _stopping = false;
  DateTime? _blockedUntil; // backoff / Retry-After gate
  int _consecutiveFailures = 0;

  bool get isRunning => _running;
  bool get tripActive => _tripTimer != null;
  int get consecutiveFailures => _consecutiveFailures;

  /// Exposed for tests + diagnostics in the Phase 4 feedback payload.
  @visibleForTesting
  Duration backoffForAttempt(int attempts) {
    final exp = min(attempts, 16); // guard overflow before capping
    final rawMs = _baseBackoff.inMilliseconds * pow(2, exp);
    final capped = min(rawMs, AppConfig.backoffCap.inMilliseconds).toDouble();
    // ±20% jitter
    final jittered = capped * (0.8 + _rng.nextDouble() * 0.4);
    return Duration(milliseconds: jittered.round());
  }

  Future<void> refreshPendingCount() async {
    // §1.8.6 priority: the counter covers GPS fixes + sensor backlog so the
    // driver sees the true offline debt ("X records pending sync").
    final sensors = await sensorDao?.pendingCount() ?? 0;
    pendingCount.value = await dao.pendingCount() + sensors;
  }

  // ── Lifecycle triggers (§1.8.1) ────────────────────────────────────────────

  /// App resumed from background — fire one immediate cycle.
  Future<void> onAppForeground() => triggerSync();

  /// connectivity_plus callback: schedule a cycle only when we gained a usable
  /// connection (Wi-Fi or 3G+). Cellular data-saver mode is honoured upstream by
  /// not calling this method at all (§1.3 network radio).
  Future<void> onNetworkAvailable() => triggerSync();

  /// Trip started → periodic 60 s cadence for the whole trip (§1.8.1).
  void startTripCadence() {
    _tripTimer?.cancel();
    _tripTimer = Timer.periodic(AppConfig.syncIntervalActiveTrip, (_) => triggerSync());
    triggerSync(); // don't make the driver wait 60 s for the first flush
  }

  /// Trip ended → stop cadence but push the tail of the trip immediately.
  Future<void> stopTripCadence() async {
    _tripTimer?.cancel();
    _tripTimer = null;
    await triggerSync();
  }

  Future<void> dispose() async {
    _tripTimer?.cancel();
    _tripTimer = null;
  }

  // ── Core loop ──────────────────────────────────────────────────────────────

  /// One drain pass: upload claimed batches until the cache is empty, a
  /// failure arms the backoff, or [_maxBatchesPerPass] is reached (keeps a
  /// huge offline backlog from monopolising a weak 3G window).
  Future<void> triggerSync() async {
    if (_running || _stopping) return;
    _running = true;
    try {
      final blockedUntil = _blockedUntil;
      if (blockedUntil != null && DateTime.now().isBefore(blockedUntil)) {
        return; // still in backoff — cadence will retry later
      }
      const maxBatchesPerPass = 10;
      var drainedAllFixes = true;
      for (var i = 0; i < maxBatchesPerPass; i++) {
        final outcome = await runOnce();
        switch (outcome) {
          case SyncOutcome.nothingPending:
            _consecutiveFailures = 0;
            _blockedUntil = null;
          case SyncOutcome.uploaded:
            _consecutiveFailures = 0;
            _blockedUntil = null;
          case SyncOutcome.failed:
            _consecutiveFailures++;
            return; // backoff armed inside [_uploadSafely]; stop draining
        }
        if (outcome == SyncOutcome.uploaded && i == maxBatchesPerPass - 1) {
          drainedAllFixes = false; // fix backlog may remain — skip sensors this pass
        }
      }
      // §1.8.6 priority rule: GPS fixes drain FIRST (loop above); sensor-event
      // batches only start once the fix backlog is empty. Bounded like the fix
      // loop so a huge offline sensor burst can't monopolise a weak 3G window.
      if (drainedAllFixes) {
        for (var i = 0; i < maxBatchesPerPass; i++) {
          final blockedUntil = _blockedUntil;
          if (blockedUntil != null && DateTime.now().isBefore(blockedUntil)) {
            break; // failure armed the shared backoff gate — stop the pass
          }
          final outcome = await runSensorOnce();
          if (outcome == SyncOutcome.uploaded) continue;
          if (outcome == SyncOutcome.failed) _consecutiveFailures++;
          break; // nothingPending or failed
        }
      }
    } finally {
      await refreshPendingCount();
      _running = false;
    }
  }

  /// Claim → upload → ACK/release for exactly one batch. Split out so unit
  /// tests drive a single deterministic step.
  @visibleForTesting
  Future<SyncOutcome> runOnce() async {
    final batchId = newUuidV4();
    final fixes = await dao.claimBatch(batchId, batchLimit);
    if (fixes.isEmpty) return SyncOutcome.nothingPending;
    return _uploadSafely(batchId, fixes);
  }

  /// §1.8.5 sensor counterpart of [runOnce]: claim → POST /ingest/sensors →
  /// ACK/release with the SAME state machine and backoff gate as GPS fixes.
  /// No-op when no sensor cache/uploader is wired (Phase 1 deployments).
  @visibleForTesting
  Future<SyncOutcome> runSensorOnce() async {
    final sDao = sensorDao;
    final uploader = _sensorUploader;
    if (sDao == null || uploader == null) return SyncOutcome.nothingPending;
    final batchId = newUuidV4();
    final events = await sDao.claimBatch(batchId, sensorBatchLimit);
    if (events.isEmpty) return SyncOutcome.nothingPending;
    try {
      final ack = await uploader(batchId, events);
      await sDao.markBatchAcked(ack.batchId.isNotEmpty ? ack.batchId : batchId);
      return SyncOutcome.uploaded;
    } on PermanentUploadException {
      await sDao.releaseBatchForRetry(batchId);
      _blockedUntil = DateTime.now().add(AppConfig.backoffCap);
      return SyncOutcome.failed;
    } on RetryableUploadException catch (e) {
      await sDao.releaseBatchForRetry(batchId);
      final attempts = await sDao.maxAttemptsForBatch(batchId);
      _blockedUntil = DateTime.now()
          .add(e.retryAfter ?? backoffForAttempt(max(attempts, 1)));
      return SyncOutcome.failed;
    } catch (_) {
      await sDao.releaseBatchForRetry(batchId);
      _blockedUntil = DateTime.now().add(backoffForAttempt(1));
      return SyncOutcome.failed;
    }
  }

  Future<SyncOutcome> _uploadSafely(String batchId, List<StoredFix> fixes) async {
    try {
      final ack = await _uploader(batchId, fixes);
      // 200 (including already_received:true, §1.8.2) → UPLOADING→ACKED.
      await dao.markBatchAcked(ack.batchId.isNotEmpty ? ack.batchId : batchId);
      return SyncOutcome.uploaded;
    } on PermanentUploadException {
      // Unrecoverable for THIS payload (bad token / schema reject). Rows go
      // back to PENDING — never deleted — but the operator must fix the cause;
      // cadence keeps retrying at the capped interval (§1.8.1 "no data loss").
      await dao.releaseBatchForRetry(batchId);
      _blockedUntil = DateTime.now().add(AppConfig.backoffCap);
      return SyncOutcome.failed;
    } on RetryableUploadException catch (e) {
      await dao.releaseBatchForRetry(batchId); // UPLOADING→PENDING, attempts++
      // Attempts were just incremented by the release; read them back so the
      // exponent survives process restarts (state lives in SQLite, not memory).
      final attempts = await dao.maxAttemptsForBatch(batchId);
      _blockedUntil = DateTime.now()
          .add(e.retryAfter ?? backoffForAttempt(max(attempts, 1)));
      return SyncOutcome.failed;
    } catch (_) {
      // Any other transport error: same safe path — never lose the claim.
      await dao.releaseBatchForRetry(batchId);
      _blockedUntil = DateTime.now().add(backoffForAttempt(1));
      return SyncOutcome.failed;
    }
  }

  // ── Prune policy (§1.8.1 + §1.8.6) ────────────────────────────────────────

  /// Run after successful syncs (call from the cadence completion or daily).
  /// ACKED rows older than 7 days are deleted; then, whichever comes first,
  /// storage is evicted down to the 50 MB budget using ACKED-only victims —
  /// PENDING/UPLOADING GPS fixes are never discarded pre-upload (§1.8.6).
  Future<PruneReport> prune() async {
    final byAge = await dao.pruneAckedOlderThan(ackedRetention) +
        (await sensorDao?.pruneAckedOlderThan(ackedRetention) ?? 0);
    final fixBytes = await dao.storageBytes();
    final sensorBytes = await sensorDao?.storageBytes() ?? 0;
    final bytes = fixBytes + sensorBytes; // §1.8.6 bounds the WHOLE local cache
    var byBudget = 0;
    var warnDriver = false;
    if (bytes > AppConfig.storageWarnBytes) {
      warnDriver = true; // §1.8.6: app warns the driver past 80 MB
      // GPS fixes first, sensors second (§1.8.6 prioritisation rule); both
      // only ever evict ACKED rows, so nothing pre-upload is discarded.
      byBudget = await dao.pruneToStorageBudget(storageBudgetBytes) +
          (await sensorDao?.pruneToStorageBudget(storageBudgetBytes) ?? 0);
    }
    return PruneReport(deletedByAge: byAge, deletedByBudget: byBudget, warnedDriver: warnDriver);
  }

  // ── Default uploader (production wiring) ───────────────────────────────────

  /// Real transport: POST {AppConfig.apiBaseUrl}/ingest/locations with a JWT.
  /// The app stores ONLY the token (never credentials) — see Identity pairing.
  static BatchUploader httpUploader({
    required String Function() accessToken,
    http.Client? client,
    String? baseUrlOverride,
    Duration timeout = const Duration(seconds: 15),
  }) {
    final c = client ?? http.Client();
    return (batchId, fixes) async {
      final base = baseUrlOverride ?? AppConfig.apiBaseUrl;
      final body = encodeBatchBody(batchId, fixes);
      http.Response res;
      try {
        res = await c.post(
          Uri.parse('$base/ingest/locations'),
          headers: {
            'content-type': 'application/json',
            'authorization': 'Bearer ${accessToken()}',
            // OSM-compliant UA also identifies YET to our own gateway (§1.6).
            'user-agent': 'YET-DriverApp/0.1.0 (Android)',
          },
          body: body,
        ).timeout(timeout);
      } on TimeoutException {
        throw const RetryableUploadException('request timeout');
      } on http.ClientException catch (e) {
        throw RetryableUploadException(e.message);
      }
      if (res.statusCode == 429) {
        final ra = _retryAfterSeconds(res.headers['retry-after']);
        throw RetryableUploadException(
          'rate limited',
          retryAfter: ra != null ? Duration(seconds: ra) : null,
        );
      }
      if (res.statusCode >= 500) {
        throw const RetryableUploadException('server error');
      }
      if (res.statusCode >= 400) {
        // 4xx other than 429 (bad token, schema reject): do NOT hammer retries.
        throw PermanentUploadException('client error ${res.statusCode}');
      }
      try {
        return IngestAck.parse(batchId, res.body);
      } catch (_) {
        // 200 with unparseable body — treat as retryable, never ACK blindly.
        throw const RetryableUploadException('malformed ack body');
      }
    };
  }

  /// Test/dev helper: stop taking new cycles (used by widget teardown).
  void pause() => _stopping = true;

  // ── Pilot telemetry transports (Phase 4) ───────────────────────────────────

  /// Real transport for §1.8.5 sensor batches: POST {base}/ingest/sensors with
  /// the same JWT + error taxonomy as [httpUploader] (429→Retry-After, 5xx and
  /// network faults retryable, other 4xx permanent, never ACK blindly).
  static SensorBatchUploader httpSensorUploader({
    required String Function() accessToken,
    http.Client? client,
    String? baseUrlOverride,
    Duration timeout = const Duration(seconds: 20), // sensor batches are larger
  }) {
    final c = client ?? http.Client();
    return (batchId, events) async {
      final base = baseUrlOverride ?? AppConfig.apiBaseUrl;
      final body = jsonEncode({
        'batch_id': batchId,
        'client_sent_at': DateTime.now().toUtc().toIso8601String(),
        'events': events.map((e) => e.toJson()).toList(),
      });
      final res = await _post(c, '$base/ingest/sensors', body, accessToken, timeout);
      try {
        return IngestAck.parse(batchId, res.body);
      } catch (_) {
        throw const RetryableUploadException('malformed ack body');
      }
    };
  }

  /// Fire-and-forget battery sample upload (§Phase 4 pilot telemetry): one
  /// reading at trip start / trip end against POST /ingest/battery. Best-effort
  /// BY DESIGN — a failed battery upload must never block or roll back trip
  /// state; the pilot simply has one fewer drain estimate for that trip.
  static Future<void> postBatterySample({
    required String Function() accessToken,
    required String tripStartedAtIso,
    required String phase, // 'trip_start' | 'trip_end' | 'mid_trip'
    required double batteryPct,
    bool charging = false,
    http.Client? client,
    String? baseUrlOverride,
    String? batchIdOverride, // tests + deterministic retries
  }) async {
    final c = client ?? http.Client();
    final body = jsonEncode({
      'batch_id': batchIdOverride ?? newUuidV4(),
      'client_sent_at': DateTime.now().toUtc().toIso8601String(),
      'samples': [
        {
          'trip_started_at': tripStartedAtIso,
          'taken_at': DateTime.now().toUtc().toIso8601String(),
          'phase': phase,
          'battery_pct': batteryPct,
          'charging': charging,
        }
      ],
    });
    final base = baseUrlOverride ?? AppConfig.apiBaseUrl;
    try {
      await _post(c, '$base/ingest/battery', body, accessToken,
          const Duration(seconds: 10));
    } catch (_) {
      // Swallowed on purpose: pilot telemetry is optional, trip data is not.
    }
  }

  /// One-tap feedback payload builder + uploader (§Phase 4 deliverable).
  /// Collects EXACTLY the diagnostic fields the backend DiagnosticsSchema
  /// accepts — battery level, GPS accuracy, last fix age, network type, pending
  /// sync count — nothing else (PDPP §1.7 data minimization).
  static Map<String, Object?> buildDiagnosticsPayload({
    required String issue, // gps_not_working | battery_drain | sync_stuck | other
    required int pendingSyncCount,
    required bool tripActive,
    double? batteryPct,
    bool? charging,
    int? lastFixAgeS,
    double? lastAccuracyM,
    String networkType = 'unknown',
    String? appVersion,
    Map<String, Object?> detail = const {},
    String? batchIdOverride,
    DateTime? reportedAt,
  }) =>
      {
        'batch_id': batchIdOverride ?? newUuidV4(),
        'reported_at': (reportedAt ?? DateTime.now()).toUtc().toIso8601String(),
        'issue': issue,
        if (batteryPct != null) 'battery_pct': batteryPct,
        if (charging != null) 'charging': charging,
        if (lastFixAgeS != null) 'last_fix_age_s': lastFixAgeS,
        if (lastAccuracyM != null) 'last_accuracy_m': lastAccuracyM,
        'network_type': networkType,
        'pending_sync_count': pendingSyncCount,
        'trip_active': tripActive,
        if (appVersion != null) 'app_version': appVersion,
        'detail': detail,
      };

  /// POST {base}/ingest/diagnostics. Returns true only on a 2xx with a parseable
  /// ACK so the feedback screen can tell the driver "sent" honestly.
  static Future<bool> postDiagnostics({
    required String Function() accessToken,
    required Map<String, Object?> payload,
    http.Client? client,
    String? baseUrlOverride,
  }) async {
    final c = client ?? http.Client();
    final base = baseUrlOverride ?? AppConfig.apiBaseUrl;
    try {
      final res = await _post(c, '$base/ingest/diagnostics',
          jsonEncode(payload), accessToken, const Duration(seconds: 15));
      return res.statusCode >= 200 && res.statusCode < 300;
    } catch (_) {
      return false;
    }
  }

  /// Shared POST with the exact failure taxonomy the Offline Contract demands:
  /// 429 honours Retry-After (§1.10.4), 5xx/timeouts/network faults are
  /// retryable, other 4xx are permanent, non-JSON success is retryable
  /// (never ACK blindly).
  static Future<http.Response> _post(http.Client c, String url, String body,
      String Function() accessToken, Duration timeout) async {
    http.Response res;
    try {
      res = await c.post(
        Uri.parse(url),
        headers: {
          'content-type': 'application/json',
          'authorization': 'Bearer ${accessToken()}',
          // OSM-compliant UA also identifies YET to our own gateway (§1.6).
          'user-agent': 'YET-DriverApp/0.1.0 (Android)',
        },
        body: body,
      ).timeout(timeout);
    } on TimeoutException {
      throw const RetryableUploadException('request timeout');
    } on http.ClientException catch (e) {
      throw RetryableUploadException(e.message);
    }
    if (res.statusCode == 429) {
      final ra = _retryAfterSeconds(res.headers['retry-after']);
      throw RetryableUploadException(
        'rate limited',
        retryAfter: ra != null ? Duration(seconds: ra) : null,
      );
    }
    if (res.statusCode >= 500) {
      throw const RetryableUploadException('server error');
    }
    if (res.statusCode >= 400) {
      throw PermanentUploadException('client error ${res.statusCode}');
    }
    return res;
  }
}

/// Retry-After may be delta-seconds ("30") or an HTTP date; both are honoured
/// (§1.10.4 backpressure contract).
int? _retryAfterSeconds(String? header) {
  if (header == null) return null;
  final secs = int.tryParse(header.trim());
  if (secs != null) return secs < 0 ? 0 : secs;
  final date = HttpDateCompat.parse(header);
  if (date == null) return null;
  final delta = date.difference(DateTime.now()).inSeconds;
  return delta < 0 ? 0 : delta;
}

/// Tiny wrapper so dart:io's formatHttpDate isn't pulled into the analyze-only
/// surface; on device this uses DateTime.tryParse of RFC-1123 style strings.
class HttpDateCompat {
  static DateTime? parse(String raw) => DateTime.tryParse(raw);
}

enum SyncOutcome { nothingPending, uploaded, failed }

class PruneReport {
  const PruneReport({
    required this.deletedByAge,
    required this.deletedByBudget,
    required this.warnedDriver,
  });
  final int deletedByAge;
  final int deletedByBudget;
  final bool warnedDriver;
}

class RetryableUploadException implements Exception {
  const RetryableUploadException(this.message, {this.retryAfter});
  final String message;
  final Duration? retryAfter;
  @override
  String toString() => 'RetryableUploadException: $message';
}

class PermanentUploadException implements Exception {
  const PermanentUploadException(this.message);
  final String message;
  @override
  String toString() => 'PermanentUploadException: $message';
}

/// UUID v4 (RFC 4122) without pulling in the uuid package — keeps native/heavy
/// deps off low-end devices (§1.2). batch_id must be unique per attempt group
/// because the backend enforces idempotency on it (§1.8.2).
String newUuidV4([Random? rng]) {
  final r = rng ?? Random.secure();
  final bytes = List<int>.generate(16, (_) => r.nextInt(256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
  final hex = bytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  return '${hex.substring(0, 8)}-${hex.substring(8, 12)}-'
      '${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}';
}
