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
  /// Phase 4 pilot telemetry: battery samples, one-tap assignment check,
  /// offline tile pre-download.
  final PilotService pilot;

  static Future<AppRuntime> bootstrap({
    required TokenStore tokenStore,
    String? dbPathOverride,
    PositionStreamFactory? positionSource,
    DatabaseFactory? dbFactory,
    http.Client? httpClient,
    SensorStreamFactory? sensorSource,
  }) async {
    final path = dbPathOverride ?? await defaultDbPath();
    final db = await (dbFactory ?? databaseFactory).openDatabase(
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
    final sensors = SensorCollector(dao: sensorDao, source: sensorSource);
    final pilot = PilotService(tokenStore: tokenStore, client: httpClient);
    return AppRuntime._(
      dao: dao, sensorDao: sensorDao, worker: worker,
      tokenStore: tokenStore, gps: gps, pilot: pilot,
    )
      .._sensors = sensors;
  }

  SensorCollector? _sensors;

  /// SQLite file lives in app-support storage; PDPP §1.7 keeps it on-device
  /// until the driver's own upload sends it to the Ethiopian gateway.
  static Future<String> defaultDbPath() async {
    final dir = await getApplicationSupportDirectory();
    return '${dir.path}/yet_cache.db';
  }

  /// Trip started on screen: begin GPS duty-cycling + 60 s sync cadence.
  Future<void> startTrip() async {
    worker.startTripCadence();
    unawaited(gps.beginCollection());
  }

  /// Trip ended: stop GPS, flush the tail of the cache, then prune housekeeping.
  Future<void> endTrip() async {
    await gps.endCollection();
    await worker.stopTripCadence();
    await worker.prune();
  }

  /// Connectivity callback (connectivity_plus on device): any usable network
  /// change to Wi-Fi/3G+ schedules an immediate drain (§1.8.1 trigger list).
  void onNetworkAvailable() => worker.onNetworkAvailable();

  void onAppForeground() => worker.onAppForeground();

  int get pendingFixes => worker.pendingCount.value;

  /// Trip toggle from the home screen: GPS duty-cycling + 60 s sync cadence
  /// start together, and both stop together (§1.8.1 trigger list).
  Future<void> onTripToggled({required bool active}) async {
    if (active) {
      await startTrip();
    } else {
      await endTrip();
    }
  }

  @override
  void dispose() {
    worker.pendingCount.removeListener(notifyListeners);
    worker.dispose();
    super.dispose();
  }
}
