import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:path_provider/path_provider.dart';
import 'package:sqflite/sqflite.dart';

import 'cache/fix_dao.dart';
import 'cache/sensor_dao.dart';
import 'sync/sync_worker.dart';
import '../features/auth/token_store.dart';
import '../features/pilot/pilot_service.dart';
import '../features/trip/event_classifier.dart';
import '../features/trip/gps_collector.dart';
import '../features/trip/sensor_collector.dart';

/// Composition root for the Phase 1 offline pipeline.
///
/// Wiring order matters for the cold-start budget (§1.9.1): main() shows the
/// first frame with a null runtime, then [AppRuntime.bootstrap] opens SQLite
/// off the critical path and swaps itself in via this listenable.
class AppRuntime extends ChangeNotifier {
  AppRuntime._({
    required this.dao,
    required this.sensorDao,
    required this.worker,
    required this.tokenStore,
    required this.gps,
    required this.sensors,
    required this.classifier,
    required this.configSource,
    required this.pilot,
  }) {
    worker.pendingCount.addListener(notifyListeners);
  }

  final FixDao dao;
  /// §1.8.5 sensor cache — same SQLite file, same sync state machine.
  final SensorDao sensorDao;
  final SyncWorker worker;
  final TokenStore tokenStore;
  final GpsCollector gps;
  /// Phase 4 motion-sensor duty-cycling (§1.8.5): writes through [sensorDao].
  final SensorCollector sensors;
  /// Phase 2 on-device sensor fusion (§1.3): harsh brake/accel, turn and
  /// vibration-gate classification with server-calibrated thresholds. Lives
  /// BETWEEN the raw sensor source and [sensors] (see [onTripToggled]).
  final EventClassifier classifier;
  /// Config fetcher for trip-start threshold refresh (test-seamable).
  final ClassificationConfigSource configSource;
  /// Phase 4 pilot telemetry: battery samples, one-tap assignment check,
  /// offline tile pre-download.
  final PilotService pilot;

  static Future<AppRuntime> bootstrap({
    required TokenStore tokenStore,
    String? dbPathOverride,
    PositionStreamFactory? positionSource,
    http.Client? httpClient,
    SensorStreamFactory? sensorSource,
    BatteryReader? batteryReader,
    String Function()? networkTypeProvider,
    ClassificationConfigSource? configSource,
  }) async {
    final path = dbPathOverride ?? await defaultDbPath();
    final db = await openDatabase(
      path,
      version: FixDao.dbVersion,
      onCreate: (db, v) async {
        // One DB file holds BOTH caches (§1.8.5 "same SQLite cache").
        await FixDao.onCreate(db, v);
        await SensorDao.onCreate(db, v);
      },
    );
    final dao = FixDao(db);
    final sensorDao = SensorDao(db);
    // §1.8.1 crash recovery BEFORE anything reads the cache — both streams.
    await dao.recoverUnackedUploads();
    await sensorDao.recoverUnackedUploads();

    final worker = SyncWorker(
      dao: dao,
      uploader: SyncWorker.httpUploader(
        accessToken: () => tokenStore.accessToken ?? '',
        client: httpClient,
      ),
      sensorDao: sensorDao,
      sensorUploader: SyncWorker.httpSensorUploader(
        accessToken: () => tokenStore.accessToken ?? '',
        client: httpClient,
      ),
    );
    await worker.refreshPendingCount();

    final gps = GpsCollector(dao: dao, positionSource: positionSource);
    final sensors = SensorCollector(dao: sensorDao, source: null);
    // Phase 2 fusion: the classifier sits BETWEEN the raw sensor stream and
    // the collector — it consumes every raw sample, emits discrete harsh/turn/
    // gate events, and forwards everything (raw + discrete) to the throttled
    // cache path. Thresholds refresh at trip start (see onTripToggled).
    final classifier = EventClassifier(
      thresholds: ClassificationThresholds.defaults,
      sink: sensors.ingest,
    );
    final cfgSource = configSource ??
        HttpClassificationConfigSource(
          client: httpClient,
          accessToken: () => tokenStore.accessToken,
        );
    final pilot = PilotService(
      tokenStore: tokenStore,
      client: httpClient,
      batteryReader: batteryReader ?? UnavailableBatteryReader.read,
      networkTypeProvider: networkTypeProvider,
    );
    final runtime = AppRuntime._(
      dao: dao,
      sensorDao: sensorDao,
      worker: worker,
      tokenStore: tokenStore,
      gps: gps,
      sensors: sensors,
      classifier: classifier,
      configSource: cfgSource,
      pilot: pilot,
    );
    // Late-bind the source so the collector subscribes THROUGH the classifier
    // (single fan-in point; keeps SensorCollector plugin-free).
    runtime._sensorSource = sensorSource;
    return runtime;
  }

  /// Raw-sample producer, late-bound after construction (see bootstrap).
  SensorStreamFactory? _sensorSource;

  /// SQLite file lives in app-support storage; PDPP §1.7 keeps it on-device
  /// until the driver's own upload sends it to the Ethiopian gateway.
  static Future<String> defaultDbPath() async {
    final dir = await getApplicationSupportDirectory();
    return '${dir.path}/yet_cache.db';
  }

  // Phase 4 note: the old bare startTrip()/endTrip() helpers are folded into
  // [onTripToggled] — a trip toggle must ALWAYS run the pilot hooks (vehicle
  // confirm + battery samples) and sensor collection, never just GPS+cadence.

  /// Connectivity callback (connectivity_plus on device): any usable network
  /// change to Wi-Fi/3G+ schedules an immediate drain (§1.8.1 trigger list).
  void onNetworkAvailable() => worker.onNetworkAvailable();

  void onAppForeground() => worker.onAppForeground();

  int get pendingFixes => worker.pendingCount.value;

  /// One-tap trip toggle from the home screen (§1.2 max-3-taps budget).
  ///
  /// START: confirm vehicle assignment via GET /me first — but NEVER block the
  /// driver: offline/no-vehicle results are returned to the UI as a banner
  /// while tracking begins anyway (a phone with no signal still caches fixes
  /// per §1.8). Then stamp the battery-sample trip anchor, fire-and-forget the
  /// trip-start battery sample, and begin GPS + motion-sensor collection
  /// together with the 60 s sync cadence (§1.8.1 trigger list).
  /// END: stop sensing immediately (battery budget), post the trip-end battery
  /// sample, flush the tail of the cache, then prune housekeeping.
  Future<AssignmentCheck> onTripToggled({required bool active}) async {
    if (active) {
      final check = await pilot.confirmVehicleAssignment();
      pilot.markTripStartAnchor(DateTime.now().toUtc());
      unawaited(pilot.sampleTripStart());
      worker.startTripCadence();
      unawaited(gps.beginCollection());
      unawaited(sensors.beginCollection());
      return check;
    }
    await gps.endCollection();
    await sensors.endCollection();
    unawaited(pilot.sampleTripEnd());
    await worker.stopTripCadence();
    await worker.prune();
    return AssignmentCheck.offlineUnknown;
  }

  @override
  void dispose() {
    worker.pendingCount.removeListener(notifyListeners);
    worker.dispose();
    super.dispose();
  }
}
