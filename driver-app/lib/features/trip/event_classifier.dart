import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';

import '../../core/cache/sensor_dao.dart';
import '../../core/config/app_config.dart';
import '../../core/sync/sync_state.dart';
import 'sensor_collector.dart';

/// Phase 2 on-device sensor fusion (§1.3): harsh braking / harsh acceleration /
/// turn detection and the engine-vibration gate, classified IN THE APP from the
/// raw accelerometer/gyroscope stream with CALIBRATED THRESHOLDS fetched from
/// the backend (`GET /trips/classification-config`) — never magic numbers
/// scattered in code. The same thresholds parameterize the server-side fallback
/// kernel (`backend/src/modules/trip_engine/state_machine.ts`), so device and
/// server agree by construction.
///
/// Offline behavior (Offline Contract §1.8): if the config fetch fails at trip
/// start we fall back to the LAST-CACHED payload (persisted in the SQLite cache
/// under kind `classification_config`, a local-only row that is never uploaded
/// because only [EventClassifier] writes it and no batch claim reads it); on a
/// virgin install with no cache and no network we use the documented defaults
/// below, which mirror the server's DEFAULT_CLASSIFICATION_THRESHOLDS exactly.

/// One immutable threshold set — mirrors the classificationConfigPayload()
/// wire shape published by GET /trips/classification-config.
class ClassificationThresholds {
  const ClassificationThresholds({
    required this.harshBrakeMps2,
    required this.harshAccelMps2,
    required this.turnRateDps,
    required this.turnMinDurationMs,
    required this.maxSampleGapMs,
    required this.cooldownMs,
    required this.vibrationGateVariance,
  });

  final double harshBrakeMps2;
  final double harshAccelMps2;
  final double turnRateDps;
  final int turnMinDurationMs;
  final int maxSampleGapMs;
  final int cooldownMs;
  final double vibrationGateVariance;

  /// Server defaults (state_machine.ts DEFAULT_CLASSIFICATION_THRESHOLDS +
  /// env MOTION_VARIANCE_THRESHOLD). Used ONLY when neither the network nor a
  /// cached config is available; they are configuration-identical to the server.
  static const defaults = ClassificationThresholds(
    harshBrakeMps2: 3.5,
    harshAccelMps2: 2.5,
    turnRateDps: 35,
    turnMinDurationMs: 1000,
    maxSampleGapMs: 2000,
    cooldownMs: 5000,
    vibrationGateVariance: 0.05,
  );

  factory ClassificationThresholds.fromJson(Map<String, Object?> json) {
    final th = json['thresholds'];
    if (th is! Map<String, Object?>) return defaults;
    double d(String key, double fallback) =>
        (th[key] as num?)?.toDouble() ?? fallback;
    int i(String key, int fallback) => (th[key] as num?)?.toInt() ?? fallback;
    return ClassificationThresholds(
      harshBrakeMps2: d('harsh_brake_mps2', defaults.harshBrakeMps2),
      harshAccelMps2: d('harsh_accel_mps2', defaults.harshAccelMps2),
      turnRateDps: d('turn_rate_dps', defaults.turnRateDps),
      turnMinDurationMs: i('turn_min_duration_ms', defaults.turnMinDurationMs),
      maxSampleGapMs: i('max_sample_gap_ms', defaults.maxSampleGapMs),
      cooldownMs: i('cooldown_ms', defaults.cooldownMs),
      vibrationGateVariance:
          d('vibration_gate_variance', defaults.vibrationGateVariance),
    );
  }

  Map<String, Object?> toJson() => {
        'thresholds': {
          'harsh_brake_mps2': harshBrakeMps2,
          'harsh_accel_mps2': harshAccelMps2,
          'turn_rate_dps': turnRateDps,
          'turn_min_duration_ms': turnMinDurationMs,
          'max_sample_gap_ms': maxSampleGapMs,
          'cooldown_ms': cooldownMs,
          'vibration_gate_variance': vibrationGateVariance,
        },
      };
}

/// Sink for classified events. Production wires [SensorCollector.ingest]; tests
/// capture the emitted samples. Discrete kinds (harsh_*, turn, vibration_gate)
/// bypass the collector's throttle by contract (see SensorCollector.ingest).
typedef ClassifiedEventSink = Future<void> Function(RawSensorSample e);

/// Fetches the calibrated config. Injectable for tests; production uses
/// [HttpClassificationConfigSource].
abstract class ClassificationConfigSource {
  Future<Map<String, Object?>?> fetch();
}

class HttpClassificationConfigSource implements ClassificationConfigSource {
  HttpClassificationConfigSource(
      {http.Client? client, String? Function()? accessToken})
      : _client = client,
        _accessToken = accessToken;

  final http.Client? _client;
  final String? Function()? _accessToken;

  @override
  Future<Map<String, Object?>?> fetch() async {
    try {
      final token = _accessToken?.call();
      final res = await (_client ?? http.Client())
          .get(Uri.parse('${AppConfig.apiBaseUrl}/trips/classification-config'),
              headers: {
                if (token != null && token.isNotEmpty)
                  'authorization': 'Bearer $token',
              })
          .timeout(const Duration(seconds: 10));
      if (res.statusCode != 200) return null;
      final body = jsonDecode(res.body);
      return body is Map<String, Object?> ? body : null;
    } catch (_) {
      // Offline / gateway hiccup: caller falls back to last-cached values.
      return null;
    }
  }
}

/// Streaming on-device classifier. Feed every raw sample through [onSample]
/// (wired between the sensor source and SensorCollector in AppRuntime); it
/// emits discrete event rows via the injected sink using the SAME run/cooldown
/// semantics as the pure TS kernel (classifyHarshEvents / classifyTurnEvents /
/// classifyVibrationGateEvents in state_machine.ts).
///
/// Determinism note: like the server kernel, output depends only on the
/// time-SORTED sample sequence; live samples arrive in order, and any late
/// arrival outside the active run window simply starts a new run — matching
/// how rebuildTrip re-sorts before classifying.
class EventClassifier {
  EventClassifier({
    required ClassificationThresholds thresholds,
    required ClassifiedEventSink sink,
  })  : th = thresholds,
        _sink = sink;

  /// Active threshold set. Mutable so AppRuntime can apply freshly fetched /
  /// restored calibration at trip start without rebuilding the pipeline
  /// (threshold changes take effect from the NEXT sample onward; call
  /// [reset] alongside to clear any run state measured under old limits).
  ClassificationThresholds th;

  final ClassifiedEventSink _sink;

  static const _gravity = 9.81;
  static const _window = 3; // variance window, identical to server kernel

  // ---- harsh brake / accel (peak detection with per-kind cooldown) ----
  final List<_TimedSample> _accelBuf = [];
  _HarshRun? _harshRun;
  DateTime? _lastHarshEmittedAt;

  // ---- turns (sustained-gyro runs) ----
  _TurnRun? _turnRun;

  // ---- vibration gate (variance transitions) ----
  final List<double> _zBuf = [];
  bool? _gateMoving;

  bool get gateOpen => _gateMoving ?? false;

  void reset() {
    _accelBuf.clear();
    _harshRun = null;
    _lastHarshEmittedAt = null;
    _turnRun = null;
    _zBuf.clear();
    _gateMoving = null;
  }

  /// Main entry: consume one raw sample. Accelerometer samples drive harsh
  /// peak detection + the vibration gate; gyroscope samples drive turns.
  Future<void> onSample(RawSensorSample s) async {
    switch (s.kind) {
      case 'accelerometer':
        await _onAccelerometer(s);
        break;
      case 'gyroscope':
        await _onGyroscope(s);
        break;
      default:
        // Discrete events flow straight through untouched (pass-through mode
        // when this classifier sits downstream of another producer).
        await _sink(s);
    }
  }

  // -------------------------------------------------------------------------
  // Harsh braking / acceleration — longitudinal axis pick + excursion grouping
  // -------------------------------------------------------------------------

  Future<void> _onAccelerometer(RawSensorSample s) async {
    final v = s.values;
    if (v.length == 3 && v.every((n) => n.isFinite)) {
      _accelBuf.add(_TimedSample(s.timestampUtc, v));
      if (_accelBuf.length > 64) _accelBuf.removeAt(0);
      await _stepHarsh(s.timestampUtc, v);
      await _stepVibrationGate(v, s.timestampUtc);
    }
    // Raw samples also pass through to the cache (collector throttles them).
    await _sink(s);
  }

  /// Axis pick over the buffer: whichever of x/z carries dominant non-gravity
  /// variance is longitudinal (phone flat ⇒ x; phone sideways ⇒ z). Same rule
  /// as classifyHarshEvents on the server.
  int _longitudinalIndex() {
    if (_accelBuf.length < 3) return 0;
    final vx = _varianceOf(0);
    final vz = _varianceOf(2);
    return vx >= vz ? 0 : 2;
  }

  double _varianceOf(int idx) {
    final xs = _accelBuf.map((a) => a.v[idx]).toList();
    final mean = xs.reduce((p, c) => p + c) / xs.length;
    return xs.map((c) => (c - mean) * (c - mean)).reduce((p, c) => p + c) /
        xs.length;
  }

  Future<void> _stepHarsh(DateTime t, List<double> v) async {
    final li = _longitudinalIndex();
    final a = v[li];
    final overLimit = a <= -th.harshBrakeMps2 || a >= th.harshAccelMps2;
    final sign = a < 0 ? -1 : 1;
    final gapMs = _harshRun == null
        ? 0
        : t.difference(_harshRun!.endT).inMilliseconds;

    if (overLimit) {
      final run = _harshRun;
      if (run != null && run.sign == sign && gapMs <= th.maxSampleGapMs) {
        run.endT = t;
        if (a.abs() > run.extreme.abs()) {
          run.extreme = a;
          run.extremeT = t;
        }
      } else {
        await _closeHarshRun();
        _harshRun = _HarshRun(
            sign: sign,
            extreme: a,
            extremeT: t,
            startT: t,
            endT: t);
      }
    } else if (_harshRun != null && gapMs > th.maxSampleGapMs) {
      await _closeHarshRun();
    }
  }

  Future<void> _closeHarshRun() async {
    final run = _harshRun;
    _harshRun = null;
    if (run == null) return;
    final magnitude = run.extreme.abs();
    final limit =
        run.sign < 0 ? th.harshBrakeMps2 : th.harshAccelMps2;
    if (magnitude < limit) return;
    final sinceLast = _lastHarshEmittedAt == null
        ? const Duration(days: 365)
        : run.extremeT.difference(_lastHarshEmittedAt!);
    if (sinceLast.inMilliseconds <= th.cooldownMs) return;
    _lastHarshEmittedAt = run.extremeT;
    await _emitDiscrete(
      kind: run.sign < 0 ? 'harsh_brake' : 'harsh_accel',
      timestamp: run.extremeT,
      severity: magnitude,
      extra: {
        'magnitude_mps2': double.parse(magnitude.toStringAsFixed(2)),
        'threshold_mps2': limit,
        'source': 'device',
      },
    );
  }

  // -------------------------------------------------------------------------
  // Turns — sustained gyro |z| runs above rate threshold
  // -------------------------------------------------------------------------

  Future<void> _onGyroscope(RawSensorSample s) async {
    final v = s.values;
    if (v.length == 3 && v.every((n) => n.isFinite)) {
      final zDeg = v[2] * 180 / math.pi; // rad/s → deg/s (§1.3 convention)
      final run = _turnRun;
      final gapMs = run == null
          ? 0
          : s.timestampUtc.difference(run.lastT).inMilliseconds;
      if (zDeg.abs() >= th.turnRateDps) {
        final sign = zDeg > 0 ? 1 : -1;
        if (run != null && run.sign == sign && gapMs <= th.maxSampleGapMs) {
          run.lastT = s.timestampUtc;
          if (zDeg.abs() > run.peakDps.abs()) {
            run.peakDps = zDeg;
            run.peakT = s.timestampUtc;
          }
        } else {
          await _closeTurnRun();
          _turnRun = _TurnRun(
              sign: sign,
              startT: s.timestampUtc,
              lastT: s.timestampUtc,
              peakDps: zDeg,
              peakT: s.timestampUtc);
        }
      } else if (run != null && gapMs > th.maxSampleGapMs) {
        await _closeTurnRun();
      }
    }
    await _sink(s);
  }

  Future<void> _closeTurnRun() async {
    final run = _turnRun;
    _turnRun = null;
    if (run == null) return;
    final durationMs = run.lastT.difference(run.startT).inMilliseconds;
    if (durationMs < th.turnMinDurationMs) return;
    await _emitDiscrete(
      kind: 'turn',
      timestamp: run.peakT,
      severity: run.peakDps.abs(),
      extra: {
        'direction': run.sign > 0 ? 'right' : 'left',
        'peak_rate_dps': double.parse(run.peakDps.abs().toStringAsFixed(1)),
        'threshold_dps': th.turnRateDps,
        'duration_ms': durationMs,
        'source': 'device',
      },
    );
  }

  /// Flush any open run at trip end so the last event is not lost.
  Future<void> flush() async {
    await _closeHarshRun();
    await _closeTurnRun();
  }

  // -------------------------------------------------------------------------
  // Vibration gate — rolling variance of z beyond gravity (§1.3 engine gate)
  // -------------------------------------------------------------------------

  Future<void> _stepVibrationGate(List<double> v, DateTime t) async {
    // Detrend near-gravity so idling rumble vs parked stillness separate.
    _zBuf.add(v[2] - _gravity);
    if (_zBuf.length > _window) _zBuf.removeAt(0);
    if (_zBuf.length < _window) return;
    final mean = _zBuf.reduce((p, c) => p + c) / _zBuf.length;
    final variance =
        _zBuf.map((c) => (c - mean) * (c - mean)).reduce((p, c) => p + c) /
            _zBuf.length;
    final nowMoving = variance >= th.vibrationGateVariance;
    final prev = _gateMoving;
    _gateMoving = nowMoving;
    if (prev != null && nowMoving != prev) {
      await _emitDiscrete(
        kind: 'vibration_gate',
        timestamp: t,
        severity: nowMoving ? 1 : 0,
        extra: {
          'state': nowMoving ? 1 : 0,
          'reason': nowMoving ? 'vibration_gate_open' : 'vibration_gate_close',
          'variance': double.parse(variance.toStringAsFixed(4)),
          'threshold': th.vibrationGateVariance,
          'source': 'device',
        },
      );
    }
  }

  Future<void> _emitDiscrete({
    required String kind,
    required DateTime timestamp,
    required double severity,
    required Map<String, Object?> extra,
  }) async {
    await _sink(RawSensorSample(
      kind: kind,
      timestampUtc: timestamp,
      values: [severity],
      extra: extra,
    ));
  }
}

class _TimedSample {
  const _TimedSample(this.t, this.v);
  final DateTime t;
  final List<double> v;
}

class _HarshRun {
  _HarshRun({
    required this.sign,
    required this.extreme,
    required this.extremeT,
    required this.startT,
    required this.endT,
  });
  final int sign;
  double extreme;
  DateTime extremeT;
  final DateTime startT;
  DateTime endT;
}

class _TurnRun {
  _TurnRun({
    required this.sign,
    required this.startT,
    required this.lastT,
    required this.peakDps,
    required this.peakT,
  });
  final int sign;
  final DateTime startT;
  DateTime lastT;
  double peakDps;
  DateTime peakT;
}

/// Local-only persistence of the last-fetched config so offline trips reuse the
/// most recent calibrated thresholds (§1.8 offline-first). Stored in its own
/// side table — NOT the sensor cache — so it can never inflate the driver-
/// visible "records pending sync" backlog (SensorDao.pendingCount), leak into
/// an upload batch (claimBatch), or be pruned by acked-retention housekeeping.
class CachedConfigStore {
  CachedConfigStore(this._db);
  final Database _db;

  static const tableConfig = 'classification_config_cache';

  /// Schema for the side table; called from AppRuntime's onCreate/onUpgrade.
  static Future<void> onCreate(Database db, int version) async {
    await db.execute('''
      CREATE TABLE IF NOT EXISTS $tableConfig (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    ''');
  }

  Future<void> save(ClassificationThresholds th) async {
    final now = DateTime.now().toUtc().toIso8601String();
    await _db.transaction((txn) async {
      final written = await txn.update(tableConfig,
          {'updated_at': now, 'payload_json': jsonEncode(th.toJson())},
          where: 'id = 1');
      if (written == 0) {
        await txn.insert(tableConfig, {
          'id': 1,
          'updated_at': now,
          'payload_json': jsonEncode(th.toJson()),
        });
      }
    });
  }

  Future<ClassificationThresholds?> load() async {
    final rows = await _db
        .query(tableConfig, where: 'id = 1', limit: 1);
    if (rows.isEmpty) return null;
    try {
      final raw = jsonDecode(rows.first['payload_json'] as String);
      if (raw is Map<String, Object?>) {
        return ClassificationThresholds.fromJson(raw);
      }
    } catch (_) {/* corrupt row → treat as absent */}
    return null;
  }
}

/// Trip-start orchestrator used by AppRuntime: fetch fresh config (cache it on
/// success), otherwise restore last-cached, otherwise documented defaults.
Future<ClassificationThresholds> resolveThresholds({
  required ClassificationConfigSource source,
  required CachedConfigStore cache,
}) async {
  final fresh = await source.fetch();
  if (fresh != null) {
    final th = ClassificationThresholds.fromJson(fresh);
    await cache.save(th);
    return th;
  }
  final cached = await cache.load();
  return cached ?? ClassificationThresholds.defaults;
}

/// Convenience: build a [StoredSensorEvent]-compatible sync-state helper kept
/// here so tests can fabricate rows without importing sync internals twice.
StoredSensorEvent pendingSensorRow({
  required String kind,
  required DateTime ts,
  required Map<String, Object?> payload,
}) =>
    StoredSensorEvent(
      id: 0,
      kind: kind,
      eventTimestamp: ts,
      payload: payload,
      syncState: SyncState.pending,
    );
