import 'dart:async';

import 'package:sensors_plus/sensors_plus.dart';

import '../features/trip/sensor_collector.dart';

/// Real device motion-sensor source wired into [AppRuntime] by the default
/// `main.dart` bootstrap (production `sensors_plus` plugin). Emits
/// accelerometer and gyroscope samples in the pipeline's [RawSensorSample]
/// shape; [SensorCollector] applies the battery-throttle downsampling before
/// anything reaches SQLite, so raw 50–100 Hz streams never balloon the cache.
class SensorsPlusSource {
  SensorsPlusSource({
    this.accelerometerPeriod = const Duration(milliseconds: 200),
    this.gyroscopePeriod = const Duration(milliseconds: 200),
  });

  /// ~5 Hz device-side sampling: raw 50-100 Hz streams would defeat the
  /// battery budget (§1.8.5); SensorCollector downsamples further while idle.
  final Duration accelerometerPeriod;
  final Duration gyroscopePeriod;

  final List<StreamSubscription<dynamic>> _subs = [];
  bool _stopped = false;

  Stream<RawSensorSample> stream() {
    final out = StreamController<RawSensorSample>();
    void addAcc(AccelerometerEvent e) {
      if (_stopped) return;
      out.add(RawSensorSample(
        kind: 'accelerometer',
        timestampUtc: DateTime.now().toUtc(),
        values: [e.x, e.y, e.z],
      ));
    }

    void addGyro(GyroscopeEvent e) {
      if (_stopped) return;
      out.add(RawSensorSample(
        kind: 'gyroscope',
        timestampUtc: DateTime.now().toUtc(),
        values: [e.x, e.y, e.z],
      ));
    }

    void fail(Object e, StackTrace s) {
      out.addError(e, s);
      out.close();
    }

    try {
      _subs.add(accelerometerEventStream(samplingPeriod: accelerometerPeriod)
          .listen(addAcc, onError: fail));
      _subs.add(gyroscopeEventStream(samplingPeriod: gyroscopePeriod)
          .listen(addGyro, onError: fail));
    } catch (e, s) {
      fail(e, s);
    }
    return out.stream;
  }

  /// Factory matching [SensorStreamFactory] — pass straight into
  /// `AppRuntime.bootstrap(sensorSource: ...)` / `SensorCollector`.
  SensorStreamFactory asFactory() => stream;

  Future<void> dispose() async {
    _stopped = true;
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
  }
}
