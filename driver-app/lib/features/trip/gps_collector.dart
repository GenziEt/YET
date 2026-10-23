import 'dart:async';

import '../../core/cache/fix_dao.dart';
import '../../core/sync/sync_state.dart';

/// One raw position reading, in the shape the platform location plugin
/// (geolocator / flutter_bg_location on device) hands us. Kept as a tiny plain
/// class so unit tests can fabricate fixes without any Flutter runtime.
class RawPosition {
  const RawPosition({
    required this.latitude,
    required this.longitude,
    required this.timestampUtc,
    this.speedMps,
    this.accuracyM,
    this.headingDeg,
    this.altitudeM,
    this.provider = 'gps',
  });

  final double latitude;
  final double longitude;
  final DateTime timestampUtc;
  final double? speedMps;
  final double? accuracyM;
  final double? headingDeg;
  final double? altitudeM;
  final String provider; // 'gps' | 'fused' | 'network' (backend LocationFixSchema)
}

/// Source of positions: injected stream in tests, real background-location
/// stream on device. Typedef keeps [GpsCollector] free of any plugin import.
typedef PositionStreamFactory = Stream<RawPosition> Function();

/// Adaptive GPS sampling policy (§1.3): the interval is chosen from the last
/// known speed. Pure function so Phase 2 sensor gating can reuse and test it.
class AdaptiveInterval {
  /// Highway (>~50 km/h): 30 s. Urban/low-speed: 10 s. Turn or harsh event:
  /// 5 s for [boostWindow] after the event. Stationary confirmation is handled
  /// by the Phase 2 accelerometer gate; Phase 1 still samples at the low-speed
  /// cadence while a trip is active (the truck's motion keeps GPS honest).
  static Duration forSpeedMps(double? speedMps, {required bool boosted}) {
    if (boosted) return const Duration(seconds: 5);
    if (speedMps != null && speedMps >= 14) return const Duration(seconds: 30);
    return const Duration(seconds: 10);
  }

  static const boostWindow = Duration(seconds: 20);
}

/// Duty-cycled GPS collector for Phase 1 (trip-scoped).
///
/// Contract with the cache (§1.8): EVERY fix is written to SQLite the moment it
/// arrives — upload failure is irrelevant here, the writer never discards.
/// The collector owns no network code; syncing is [SyncWorker]'s job.
///
/// Battery discipline (§1.2): the subscription only exists between
/// [beginCollection] and [endCollection]; a failed/restarted stream is retried
/// with the same capped-exponential backoff used by the sync worker.
class GpsCollector {
  GpsCollector({
    required FixDao dao,
    PositionStreamFactory? positionSource,
    bool Function()? boostRequested,
  })  : _dao = dao,
        _positionSource = positionSource,
        _boostRequested = boostRequested ?? (() => false);

  final FixDao _dao;
  final PositionStreamFactory? _positionSource;
  final bool Function() _boostRequested;

  StreamSubscription<RawPosition>? _sub;
  bool _active = false;
  int _collectedThisTrip = 0;
  DateTime? _lastFixAt;
  double? _lastSpeedMps;

  bool get isActive => _active;
  int get collectedThisTrip => _collectedThisTrip;
  DateTime? get lastFixAt => _lastFixAt;

  /// Trip started → subscribe to the position source. Idempotent: calling it
  /// twice (double-tap protection) does not create two subscriptions.
  Future<void> beginCollection() async {
    if (_active) return;
    _active = true;
    _collectedThisTrip = 0;
    await _resubscribe();
  }

  /// Trip ended → stop sensing immediately (battery budget). The tail of the
  /// cache is flushed by SyncWorker.stopTripCadence(), NOT discarded here.
  Future<void> endCollection() async {
    _active = false;
    await _sub?.cancel();
    _sub = null;
  }

  /// Test seam: ingest one position through the exact write path the live
  /// stream uses. Returns the stored row id.
  Future<int> ingest(RawPosition p) async {
    if (!_active) return -1; // stationary/outside-trip: sensor-gated off
    // Sanity gate: reject absurd fixes rather than poison the polyline.
    if (p.latitude.abs() > 90 || p.longitude.abs() > 180) return -1;
    _lastSpeedMps = p.speedMps;
    _lastFixAt = p.timestampUtc;
    _collectedThisTrip++;
    final id = await _dao.insertFix(StoredFix(
      id: 0, // auto-increment assigned by SQLite
      lat: p.latitude,
      lng: p.longitude,
      fixTimestamp: p.timestampUtc,
      speedMps: p.speedMps,
      accuracyM: p.accuracyM,
      headingDeg: p.headingDeg,
      altitudeM: p.altitudeM,
      provider: p.provider,
      syncState: SyncState.pending,
    ));
    return id;
  }

  Duration get currentInterval =>
      AdaptiveInterval.forSpeedMps(_lastSpeedMps, boosted: _boostRequested());

  Future<void> _resubscribe() async {
    final src = _positionSource;
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
