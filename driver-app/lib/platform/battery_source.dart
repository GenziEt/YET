import 'package:battery_plus/battery_plus.dart';

import '../features/pilot/pilot_service.dart';

/// Real device battery reader wired into [PilotService] by the default
/// `main.dart` bootstrap (production `battery_plus` plugin). Battery telemetry
/// flows through the same pilot pipeline as location: every trip anchor sample
/// is POSTed to /ingest/diagnostics with this level + charging state.
class BatteryPlusReader {
  BatteryPlusReader({Battery? battery}) : _battery = battery ?? Battery();

  final Battery _battery;

  /// Matches [BatteryReader] — pass straight into `PilotService(batteryReader:)`.
  Future<BatteryReading> read() async {
    final level = await _battery.batteryLevel; // 0..100, -1 if unavailable
    final state = await _battery.batteryState;
    return BatteryReading(
      levelPct: level.clamp(0, 100),
      charging: state == BatteryState.charging ||
          state == BatteryState.full ||
          state == BatteryState.ac_power ||
          state == BatteryState.usb_power,
    );
  }

  BatteryReader asReader() => read;
}
