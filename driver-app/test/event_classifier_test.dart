import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite/sqflite.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:yet_driver/core/cache/fix_dao.dart';
import 'package:yet_driver/core/cache/sensor_dao.dart';
import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/core/sync/sync_state.dart';
import 'package:yet_driver/features/trip/event_classifier.dart';
import 'package:yet_driver/features/trip/sensor_collector.dart';

/// Phase 2 completion-gate tests (implementation instruction §Phase 2):
///  * on-device classifier THRESHOLD behavior (below / exactly-at / above the
///    calibrated limits — kernel semantics identical to the backend TS fusion
///    kernel in src/modules/trip_engine/state_machine.ts, mirrored fixtures);
///  * cooldown suppression and flush-at-trip-end of open runs;
///  * resolveThresholds fallback chain: fresh fetch → last-cached → defaults;
///  * CachedConfigStore round-trip through a real SQLite engine (FFI);
///  * sensor-batch UUID idempotency at BOTH legs of §1.8.2: client-side
///    claimBatch/markBatchAcked double-ACK replay leaves the row set unchanged,
///    and the encoded batch is content-stable so a server replay hits the
///    ingest_batches.batch_id PK ON CONFLICT path (backend contract asserted in
///    backend/tests/sensor_batch_contract.test.ts).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    // Same harness pattern as phase1_ingest_pipeline_test.dart: headless Linux
    // has no sqflite platform channel, so route the identical Database API
    // through sqflite_common_ffi — real SQL, real persistence.
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  final t0 = DateTime.utc(2026, 10, 20, 8, 0, 0);
  Duration ms(int m) => Duration(milliseconds: m);

  RawSensorSample accel(DateTime t, double x, [double z = 9.81]) =>
      RawSensorSample(kind: 'accelerometer', timestampUtc: t, values: [x, 0, z]);
  RawSensorSample gyro(DateTime t, double zRadPerS) => RawSensorSample(
      kind: 'gyroscope', timestampUtc: t, values: [0, 0, zRadPerS]);
  double dps(double degPerSec) => degPerSec * 3.141592653589793 / 180.0;

  group('EventClassifier thresholds (§1.3, mirrors TS kernel)', () {
    // Defaults: brake 3.5 · accel 2.5 · turn 35 dps / 1000 ms · gap 2000 · cd 5000.

    test('BELOW limit: -3.4 peak emits no harsh event', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -3.4, -3.4, 0.0], t0);
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind.startsWith('harsh')), isEmpty);
    });

    test('AT limit: -3.5 exactly emits HARSH_BRAKE (inclusive crossing)', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -3.5, -3.5, 0.0], t0);
      await h.classifier.flush();
      final brakes = h.discrete().where((e) => e.kind == 'harsh_brake').toList();
      expect(brakes.length, 1);
      expect(brakes.single.extra['magnitude_mps2'], 3.5);
      expect(brakes.single.extra['threshold_mps2'], 3.5);
      expect(brakes.single.extra['source'], 'device');
    });

    test('ABOVE limit: -5.0 excursion emits one grouped HARSH_BRAKE at the peak', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -4.0, -5.0, -4.2, 0.0], t0);
      await h.classifier.flush();
      final brakes = h.discrete().where((e) => e.kind == 'harsh_brake').toList();
      expect(brakes.length, 1); // one event per excursion, not per sample
      expect(brakes.single.timestampUtc, t0.add(ms(2000))); // extreme sample time
      expect(brakes.single.extra['magnitude_mps2'], 5.0);
    });

    test('harsh ACCEL positive side: +2.5 exactly emits HARSH_ACCEL', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, 2.5, 2.5, 0.0], t0);
      await h.classifier.flush();
      final accels = h.discrete().where((e) => e.kind == 'harsh_accel').toList();
      expect(accels.length, 1);
      expect(accels.single.extra['threshold_mps2'], 2.5);
    });

    test('cooldown: second excursion within cooldownMs is suppressed', () async {
      final h = _Harness();
      // Excursion 1 peaks at t+1s..t+2s (closed by baseline at t+3s), emits.
      // Excursion 2 peaks at t+4s..t+5s — 2 s after the first emission ⇒
      // inside the 5000 ms cooldown ⇒ suppressed (peak-per-window rule).
      await _feed(h.classifier, [0.0, -5.0, -5.0, 0.0, -5.0, -5.0, 0.0], t0);
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind == 'harsh_brake').length, 1);
    });

    test('past cooldown: excursions >5 s apart both emit', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -5.0, -5.0, 0.0], t0); // emits ~t+1s
      await _feed(h.classifier, [0.0, -4.0, 0.0], t0.add(ms(10000))); // emits ~t+11s
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind == 'harsh_brake').length, 2);
    });

    test('turn BELOW rate: 34 dps sustained emits nothing', () async {
      final h = _Harness();
      for (var i = 0; i <= 3; i++) {
        await h.classifier.onSample(gyro(t0.add(ms(i * 500)), dps(34)));
      }
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind == 'turn'), isEmpty);
    });

    test('turn AT rate + MIN duration: 35 dps for 1000 ms emits TURN right', () async {
      final h = _Harness();
      for (var i = 0; i <= 2; i++) {
        await h.classifier.onSample(gyro(t0.add(ms(i * 500)), dps(35)));
      }
      await h.classifier.flush();
      final turns = h.discrete().where((e) => e.kind == 'turn').toList();
      expect(turns.length, 1);
      expect(turns.single.extra['direction'], 'right');
      expect(turns.single.extra['duration_ms'], 1000);
      expect(turns.single.extra['source'], 'device');
    });

    test('turn sustained but SHORT: < min duration emits nothing', () async {
      final h = _Harness();
      await h.classifier.onSample(gyro(t0, dps(60)));
      await h.classifier.onSample(gyro(t0.add(ms(500)), dps(60))); // only 500 ms span
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind == 'turn'), isEmpty);
    });

    test('turn LEFT sign from negative yaw rate', () async {
      final h = _Harness();
      for (var i = 0; i <= 2; i++) {
        await h.classifier.onSample(gyro(t0.add(ms(i * 500)), dps(-55)));
      }
      await h.classifier.flush();
      final turns = h.discrete().where((e) => e.kind == 'turn').toList();
      expect(turns.single.extra['direction'], 'left');
      expect(turns.single.extra['peak_rate_dps'], 55.0);
    });

    test('vibration gate: parked→rumble transition opens, rumble→parked closes', () async {
      final h = _Harness();
      // Parked: constant z (zero variance).
      for (var i = 0; i < 4; i++) {
        await h.classifier.onSample(accel(t0.add(ms(i * 100)), 0.0, 9.81));
      }
      expect(h.discrete().where((e) => e.kind == 'vibration_gate'), isEmpty);
      // Engine rumble: alternate ±0.5 around gravity → window variance
      // 0.25 ≥ 0.05 ⇒ OPEN.
      for (var i = 4; i < 10; i++) {
        await h.classifier.onSample(
            accel(t0.add(ms(i * 100)), 0.0, i.isOdd ? 10.31 : 9.31));
      }
      final gates = h.discrete().where((e) => e.kind == 'vibration_gate').toList();
      expect(gates.length, 1);
      expect(gates.single.extra['state'], 1);
      expect(gates.single.extra['reason'], 'vibration_gate_open');
      // Back to parked stillness ⇒ CLOSE.
      for (var i = 10; i < 16; i++) {
        await h.classifier.onSample(accel(t0.add(ms(i * 100)), 0.0, 9.81));
      }
      final gates2 =
          h.discrete().where((e) => e.kind == 'vibration_gate').toList();
      expect(gates2.length, 2);
      expect(gates2.last.extra['state'], 0);
      expect(gates2.last.extra['reason'], 'vibration_gate_close');
    });

    test('reset() clears run state and cooldown across trips', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -5.0, -5.0, 0.0], t0); // emits #1
      await h.classifier.flush();
      h.classifier.reset();
      await _feed(h.classifier, [0.0, -5.0, -5.0, 0.0], t0.add(ms(2000)));
      // Without reset() this would be cooldown-suppressed; with it, it emits.
      await h.classifier.flush();
      expect(h.discrete().where((e) => e.kind == 'harsh_brake').length, 2);
    });

    test('mutable th applies freshly fetched calibration from next sample on', () async {
      final h = _Harness();
      final c = EventClassifier(
        thresholds: const ClassificationThresholds(
            harshBrakeMps2: 10, // impossible limit
            harshAccelMps2: 2.5,
            turnRateDps: 35,
            turnMinDurationMs: 1000,
            maxSampleGapMs: 2000,
            cooldownMs: 5000,
            vibrationGateVariance: 0.05),
        sink: h.sink,
      );
      await _feed(c, [0.0, -5.0, -5.0, 0.0], t0);
      await c.flush();
      expect(h.discrete().where((e) => e.kind == 'harsh_brake'), isEmpty);
      // Re-calibrate to the default limit mid-life (AppRuntime does this at
      // trip start alongside reset()).
      c.th = ClassificationThresholds.defaults;
      c.reset();
      await _feed(c, [0.0, -5.0, -5.0, 0.0], t0);
      await c.flush();
      expect(h.discrete().where((e) => e.kind == 'harsh_brake').length, 1);
    });

    test('raw samples pass through untouched (collector still caches them)', () async {
      final h = _Harness();
      await _feed(h.classifier, [0.0, -5.0, -5.0, 0.0], t0);
      expect(h.all.where((s) => s.kind == 'accelerometer').length, 4);
    });
  });

  group('resolveThresholds fallback chain (§1.8 offline-first)', () {
    late Directory dir;
    late String dbPath;
    late Database db;

    setUp(() async {
      dir = await dbFactory.createTemporaryDatabaseDirectory();
      dbPath = '${dir.path}/cfg.db';
      db = await databaseFactory.openDatabase(dbPath,
          options: OpenDatabaseOptions(
              version: 1,
              onCreate: (d, v) => CachedConfigStore.onCreate(d as Database, v)));
    });

    tearDown(() async {
      await db.close();
      await databaseFactory.deleteDatabase(dbPath);
    });

    test('fresh fetch wins and is persisted to cache', () async {
      final store = CachedConfigStore(db);
      final th = await resolveThresholds(
        source: _FakeSource(classificationConfigPayloadFixture()),
        cache: store,
      );
      expect(th.harshBrakeMps2, 4.2);
      expect(th.turnRateDps, 40);
      // Persisted: a subsequent offline resolve restores it, not the defaults.
      final restored =
          await resolveThresholds(source: _FakeSource(null), cache: store);
      expect(restored.harshBrakeMps2, 4.2);
    });

    test('no network + virgin cache → documented defaults', () async {
      final th = await resolveThresholds(
        source: _FakeSource(null),
        cache: CachedConfigStore(db),
      );
      expect(th.harshBrakeMps2, ClassificationThresholds.defaults.harshBrakeMps2);
      expect(th.cooldownMs, ClassificationThresholds.defaults.cooldownMs);
    });

    test('HttpClassificationConfigSource parses a live 200 body end-to-end', () async {
      final body = jsonEncode(classificationConfigPayloadFixture());
      final client = MockClient((req) async {
        expect(req.url.path, '/trips/classification-config');
        expect(req.headers['authorization'], 'Bearer tok-1');
        return http.Response(body, 200);
      });
      final src = HttpClassificationConfigSource(
          client: client, accessToken: () => 'tok-1');
      final th =
          await resolveThresholds(source: src, cache: CachedConfigStore(db));
      expect(th.harshBrakeMps2, 4.2);
      expect(th.vibrationGateVariance, 0.07);
    });

    test('HttpClassificationConfigSource swallows non-200/errors → null (fallback path)', () async {
      final failing = HttpClassificationConfigSource(
          client: MockClient((_) async => http.Response('{}', 401)),
          accessToken: () => null);
      expect(await failing.fetch(), isNull);
      final throwing = HttpClassificationConfigSource(
          client: MockClient((_) async => throw http.ClientException('offline')));
      expect(await throwing.fetch(), isNull);
    });

    test('CachedConfigStore save→load round-trip preserves every field', () async {
      const custom = ClassificationThresholds(
          harshBrakeMps2: 4.2,
          harshAccelMps2: 2.9,
          turnRateDps: 40,
          turnMinDurationMs: 1200,
          maxSampleGapMs: 1500,
          cooldownMs: 6000,
          vibrationGateVariance: 0.07);
      final store = CachedConfigStore(db);
      await store.save(custom);
      final back = await store.load();
      expect(back, isNotNull);
      expect(back!.toJson(), custom.toJson());
      // Singleton row: re-save overwrites rather than appending.
      await store.save(ClassificationThresholds.defaults);
      final rows = await db.query(CachedConfigStore.tableConfig);
      expect(rows.length, 1);
      final latest = await store.load();
      expect(latest!.harshBrakeMps2, 3.5);
    });
  });

  group('sensor-batch UUID idempotency (§1.8.2, client leg)', () {
    late Directory dir;
    late String dbPath;
    late SensorDao dao;

    setUp(() async {
      dir = await dbFactory.createTemporaryDatabaseDirectory();
      dbPath = '${dir.path}/sensors.db';
      final db = await databaseFactory.openDatabase(dbPath,
          options: OpenDatabaseOptions(
              version: FixDao.dbVersion,
              onCreate: (d, v) async {
                await FixDao.onCreate(d as Database, v);
                await SensorDao.onCreate(d as Database, v);
              }));
      dao = SensorDao(db);
    });

    tearDown(() async {
      await dao.close();
      await databaseFactory.deleteDatabase(dbPath);
    });

    Future<void> seedEvents(SensorDao d, int n, DateTime start) async {
      for (var i = 0; i < n; i++) {
        final id = await d.insertEvent(pendingSensorRow(
          kind: 'harsh_brake',
          ts: start.add(Duration(seconds: i)),
          payload: {
            'values': [-5.0],
            'magnitude_mps2': 5.0,
            'source': 'device',
          },
        ));
        expect(id, greaterThan(0));
      }
    }

    test('claimBatch stamps one UUID; double ACK replay changes nothing', () async {
      await seedEvents(dao, 4, t0);
      final batchId = '3f2a7b6c-1111-4222-8333-aabbccddeeff';
      final claimed = await dao.claimBatch(batchId, 10);
      expect(claimed.length, 4);
      expect(claimed.every((e) => e.syncState == SyncState.uploading), isTrue);
      expect(claimed.every((e) => e.batchId == batchId), isTrue);

      expect(await dao.markBatchAcked(batchId), 4); // first ACK
      expect(await dao.markBatchAcked(batchId), 0); // REPLAYED ACK — no-op
      final rows = await dao.db.query(SensorDao.tableSensors);
      expect(rows.length, 4); // duplicate never inserts or deletes records
      expect(rows.every((r) => r['sync_state'] == 'ACKED'), isTrue);

      // A second claim can never re-upload ACKED rows (batch UUID already
      // consumed server-side): backlog is empty.
      expect(
          await dao.claimBatch('9a8b7c6d-5555-4444-8888-111122223333', 10),
          isEmpty);
      expect(await dao.pendingCount(), 0);
    });

    test('process-death replay: unacked UPLOADING returns to PENDING and reclaims under a NEW uuid', () async {
      await seedEvents(dao, 3, t0);
      final b1 = '11111111-2222-4333-8444-555555555555';
      await dao.claimBatch(b1, 10);
      // Crash before ACK → reopen performs recovery (§1.8.1).
      expect(await dao.recoverUnackedUploads(), 3);
      final b2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      final reclaimed = await dao.claimBatch(b2, 10);
      expect(reclaimed.length, 3);
      expect(reclaimed.every((e) => e.batchId == b2), isTrue);
      // Server sees b2 as new (records deduped by content keys upstream);
      // replaying the SAME b2 body is what the ON CONFLICT path absorbs.
    });

    test('encodeSensorBatchBody is replay-stable and matches wire schema shape', () async {
      await seedEvents(dao, 2, t0);
      final batchId = 'deadbeef-1111-4222-8333-aabbccddeeff';
      final claimed = await dao.claimBatch(batchId, 10);
      final first = jsonDecode(encodeSensorBatchBody(batchId, claimed));
      final replay = jsonDecode(encodeSensorBatchBody(batchId, claimed));
      final decoded = first as Map<String, Object?>;
      expect(decoded['batch_id'], batchId);
      final events = decoded['events'] as List;
      expect(events.length, 2);
      final ev = events.first as Map<String, Object?>;
      // Exact key set POST /ingest/sensors SensorBatchSchema requires.
      expect(ev.keys.toSet(), {'event_timestamp', 'kind', 'payload'});
      expect(ev['kind'], 'harsh_brake');
      // Content-stable replay: only the volatile client_sent_at wall-clock may
      // differ between encodes; every server-deduped byte (batch_id + ordered
      // event bodies) is identical ⇒ a wire-level replay hits the
      // ingest_batches.batch_id PK ON CONFLICT path ⇒ already_received
      // (asserted against the real Fastify route in
      // backend/tests/sensor_batch_contract.test.ts).
      expect(decoded['batch_id'], (replay as Map<String, Object?>)['batch_id']);
      expect(decoded['events'], replay['events']);
      // Deterministic content ordering (event-time ASC) between claims/replays.
    });

    test('classifier emissions flow through SensorCollector.ingest unthrottled into the cache', () async {
      final collector = SensorCollector(
          dao: dao, sampleInterval: const Duration(seconds: 2));
      await collector.beginCollection();
      final h = _Harness();
      final c = EventClassifier(
          thresholds: ClassificationThresholds.defaults,
          sink: (s) async {
            await collector.ingest(s);
            await h.sink(s);
          });
      // Two raw accel samples 1 s apart (under the 2 s throttle) forming a
      // braking run; the discrete event they produce must still be stored.
      await c.onSample(accel(t0, 0.0));
      await c.onSample(accel(t0.add(const Duration(seconds: 1)), -5.0));
      await c.onSample(accel(t0.add(const Duration(seconds: 2)), -5.0));
      await c.onSample(accel(t0.add(const Duration(seconds: 3)), 0.0));
      await c.flush();
      // Discrete harsh_brake bypasses throttling entirely (§Phase 2 contract).
      final batchId = 'cafe1234-0000-4000-8000-abcdefabcdef';
      final stored = await dao.claimBatch(batchId, 10);
      expect(stored.map((e) => e.kind), contains('harsh_brake'));
      await collector.endCollection();
    });
  });
}

/// Payload fixture mirroring GET /trips/classification-config exactly
/// (backend classificationConfigPayload(): policy + snake_case thresholds).
Map<String, Object?> classificationConfigPayloadFixture() => {
      'policy': 'trip-classification-v1',
      'thresholds': {
        'harsh_brake_mps2': 4.2,
        'harsh_accel_mps2': 2.9,
        'turn_rate_dps': 40,
        'turn_min_duration_ms': 1200,
        'max_sample_gap_ms': 1500,
        'cooldown_ms': 6000,
        'vibration_gate_variance': 0.07,
      },
      'sampling': {'sample_interval_ms': 2000},
    };

class _FakeSource implements ClassificationConfigSource {
  _FakeSource(this.payload);
  final Map<String, Object?>? payload;
  @override
  Future<Map<String, Object?>?> fetch() async => payload;
}

/// Capturing sink for classifier emissions + raw pass-through samples.
class _Harness {
  _Harness() {
    classifier = EventClassifier(
        thresholds: ClassificationThresholds.defaults, sink: sink);
  }

  final all = <RawSensorSample>[];
  late final EventClassifier classifier;

  Future<void> sink(RawSensorSample e) async => all.add(e);

  List<RawSensorSample> discrete() => all
      .where((s) =>
          s.kind == 'harsh_brake' ||
          s.kind == 'harsh_accel' ||
          s.kind == 'turn' ||
          s.kind == 'vibration_gate')
      .toList();
}

Future<void> _feed(EventClassifier c, List<double> xs, DateTime t0,
    {int stepMs = 1000}) async {
  for (var i = 0; i < xs.length; i++) {
    await c.onSample(RawSensorSample(
        kind: 'accelerometer',
        timestampUtc: t0.add(Duration(milliseconds: i * stepMs)),
        values: [xs[i], 0, 9.81]));
  }
}
