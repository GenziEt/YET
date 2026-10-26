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
    required this.configCache,
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
  /// Last-fetched calibration persisted in the local SQLite cache so offline
  /// trips reuse the most recent thresholds (§1.8 offline-first fallback).
  final CachedConfigStore configCache;
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
      // v2: adds the Phase 2 classification_config_cache side table
      // (CachedConfigStore.onCreate is idempotent — CREATE IF NOT EXISTS —
      // so it also covers installs that created the file at v1).
      version: 2,
      onCreate: (db, v) async {
        // One DB file holds BOTH caches (§1.8.5 "same SQLite cache").
        await FixDao.onCreate(db, v);
        await SensorDao.onCreate(db, v);
        await CachedConfigStore.onCreate(db, v);
      },
      onUpgrade: (db, oldV, newV) async {
        if (oldV < 2) await CachedConfigStore.onCreate(db, newV);
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
    final configCache = CachedConfigStore(db);
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
      configCache: configCache,
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
  /// The Phase 4 feedback retry queue rides the same trigger: a report the
  /// driver tapped while off-grid is delivered as soon as signal returns
  /// ("will retry when you have signal" — backed by PilotService.flushFeedbackQueue).
  void onNetworkAvailable() {
    worker.onNetworkAvailable();
    unawaited(pilot.flushFeedbackQueue());
  }

  void onAppForeground() {
    worker.onAppForeground();
    unawaited(pilot.flushFeedbackQueue());
  }

  int get pendingFixes => worker.pendingCount.value;

  /// One-tap trip toggle from the home screen (§1.2 max-3-taps budget).
  ///
  /// START: confirm vehicle assignment via GET /me first, then apply the
  /// §Phase 4 hard gate — collection starts ONLY when a valid assignment
  /// exists ([allowsTripStart]: server-confirmed or offline-cached). A driver
  /// with no assigned vehicle gets `noVehicle` back and NOTHING is collected
  /// (the backend would reject the ingest anyway with 409 no_vehicle_assignment;
  /// gating client-side keeps the cache honest and tells the driver at tap
  /// time). Offline-with-no-cache is likewise blocked for a fresh start —
  /// returning `offlineUnknown` lets the UI explain "call your fleet manager"
  /// once signal returns. When allowed: stamp the battery-sample trip anchor,
  /// fire-and-forget the trip-start battery sample, and begin GPS + motion
  /// sensor collection together with the 60 s sync cadence (§1.8.1 trigger list).
  /// Phase 2 fusion: before sensors start, refresh calibrated thresholds from
  /// GET /trips/classification-config (offline → last-cached → defaults),
  /// reset classifier run state, and bind the sensor stream THROUGH the
  /// classifier so every raw sample feeds harsh/turn/vibration-gate detection
  /// on its way to the throttled cache. END: flush any open classification run
  /// BEFORE unsubscribing so the final event of the trip is not lost.
  Future<AssignmentCheck> onTripToggled({required bool active}) async {
    if (active) {
      final check = await pilot.confirmVehicleAssignment();
      if (!allowsTripStart(check)) return check; // HARD GATE: no collection
      pilot.markTripStartAnchor(DateTime.now().toUtc());
      unawaited(pilot.sampleTripStart());
      worker.startTripCadence();
      // Threshold refresh must never delay or block tracking start; the
      // resolve chain already swallows fetch failures (cache → defaults).
      try {
        classifier.th = await resolveThresholds(
          source: configSource,
          cache: configCache,
        );
      } catch (_) {
        // Defensive: keep whatever calibration is currently loaded.
      }
      classifier.reset();
      final raw = _sensorSource;
      // classifier.onSample is a Future<void> consumer — run it per sample
      // while passing the sample through unchanged (asyncMap needs the
      // element type preserved).
      await sensors.setSource(raw == null
          ? null
          : () => raw().asyncMap((s) async {
                await classifier.onSample(s);
                return s;
              }));
      unawaited(gps.beginCollection());
      unawaited(sensors.beginCollection());
      return check;
    }
    await gps.endCollection();
    await classifier.flush();
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
