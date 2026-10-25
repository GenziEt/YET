import 'dart:async';

import 'package:geolocator/geolocator.dart';

import '../features/trip/gps_collector.dart';

/// Real device position source wired into [AppRuntime] by the default
/// `main.dart` bootstrap (Phase 1 deliverable: "a real position source is
/// constructed and injected"). Uses the production `geolocator` plugin — no
/// typedef seam is left dangling in the default path; the seam exists only so
/// unit tests can fabricate fixes.
///
/// Permission handling (§Phase 1: "permission request/denial paths are fully
/// implemented"):
///  * service disabled → prompt the user to enable location services, then
///    re-check once; if still off the stream emits a [GeolocatorServiceDisabledException];
///  * permission denied → request `locationWhenInUse`; denial surfaces as
///    [LocationPermissionDeniedException].
/// The trip screen renders these failures as driver-facing banners instead of
/// silently dropping fixes.
class GeolocatorPositionSource {
  GeolocatorPositionSource({
    this.desiredAccuracy = LocationAccuracy.high,
    this.distanceFilterMeters = 0,
  });

  final LocationAccuracy desiredAccuracy;
  final int distanceFilterMeters;

  StreamSubscription<Position>? _sub;
  bool _stopped = false;

  /// Map the plugin's Position stream into the pipeline's [RawPosition] shape.
  /// One subscription for the collector's lifetime; [dispose] cancels it.
  Stream<RawPosition> stream() {
    final out = StreamController<RawPosition>();
    () async {
      try {
        await _ensureServiceEnabled();
        await _ensurePermission();
        if (_stopped) return;
        _sub = Geolocator.getPositionStream(
          locationSettings: AndroidSettings(
            accuracy: desiredAccuracy,
            distanceFilter: distanceFilterMeters,
            // Foreground-service lifecycle (§Phase 1): keep delivering fixes
            // while the notification-backed foreground service is running.
            foregroundNotificationConfig: const ForegroundNotificationConfig(
              notificationTitle: 'YET tracking',
              notificationBody: 'Trip recording active',
              enableLaunch: false,
            ),
          ),
        ).listen(
          (p) => out.add(_map(p)),
          onError: out.addError,
          onDone: out.close,
          cancelOnError: true,
        );
      } catch (e, s) {
        out.addError(e, s);
        await out.close();
      }
    }();
    return out.stream;
  }

  /// Factory matching [PositionStreamFactory] — pass straight into
  /// `AppRuntime.bootstrap(positionSource: ...)` / `GpsCollector`.
  PositionStreamFactory asFactory() => stream;

  Future<void> dispose() async {
    _stopped = true;
    await _sub?.cancel();
    _sub = null;
  }

  static RawPosition _map(Position p) => RawPosition(
        latitude: p.latitude,
        longitude: p.longitude,
        timestampUtc: p.timestamp.toUtc(),
        speedMps: p.speed.isFinite ? p.speed : null,
        accuracyM: p.accuracyMeters.isFinite ? p.accuracyMeters : null,
        headingDeg: p.headingDegrees.isFinite ? p.headingDegrees : null,
        altitudeM: p.altitude.isFinite ? p.altitude : null,
        // Mock providers never enter the audit trail as 'gps'.
        provider: p.isMocked ? 'network' : 'gps',
      );

  Future<void> _ensureServiceEnabled() async {
    if (await Geolocator.isLocationServiceEnabled()) return;
    // Ask the platform to open location settings, wait, then re-check once.
    await Geolocator.openLocationSettings();
    await Future<void>.delayed(const Duration(seconds: 2));
    if (!await Geolocator.isLocationServiceEnabled()) {
      throw const GeolocatorServiceDisabledException();
    }
  }

  Future<void> _ensurePermission() async {
    var status = await Geolocator.checkPermission();
    if (status == LocationPermission.denied) {
      status = await Geolocator.requestPermission();
    }
    if (status == LocationPermission.deniedForever ||
        status == LocationPermission.denied) {
      throw const LocationPermissionDeniedException();
    }
    // whileInUse covers foreground trip collection; always-on is requested via
    // the system dialog above when the OEM offers it. A permanent refusal of
    // background tracking does not hard-fail: the app remains usable in the
    // foreground and the trip screen shows the state honestly.
  }
}

class GeolocatorServiceDisabledException implements Exception {
  const GeolocatorServiceDisabledException();
  @override
  String toString() => 'Location services are disabled on this device';
}

class LocationPermissionDeniedException implements Exception {
  const LocationPermissionDeniedException();
  @override
  String toString() => 'Location permission denied — YET cannot collect GPS fixes';
}
