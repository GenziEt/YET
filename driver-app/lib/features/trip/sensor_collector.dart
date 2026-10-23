import 'dart:async';

import '../../core/cache/sensor_dao.dart';
import '../../core/sync/sync_state.dart';

/// One raw motion-sensor reading, in the shape the platform sensor plugin
/// (sensors_plus on device) hands us. Tiny plain class so unit tests fabricate
/// samples without a Flutter runtime — same pattern as RawPosition.
class RawSensorSample {
  const RawSensorSample({
    required this.kind,
    required this.timestampUtc,
    required this.values,
  });

  final String kind; // must be in StoredSensorEvent.allowedKinds
  final DateTime timestampUtc;
  /// accelerometer: [x,y,z] m/s² · gyroscope: [x,y,z] rad/s ·
  /// vibration_gate: [state 0|1] · harsh/turn events: [severity].
  final List<double> values;

  Map<String, Object?> toPayload() => {'values': values};
}

/// Source of sensor samples: injected stream in tests, real sensors_plus event
/// streams mapped into [RawSensorSample] on device. Typedef keeps
/// [SensorCollector] free of any plugin import (mirrors PositionStreamFactory).
typedef SensorStreamFactory = Stream<RawSensorSample> Function();

/// Motion-sensor duty-cycling for Phase 4 (§1.8.5).
///
/// Contract with the cache: identical to GpsCollector — every accepted sample
/// goes to SQLite immediately via [SensorDao]; the collector owns no network
/// code. Sampling is trip-scoped and THROTTLED for battery (§1.2): raw
/// accelerometer streams arrive at 50–100 Hz; we persist at most one sample
/// per [sampleInterval] per kind (downsampling happens BEFORE the cache, so
/// storage never balloons), while discrete events (harsh_brake, turn,
/// vibration_gate transitions) are always kept.
class SensorCollector {
  SensorCollector({
    required SensorDao dao,
    SensorStreamFactory? source,
    Duration sampleInterval = const Duration(seconds: 2),
  })  : _dao = dao,
        _source = source,
        _sampleInterval = sampleInterval;

  static const continuousKinds = {'accelerometer', 'gyroscope'};

  final SensorDao _dao;
  final SensorStreamFactory? _source;
  final Duration _sampleInterval;

  StreamSubscription<RawSensorSample>? _sub;
  bool _active = false;
  int _storedThisTrip = 0;
  int _droppedByThrottle = 0;
  final Map<String, DateTime> _lastStoredAt = {};

  bool get isActive => _active;
  int get storedThisTrip => _storedThisTrip;
  int get droppedByThrottle => _droppedByThrottle;

  /// Trip started → subscribe. Idempotent (double-tap protection).
  Future<void> beginCollection() async {
    if (_active) return;
    _active = true;
    _storedThisTrip = 0;
    _droppedByThrottle = 0;
    _lastStoredAt.clear();
    await _resubscribe();
  }

  /// Trip ended → stop sensing immediately (battery budget); cached rows flush
  /// through SyncWorker like everything else — never discarded here.
  Future<void> endCollection() async {
    _active = false;
    await _sub?.cancel();
    _sub = null;
  }

  /// Test seam + live stream sink: push one sample through the exact write path.
  /// Returns the stored row id, or -1 when gated off (inactive / throttled /
  /// unknown kind).
  Future<int> ingest(RawSensorSample s) async {
    if (!_active) return -1;
    if (!StoredSensorEvent.allowedKinds.contains(s.kind)) return -1;
    if (continuousKinds.contains(s.kind)) {
      final last = _lastStoredAt[s.kind];
      if (last != null && s.timestampUtc.difference(last) < _sampleInterval) {
        _droppedByThrottle++;
        return -1;
      }
      _lastStoredAt[s.kind] = s.timestampUtc;
    }
    _storedThisTrip++;
    return _dao.insertEvent(StoredSensorEvent(
      id: 0, // auto-increment assigned by SQLite
      kind: s.kind,
      eventTimestamp: s.timestampUtc,
      payload: s.toPayload(),
      syncState: SyncState.pending,
    ));
  }

  Future<void> _resubscribe() async {
    final src = _source;
    if (src == null) return; // no source wired yet (pre-permission state)
    try {
      _sub = src().listen(
        ingest,
        onError: (_) => _retryLater(),
        onDone: _retryLater,
        cancelOnError: true,
      );
    } catch (_) {
      _retryLater();
    }
  }

  void _retryLater() {
    if (!_active) return;
    unawaited(Future<void>.delayed(const Duration(seconds: 30), () async {
      if (!_active) return;
      await _sub?.cancel();
      _sub = null;
      await _resubscribe();
    }));
  }
}
