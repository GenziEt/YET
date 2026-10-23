import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;
import 'package:sqflite/sqflite.dart';

import 'core/cache/fix_dao.dart';
import 'core/config/app_config.dart';
import 'core/sync/sync_state.dart';
import 'core/sync/sync_worker.dart';
import 'features/auth/token_store.dart';
import 'features/trip/gps_collector.dart';

/// Composition root for the Phase 1 offline pipeline.
///
/// Wiring order matters for the cold-start budget (§1.9.1): main() shows the
/// first frame with a null runtime, then [AppRuntime.bootstrap] opens SQLite
/// off the critical path and swaps itself in via this listenable.
class AppRuntime extends ChangeNotifier {
  AppRuntime._({
    required this.dao,
    required this.worker,
    required this.tokenStore,
    required this.gps,
  }) {
    worker.pendingCount.addListener(notifyListeners);
  }

  final FixDao dao;
  final SyncWorker worker;
  final TokenStore tokenStore;
  final GpsCollector gps;

  static Future<AppRuntime> bootstrap({
    required String dbPath,
    required TokenStore tokenStore,
    DatabaseFactory? dbFactory,
    http.Client? httpClient,
    String Function()? now,
  }) async {
    final db = await (dbFactory ?? databaseFactory).openDatabase(
      dbPath,
      version: FixDao.dbVersion,
      onCreate: FixDao.onCreate,
    );
    final dao = FixDao(db);
    // §1.8.1 crash recovery BEFORE anything reads the cache.
    await dao.recoverUnackedUploads();

    final worker = SyncWorker(
      dao: dao,
      uploader: SyncWorker.httpUploader(
        accessToken: () => tokenStore.accessToken ?? '',
        client: httpClient,
      ),
    );
    await worker.refreshPendingCount();

    final gps = GpsCollector(dao: dao);
    return AppRuntime._(dao: dao, worker: worker, tokenStore: tokenStore, gps: gps);
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
  SyncState stateOf(SyncState s) => s; // re-export for UI badges

  @override
  void dispose() {
    worker.pendingCount.removeListener(notifyListeners);
    worker.dispose();
    super.dispose();
  }
}
