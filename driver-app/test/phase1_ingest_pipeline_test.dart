import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:yet_driver/core/app_runtime.dart';
import 'package:yet_driver/core/cache/fix_dao.dart';
import 'package:yet_driver/core/cache/sensor_dao.dart';
import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/core/sync/sync_state.dart';
import 'package:yet_driver/core/sync/sync_worker.dart';
import 'package:yet_driver/features/auth/token_store.dart';
import 'package:yet_driver/features/trip/gps_collector.dart' show RawPosition;
import 'package:yet_driver/features/trip/sensor_collector.dart';

/// Phase 1 completion-gate tests (implementation instruction §Phase 1):
///  * process-death recovery of the local cache THROUGH the default
///    AppRuntime.bootstrap path (not just the DAO unit);
///  * HTTP 429 → Retry-After honoured by the production uploader
///    (SyncWorker.httpUploader) via an injected fake http.Client;
///  * batch wire format + event-time ordering of the real claim path against
///    a real (FDB) SQLite engine — the same SQL sqflite runs on device.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    // Headless Linux has no native sqlite3 binding for sqflite's platform
    // channel; route the SAME Database API through sqflite_common_ffi so the
    // runtime bootstrap exercises real SQL, real pages, real persistence.
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    // Deterministic, offline-safe base URL for the uploader under test.
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  group('AppRuntime.bootstrap process-death replay (§1.8.1)', () {
    late Directory dir;
    late String dbPath;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('yet_test_db');
      dbPath = '${dir.path}/yet_cache.db';
    });

    tearDown(() async {
      await databaseFactory.deleteDatabase(dbPath);
    });

    Future<void> seedCrashState() async {
      // "Process #1": open fresh, create schema, insert fixes + sensor events,
      // then simulate a crash MID-UPLOAD: rows stuck UPLOADING with a batch_id
      // that was never ACKed (the exact state left behind by a kill).
      final db = await databaseFactory.openDatabase(
        dbPath,
        options: OpenDatabaseOptions(
          version: FixDao.dbVersion,
          onCreate: (db, v) async {
            await FixDao.onCreate(db, v);
            await SensorDao.onCreate(db, v);
          },
        ),
      );
      final dao = FixDao(db);
      final sdao = SensorDao(db);
      for (var i = 0; i < 5; i++) {
        await dao.insertFix(StoredFix(
          id: 0,
          lat: 9.0 + i / 1000,
          lng: 38.7 + i / 1000,
          fixTimestamp:
              DateTime.utc(2026, 10, 23, 7, 0, i),
          provider: 'gps',
          syncState: SyncState.pending,
        ));
      }
      for (var i = 0; i < 3; i++) {
        await sdao.insertEvent(StoredSensorEvent(
          id: 0,
          kind: 'accelerometer',
          eventTimestamp: DateTime.utc(2026, 10, 23, 7, 0, i),
          payload: const {'values': [0.1, 9.8, 0.2]},
          syncState: SyncState.pending,
        ));
      }
      // Claim two batches, then "die" before any ACK arrives.
      final claimedFixes = await dao.claimBatch('crash-batch-1', 100);
      expect(claimedFixes.length, 5);
      final claimedSensors = await sdao.claimBatch('crash-batch-s1', 100);
      expect(claimedSensors.length, 3);
      await db.close(); // abrupt end of process #1 — rows stay UPLOADING
    }

    Future<void> verifyRecovered(AppRuntime runtime) async {
      // Bootstrap ran recoverUnackedUploads BEFORE anything read the cache:
      // every crashed row is back to PENDING with its stale batch_id cleared,
      // and NOTHING was deleted (§1.8.1 no-data-loss rule).
      final fixRows = await runtime.dao.db.query(FixDao.tableFixes);
      expect(fixRows.length, 5);
      for (final r in fixRows) {
        expect(r['sync_state'], 'PENDING');
        expect(r['batch_id'], isNull);
      }
      final sensorRows =
          await runtime.sensorDao.db.query(SensorDao.tableSensors);
      expect(sensorRows.length, 3);
      for (final r in sensorRows) {
        expect(r['sync_state'], 'PENDING');
        expect(r['batch_id'], isNull);
      }
    }

    test('UPLOADING rows from a killed process return to PENDING on bootstrap',
        () async {
      await seedCrashState();

      SharedPreferencesShim.install();
      final tokens = TokenStore();
      await tokens.load(); // offline first run: no token persisted
      final runtime = await AppRuntime.bootstrap(
        tokenStore: tokens,
        dbPathOverride: dbPath,
        positionSource: () => const Stream<RawPosition>.empty(),
        sensorSource: () => const Stream<RawSensorSample>.empty(),
        httpClient: MockClient((_) async => http.Response('{}', 500)),
      );
      addTearDown(runtime.dispose);

      await verifyRecovered(runtime);
      // The pending counter the trip screen binds to reflects the recovered
      // backlog immediately after bootstrap (5 fixes + 3 sensor events).
      expect(runtime.pendingFixes, 8);
    });

    test('recovered rows re-upload atomically through the SAME pipeline',
        () async {
      await seedCrashState();

      SharedPreferencesShim.install();
      final tokens = TokenStore();
      await tokens.load();

      final seenBatches = <String, List<Map<String, dynamic>>>{};
      final client = MockClient((req) async {
        if (req.url.path == '/ingest/locations') {
          final j = jsonDecode(req.body) as Map<String, dynamic>;
          seenBatches[j['batch_id'] as String] =
              (j['fixes'] as List).cast<Map<String, dynamic>>();
          return http.Response(
              jsonEncode({
                'batch_id': j['batch_id'],
                'accepted': (j['fixes'] as List).length,
                'already_received': false,
              }),
              200,
              headers: {'content-type': 'application/json'});
        }
        if (req.url.path == '/ingest/sensors') {
          final j = jsonDecode(req.body) as Map<String, dynamic>;
          return http.Response(
              jsonEncode({
                'batch_id': j['batch_id'],
                'accepted': (j['events'] as List? ?? []).length,
                'already_received': false,
              }),
              200,
              headers: {'content-type': 'application/json'});
        }
        return http.Response('not found', 404);
      });

      final runtime = await AppRuntime.bootstrap(
        tokenStore: tokens,
        dbPathOverride: dbPath,
        positionSource: () => const Stream<RawPosition>.empty(),
        sensorSource: () => const Stream<RawSensorSample>.empty(),
        httpClient: client,
      );
      addTearDown(runtime.dispose);
      await verifyRecovered(runtime);

      // Drain: worker claims fresh batches (new UUIDs — never the crashed one)
      // and POSTs the exact recovered rows.
      final outcome = await runtime.worker.runOnce();
      expect(outcome, SyncOutcome.uploaded);
      expect(seenBatches.length, 1);
      final posted = seenBatches.values.single;
      expect(posted.length, 5);
      // Event-time ASC order preserved inside the replayed batch (§1.8.3).
      final times =
          posted.map((f) => f['fix_timestamp'] as String).toList();
      expect(times, [...times]..sort());

      final acked = await runtime.dao.db
          .query(FixDao.tableFixes, where: "sync_state = 'ACKED'");
      expect(acked.length, 5);
      expect(runtime.pendingFixes, 3); // only the sensor backlog remains
    });
  });

  group('SyncWorker.httpUploader 429 handling (§1.10.4)', () {
    test('honours numeric Retry-After on the wire and surfaces it to the worker',
        () async {
      final captured = <http.Request>[];
      final client = MockClient((req) async {
        captured.add(req);
        return http.Response(
          jsonEncode({'error': 'rate_limited'}),
          429,
          headers: {'retry-after': '7'},
        );
      });
      final uploader = SyncWorker.httpUploader(
        accessToken: () => 'test-jwt',
        client: client,
        baseUrlOverride: 'http://127.0.0.1:9/api',
      );

      Object? thrown;
      try {
        await uploader('b-429', [
          StoredFix(
            id: 0,
            lat: 9.0,
            lng: 38.7,
            fixTimestamp: DateTime.utc(2026, 10, 25),
            syncState: SyncState.uploading,
            batchId: 'b-429',
          ),
        ]);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, isA<RetryableUploadException>());
      expect((thrown as RetryableUploadException).retryAfter,
          const Duration(seconds: 7));
      // Contract headers the Ethiopian gateway expects on every batch POST.
      expect(captured.single.headers['authorization'], 'Bearer test-jwt');
      expect(captured.single.headers['content-type'], 'application/json');
      expect(jsonDecode(captured.single.body)['batch_id'], 'b-429');
    });

    test('429 without Retry-After stays retryable with null override (backoff falls through)',
        () async {
      final client = MockClient((_) async => http.Response('{}', 429));
      final uploader = SyncWorker.httpUploader(
        accessToken: () => 't',
        client: client,
        baseUrlOverride: 'http://127.0.0.1:9/api',
      );
      await expectLater(
        uploader('b-nora', const []),
        throwsA(isA<RetryableUploadException>()
            .having((e) => e.retryAfter, 'retryAfter', isNull)),
      );
    });

    test('worker gates the next attempt by Retry-After, not by backoff exponent',
        () async {
      // End-to-end: runOnce() must consume the exception's retryAfter and put
      // the rows back to PENDING with attempts++ (§1.8.1 release path).
      final db = await _freshFakeEngineDb();
      final dao = FixDao(db);
      for (var i = 0; i < 3; i++) {
        await dao.insertFix(StoredFix(
          id: 0,
          lat: 9.0,
          lng: 38.7,
          fixTimestamp: DateTime.utc(2026, 10, 25, 7, 0, i),
          syncState: SyncState.pending,
        ));
      }
      final worker = SyncWorker(
        dao: dao,
        uploader: (_, __) async =>
            throw const RetryableUploadException('rate limited',
                retryAfter: Duration(seconds: 11)),
      );
      final outcome = await worker.runOnce();
      expect(outcome, SyncOutcome.failed);
      final rows = await db.query(FixDao.tableFixes);
      for (final r in rows) {
        expect(r['sync_state'], 'PENDING');
        expect(r['upload_attempts'], 1);
      }
      // While blocked, further triggers are no-ops (no hammering the gateway).
      expect(await worker.runOnce(), SyncOutcome.nothingPending);
      await db.close();
    });

    test('5xx is retryable, other 4xx permanent, 200-with-garbage never blind-ACKs',
        () async {
      Future<Object?> capture(int status, {String body = '{}'}) async {
        final client = MockClient((_) async => http.Response(body, status));
        final uploader = SyncWorker.httpUploader(
          accessToken: () => 't',
          client: client,
          baseUrlOverride: 'http://127.0.0.1:9/api',
        );
        try {
          await uploader('b-x', const []);
          return null;
        } catch (e) {
          return e;
        }
      }

      expect(await capture(503), isA<RetryableUploadException>());
      expect(await capture(401), isA<PermanentUploadException>());
      expect(await capture(400), isA<PermanentUploadException>());
      // 200 but unparseable body → retryable, rows are NEVER ACKed blindly.
      expect(await capture(200, body: '<html>proxy error</html>'),
          isA<RetryableUploadException>());
    });
  });

  group('Batch wire format (LocationFixSchema mirror)', () {
    test('encodeBatchBody emits batch_id + client_sent_at + ordered fixes', () {
      final fixes = [
        StoredFix(
            id: 1,
            lat: 9.01,
            lng: 38.71,
            fixTimestamp: DateTime.utc(2026, 10, 25, 7),
            speedMps: 12.5,
            syncState: SyncState.uploading,
            batchId: 'b-1'),
        StoredFix(
            id: 2,
            lat: 9.02,
            lng: 38.72,
            fixTimestamp: DateTime.utc(2026, 10, 25, 7, 0, 10),
            syncState: SyncState.uploading,
            batchId: 'b-1'),
      ];
      final j = jsonDecode(encodeBatchBody('b-1', fixes)) as Map<String, dynamic>;
      expect(j['batch_id'], 'b-1');
      expect(j['client_sent_at'], isA<String>());
      final list = j['fixes'] as List;
      expect(list.length, 2);
      expect((list[0] as Map)['fix_timestamp'], '2026-10-25T07:00:00.000Z');
      expect((list[0] as Map)['speed_mps'], 12.5);
      // Optional fields absent when null — backend schema treats them optional.
      expect((list[1] as Map).containsKey('speed_mps'), isFalse);
    });
  });
}

// ── Harness helpers ──────────────────────────────────────────────────────────

/// FFI-backed SQLite with the YET schema applied — used by the worker-level
/// 429 test so claim/release/attempts++ run through real SQL.
Future<Database> _freshFakeEngineDb() async {
  final dir = await Directory.systemTemp.createTemp('yet_test_db');
  return databaseFactory.openDatabase(
    '${dir.path}/w.db',
    options: OpenDatabaseOptions(
      version: 1,
      onCreate: (db, v) async {
        await FixDao.onCreate(db, v);
        await SensorDao.onCreate(db, v);
      },
    ),
  );
}

/// shared_preferences needs a platform channel in a pure-Dart test context;
/// install a trivial in-memory shim so TokenStore.load() works headlessly.
class SharedPreferencesShim {
  static final Map<String, Object> _store = {};

  static void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(const MethodChannel('plugins.flutter.io/shared_preferences'),
            (call) async {
      switch (call.method) {
        case 'getAll':
          return Map<String, Object>.from(_store);
        case 'setString':
          _store[call.arguments['key'] as String] = call.arguments['value'];
          return true;
        case 'remove':
          _store.remove(call.arguments['key'] as String);
          return true;
        case 'clear':
          _store.clear();
          return true;
      }
      return null;
    });
  }
}
