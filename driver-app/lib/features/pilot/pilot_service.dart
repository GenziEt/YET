import 'dart:async';
import 'dart:convert';
import 'dart:io' show Directory, File, Platform;
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http';
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../core/config/app_config.dart';
import '../../core/sync/sync_worker.dart';
import '../auth/token_store.dart';

/// Reading of the device battery — injected seam so tests fabricate levels and
/// on-device builds wire `battery_plus` (or MethodChannel `android.os.BatteryManager`)
/// without this file importing any plugin (§1.2 low-end Android rule).
class BatteryReading {
  const BatteryReading({required this.levelPct, this.charging = false});
  /// State-of-charge percent 0..100 (Android BatteryManager.EXTRA_LEVEL scaled).
  final double levelPct;
  /// Charging reads are EXCLUDED from drain math by the backend gate kernel —
  /// a plugged-in phone would otherwise fake a "battery improved" trip.
  final bool charging;
}

typedef BatteryReader = Future<BatteryReading> Function();

/// Default [BatteryReader] used when the host has not injected the real
/// `battery_plus` reader. Returns an unreadable sentinel (level -1, not
/// charging) so every call site's existing guard applies its documented
/// honest-skip policy (-1 → sample omitted; diagnostics omit the optional
/// fields) instead of fabricating a level. The production bootstrap ALWAYS
/// injects `BatteryPlusReader().asReader()` (lib/platform/battery_source.dart);
/// this class exists only for headless test harnesses that construct
/// PilotService directly.
class UnavailableBatteryReader {
  const UnavailableBatteryReader();

  /// Sentinel battery reading: level -1 is skipped by postBatterySample and
  /// charging reports false — no telemetry is emitted for an unread device.
  Future<BatteryReading> read() async =>
      const BatteryReading(levelPct: -1, charging: false);
}

/// Cached vehicle assignment shown on the trip screen (one-tap start, §1.2
/// max-3-taps + Phase 4 "confirms vehicle assignment"). Mirrors GET /me's
/// `vehicle` object (`backend/src/modules/identity/routes.ts`).
class VehicleAssignment {
  const VehicleAssignment({
    required this.vehicleId,
    required this.plateNumber,
    this.fleetName,
  });
  final String vehicleId;
  final String plateNumber;
  final String? fleetName;

  factory VehicleAssignment.fromJson(Map<String, Object?> j) =>
      VehicleAssignment(
        vehicleId: j['vehicle_id'] as String,
        plateNumber: j['plate_number'] as String? ?? '',
        fleetName: j['fleet_name'] as String?,
      );

  String get label => fleetName == null || fleetName!.isEmpty
      ? plateNumber
      : '$plateNumber · $fleetName';
}

/// Outcome of the one-tap "Start Trip" assignment confirmation.
enum AssignmentCheck {
  confirmed, // driver has an active vehicle — tracking may begin
  noVehicle, // fleet manager must assign a vehicle first (still allow tracking)
  offlineCached, // network failed but a cached assignment exists → proceed
  offlineUnknown, // network failed AND nothing cached → warn, still allow tap
}

/// Web-Mercator tile math for the offline pre-download bounding box (§Phase 4:
/// "Offline map tile cache for pilot region ... downloaded before departure
/// using self-hosted tile server"). Pure + static so unit tests pin zoom-count
/// expectations without touching the filesystem.
class TileBounds {
  const TileBounds({
    required this.minLat,
    required this.minLng,
    required this.maxLat,
    required this.maxLng,
    required this.minZoom,
    required this.maxZoom,
  });

  /// Addis Ababa corridor used by the field pilot (blueprint Part 2 Phase 4).
  static const addisCorridor = TileBounds(
    minLat: 8.4, minLng: 38.5, maxLat: 9.2, maxLng: 39.0,
    minZoom: 6, maxZoom: 12,
  );

  final double minLat, minLng, maxLat, maxLng;
  final int minZoom, maxZoom;

  static double _tileX(double lng, int z) => (lng + 180) / 360 * (1 << z);

  /// Standard Web-Mercator Y formula: y = (1 − ln(tan φ + sec φ)/π)/2 · 2^z.
  static double _tileY(double lat, int z) {
    final rad = lat * math.pi / 180;
    final merc = math.log(math.tan(rad) + 1 / math.cos(rad));
    return (1 - merc / math.pi) * 0.5 * (1 << z);
  }

  /// Inclusive tile index range at zoom [z].
  List<int> xRange(int z) => [
        _tileX(minLng, z).floor().clamp(0, (1 << z) - 1),
        _tileX(maxLng, z).floor().clamp(0, (1 << z) - 1),
      ];

  List<int> yRange(int z) => [
        _tileY(maxLat, z).floor().clamp(0, (1 << z) - 1),
        _tileY(minLat, z).floor().clamp(0, (1 << z) - 1),
      ];

  /// Total tiles across all zooms — drives the progress counter honestly.
  int countTiles() {
    var total = 0;
    for (var z = minZoom; z <= maxZoom; z++) {
      final xr = xRange(z);
      final yr = yRange(z);
      total += (xr[1] - xr[0] + 1) * (yr[1] - yr[0] + 1);
    }
    return total;
  }
}

/// Progress snapshot for the offline-map screen (throttled notifications).
class TileProgress {
  const TileProgress({
    required this.done,
    required this.total,
    required this.failed,
    required this.finished,
  });
  final int done;
  final int total;
  final int failed;
  final bool finished;
  double get fraction => total == 0 ? 1 : done / total;
}

/// Phase 4 pilot service: everything the field pilot needs that is NOT the
/// Offline Contract core — battery sampling, one-tap assignment confirmation,
/// feedback diagnostics, offline tile pre-download. All transports reuse
/// [SyncWorker]'s static HTTP helpers so auth/error taxonomy stays in ONE place.
class PilotService {
  PilotService({
    required TokenStore tokenStore,
    http.Client? client,
    BatteryReader batteryReader = const UnavailableBatteryReader().read,
    String Function()? networkTypeProvider,
  })  : _tokens = tokenStore,
        _client = client ?? http.Client(),
        _batteryReader = batteryReader,
        _networkTypeProvider = networkTypeProvider;

  final TokenStore _tokens;
  final http.Client _client;
  final BatteryReader _batteryReader;
  final String Function()? _networkTypeProvider;

  static const _kVehicle = 'pilot_vehicle_v1';

  DateTime? _tripStartedAt;
  VehicleAssignment? _assignmentCache;
  bool _prefsLoaded = false;

  String? get accessToken => _tokens.accessToken;

  // ── Battery sampling (§Phase 4 deliverable) ────────────────────────────────

  /// Anchor timestamp for the current trip; set by AppRuntime on start-trip.
  void markTripStartAnchor(DateTime startedAtUtc) =>
      _tripStartedAt = startedAtUtc.toUtc();

  DateTime? get tripStartedAt => _tripStartedAt;

  /// Read the battery and POST one sample. Best-effort BY DESIGN: never throws,
  /// never blocks trip state — a missing sample just means one fewer drain
  /// estimate in the pilot rollup (backend upserts per (vehicle, trip, phase)).
  Future<void> sampleTripStart() async {
    final anchor = (_tripStartedAt ?? DateTime.now()).toUtc();
    final pct = await _readLevel();
    if (pct < 0) return; // battery unreadable → skip (never send a fake reading)
    await SyncWorker.postBatterySample(
      accessToken: () => _tokens.accessToken ?? '',
      tripStartedAtIso: anchor.toIso8601String(),
      phase: 'trip_start',
      batteryPct: pct,
      charging: await _readCharging(),
      client: _client,
    );
  }

  Future<void> sampleTripEnd() async {
    final anchor = (_tripStartedAt ?? DateTime.now()).toUtc();
    final pct = await _readLevel();
    if (pct >= 0) {
      await SyncWorker.postBatterySample(
        accessToken: () => _tokens.accessToken ?? '',
        tripStartedAtIso: anchor.toIso8601String(),
        phase: 'trip_end',
        batteryPct: pct,
        charging: await _readCharging(),
        client: _client,
      );
    }
    _tripStartedAt = null;
  }

  Future<double> _readLevel() async {
    try {
      final r = await _batteryReader();
      return r.levelPct.clamp(0, 100).toDouble();
    } catch (_) {
      return -1; // sentinel: postBatterySample skips samples with pct < 0 below
    }
  }

  Future<bool> _readCharging() async {
    try {
      final r = await _batteryReader();
      return r.charging;
    } catch (_) {
      return false;
    }
  }

  // ── One-tap Start Trip: vehicle-assignment confirmation (§1.2) ─────────────

  /// Last known assignment (cache survives offline starts).
  VehicleAssignment? get cachedAssignment => _assignmentCache;

  Future<void> loadPrefs() async {
    if (_prefsLoaded) return;
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(_kVehicle);
    if (raw != null) {
      try {
        final j = jsonDecode(raw);
        if (j is Map<String, Object?>) {
          _assignmentCache = VehicleAssignment.fromJson(j);
        }
      } catch (_) {/* corrupt cache -> treat as unknown */}
    }
    _prefsLoaded = true;
  }

  /// Confirm the driver has an assigned vehicle BEFORE tracking starts, so the
  /// first fix lands stamped with a vehicle the fleet manager actually handed
  /// out. Offline tolerance is deliberate: a driver in a no-signal depot must
  /// still be able to start (max-3-taps rule) — cached/unknown proceeds.
  Future<AssignmentCheck> confirmVehicleAssignment() async {
    await loadPrefs();
    final token = _tokens.accessToken;
    if (token == null || token.isEmpty) {
      return _assignmentCache != null
          ? AssignmentCheck.offlineCached
          : AssignmentCheck.offlineUnknown;
    }
    try {
      final res = await _client
          .get(Uri.parse('${AppConfig.apiBaseUrl}/me'), headers: {
        'authorization': 'Bearer $token',
        'user-agent': 'YET-DriverApp/0.1.0 (Android)',
      }).timeout(const Duration(seconds: 10));
      if (res.statusCode == 200) {
        final j = jsonDecode(res.body) as Map<String, Object?>;
        final v = j['vehicle'];
        if (v is Map<String, Object?> && v['vehicle_id'] is String) {
          final a = VehicleAssignment.fromJson(v);
          _assignmentCache = a;
          final sp = await SharedPreferences.getInstance();
          await sp.setString(_kVehicle, jsonEncode({
            'vehicle_id': a.vehicleId,
            'plate_number': a.plateNumber,
            'fleet_name': a.fleetName,
          }));
          return AssignmentCheck.confirmed;
        }
        _assignmentCache = null;
        return AssignmentCheck.noVehicle;
      }
      // Auth rejected etc.: fall back to cache — do not block the driver.
      return _assignmentCache != null
          ? AssignmentCheck.offlineCached
          : AssignmentCheck.offlineUnknown;
    } catch (_) {
      return _assignmentCache != null
          ? AssignmentCheck.offlineCached
          : AssignmentCheck.offlineUnknown;
    }
  }

  // ── Feedback diagnostics (§Phase 4 deliverable) ────────────────────────────

  /// Collect EXACTLY the DiagnosticsSchema fields (PDPP minimization) and POST
  /// /ingest/diagnostics. Returns true only when the server accepted it.
  Future<bool> sendFeedback({
    required String issue, // gps_not_working | battery_drain | sync_stuck | other
    required int pendingSyncCount,
    required bool tripActive,
    int? lastFixAgeS,
    double? lastAccuracyM,
    Map<String, Object?> detail = const {},
  }) async {
    double? batteryPct;
    bool? charging;
    try {
      final r = await _batteryReader();
      batteryPct = r.levelPct.clamp(0, 100).toDouble();
      charging = r.charging;
    } catch (_) {
      // Battery unreadable → omit optional fields rather than lie.
    }
    final payload = SyncWorker.buildDiagnosticsPayload(
      issue: issue,
      pendingSyncCount: pendingSyncCount,
      tripActive: tripActive,
      batteryPct: batteryPct,
      charging: charging,
      lastFixAgeS: lastFixAgeS,
      lastAccuracyM: lastAccuracyM,
      networkType: _networkTypeProvider?.call() ?? 'unknown',
      appVersion: '0.1.0',
      detail: detail,
    );
    return SyncWorker.postDiagnostics(
      accessToken: () => _tokens.accessToken ?? '',
      payload: payload,
      client: _client,
    );
  }

  // ── Offline tile pre-download (§Phase 4 deliverable) ───────────────────────

  static const tileCacheDirName = 'offline_tiles';

  Future<Directory> tileCacheRoot() async {
    final base = await getApplicationSupportDirectory();
    final dir = Directory('${base.path}$separator$tileCacheDirName');
    if (!await dir.exists()) await dir.create(recursive: true);
    return dir;
  }

  static String get separator => Platform.isWindows ? '\\' : '/';

  /// Download every tile in [bounds] from the SELF-HOSTED tile server only
  /// (§1.9.3: public OSM servers forbidden in production; AppConfig.tileUrlTemplate
  /// points at tiles.yet.et). Resumable: existing files are skipped, so a driver
  /// can re-run after a signal drop mid-download. Concurrency bounded for slow
  /// storage/network on low-end devices (§1.2).
  Future<TileProgress> prefetchTiles(
    TileBounds bounds, {
    void Function(TileProgress)? onProgress,
    int concurrency = 4,
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final template = AppConfig.tileUrlTemplate;
    final root = await tileCacheRoot();
    final jobs = <_TileJob>[];
    for (var z = bounds.minZoom; z <= bounds.maxZoom; z++) {
      final xr = bounds.xRange(z);
      final yr = bounds.yRange(z);
      for (var x = xr[0]; x <= xr[1]; x++) {
        for (var y = yr[0]; y <= yr[1]; y++) {
          jobs.add(_TileJob(z, x, y));
        }
      }
    }
    final total = jobs.length;
    var done = 0, failed = 0, notifiedAt = -1;
    final queue = jobs.toList();

    void emit(bool finished) {
      // Throttle UI rebuilds: notify on every 25 tiles or completion.
      if (!finished && done - notifiedAt < 25) return;
      notifiedAt = done;
      onProgress?.call(
          TileProgress(done: done, total: total, failed: failed, finished: finished));
    }

    Future<void> worker() async {
      while (queue.isNotEmpty) {
        final job = queue.removeAt(0);
        final rel = '${job.z}${separator}${job.x}${separator}${job.y}.png';
        final f = File('${root.path}$separator$rel');
        if (await f.exists()) {
          done++;
          emit(false);
          continue;
        }
        try {
          final url = template
              .replaceAll('{z}', '${job.z}')
              .replaceAll('{x}', '${job.x}')
              .replaceAll('{y}', '${job.y}');
          final res = await _client
              .get(Uri.parse(url),
                  headers: const {'user-agent': 'YET-DriverApp/0.1.0 (Android)'})
              .timeout(timeout);
          if (res.statusCode == 200 && res.bodyBytes.isNotEmpty) {
            await f.parent.create(recursive: true);
            await f.writeAsBytes(res.bodyBytes, flush: false);
            done++;
          } else {
            failed++;
          }
        } catch (_) {
          failed++;
        }
        emit(false);
      }
    }

    await Future.wait(List.generate(
        concurrency.clamp(1, 8), (_) => worker()));
    emit(true);
    return TileProgress(done: done, total: total, failed: failed, finished: true);
  }
}

class _TileJob {
  const _TileJob(this.z, this.x, this.y);
  final int z, x, y;
}

/// Pure mirror of the backend gate kernel
/// (`backend/src/modules/trip_engine/pilot_battery.ts`) so the app can show the
/// driver their own drain number with identical math. Single source of truth is
/// the backend; keep these constants in lockstep (tests pin both sides).
class BatteryDrain {
  static const targetPctPer8h = 20.0; // §1.2 battery budget
  static const gateMaxPctPer8h = 25.0; // Phase 4 gate: >25% ⇒ back to Phase 2
  /// Parity with backend MIN_TRIPS_FOR_VERDICT (trip_engine/pilot_battery.ts):
  /// fewer usable trips ⇒ the server answers INSUFFICIENT_DATA, no verdict.
  static const minTripsForVerdict = 10;

  /// Linear extrapolation of a trip's drain to an 8-hour shift. Negative
  /// deltas (charging during trip) and zero-duration trips return null —
  /// exactly like estimateTripDrain on the server.
  static double? pctPer8h({
    required double startPct,
    required double endPct,
    required Duration duration,
    bool charging = false,
  }) {
    if (charging) return null;
    final minutes = duration.inSeconds / 60.0;
    if (minutes <= 0) return null;
    final delta = startPct - endPct;
    if (delta < 0) return null; // charged mid-trip: not a drain measurement
    final per8h = delta * (480.0 / minutes);
    return per8h > 200 ? null : double.parse(per8h.toStringAsFixed(2));
  }

  /// Verdict strings mirroring judgePilotBattery verdicts (PASS / AT_RISK /
  /// GATE_FAIL / NO_DATA) for median drain across measured trips.
  static String verdictForMedian(double? medianPctPer8h) {
    if (medianPctPer8h == null) return 'NO_DATA';
    if (medianPctPer8h > gateMaxPctPer8h) return 'GATE_FAIL';
    if (medianPctPer8h > targetPctPer8h) return 'AT_RISK';
    return 'PASS';
  }
}
