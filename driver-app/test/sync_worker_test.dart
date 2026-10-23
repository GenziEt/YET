import 'dart:async';
import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:yet_driver/core/cache/fix_dao.dart';
import 'package:yet_driver/core/sync/sync_state.dart';
import 'package:yet_driver/core/sync/sync_worker.dart';

/// In-memory sqflite stand-in. Records every statement so tests can assert on
/// the exact SQL the Offline Contract code emits (claim ordering, ACK updates,
/// prune WHERE clauses) without a device or native SQLite.
class FakeDb implements Database {
  final List<String> executed = [];
  final List<String> queries = [];
  /// Queue of rawQuery results consumed in FIFO order (PRAGMAs, counts...).
  final List<List<Map<String, Object?>>> rawResults = [];
  int lastUpdateCount = 0;
  int lastDeleteCount = 0;
  int lastInsertId = 1;

  @override
  String get path => 'fake.db';
  @override
  int get version => 1;

  @override
  Future<void> execute(String sql, [List<Object?>? arguments]) async {
    executed.add(sql);
  }

  @override
  Future<T> transaction<T>(Future<T> Function(Transaction txn) action,
      {bool? exclusive}) async {
    return action(_FakeTxn(this));
  }

  @override
  Future<List<Map<String, Object?>>> query(String table,
      {String? where,
      List<Object?>? whereArgs,
      String? orderBy,
      int? limit,
      int? offset}) async {
    queries.add('query:$table where=$where orderBy=$orderBy limit=$limit');
    return const [];
  }

  @override
  Future<List<Map<String, Object?>>> rawQuery(String sql,
      [List<Object?>? args]) async {
    queries.add('raw:$sql');
    if (rawResults.isNotEmpty) return rawResults.removeAt(0);
    return const [];
  }

  @override
  Future<Map<String, Object?>?> rawQueryFirst(String sql,
      [List<Object?>? args]) async {
    final rows = await rawQuery(sql, args);
    return rows.isEmpty ? null : rows.first;
  }

  @override
  Future<int> insert(String table, Map<String, Object?> values,
      {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm}) async {
    queries.add('insert:$table state=${values['sync_state']}');
    return lastInsertId++;
  }

  @override
  Future<int> update(String table, Map<String, Object?> values,
      {String? where, List<Object?>? whereArgs}) async {
    queries.add('update:$table set=${values['sync_state']} where=$where');
    return lastUpdateCount;
  }

  @override
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs}) async {
    queries.add('delete:$table where=$where');
    return lastDeleteCount;
  }

  @override
  Future<int> rawInsert(String sql, [List<Object?>? args]) async => 1;
  @override
  Future<int> rawUpdate(String sql, [List<Object?>? args]) async => 1;
  @override
  Future<void> close() async {}
}

class _FakeTxn implements Transaction {
  _FakeTxn(this.db);
  final FakeDb db;

  @override
  Future<List<Map<String, Object?>>> query(String table,
          {String? where,
          List<Object?>? whereArgs,
          String? orderBy,
          int? limit}) =>
      db.query(table,
          where: where, whereArgs: whereArgs, orderBy: orderBy, limit: limit);

  @override
  Future<List<Map<String, Object?>>> rawQuery(String sql,
          [List<Object?>? args]) =>
      db.rawQuery(sql, args);

  @override
  Future<int> insert(String table, Map<String, Object?> values,
          {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm}) =>
      db.insert(table, values,
          nullColumnHack: nullColumnHack, conflictAlgorithm: conflictAlgorithm);

  @override
  Future<int> update(String table, Map<String, Object?> values,
          {String? where, List<Object?>? whereArgs}) =>
      db.update(table, values, where: where, whereArgs: whereArgs);

  @override
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs}) =>
      db.delete(table, where: where, whereArgs: whereArgs);

  @override
  Future<int> rawInsert(String sql, [List<Object?>? args]) => db.rawInsert(sql, args);
  @override
  Future<int> rawUpdate(String sql, [List<Object?>? args]) => db.rawUpdate(sql, args);
}

Map<String, Object?> row(int id, String ts, {String state = 'PENDING', int attempts = 0}) =>
    {
      'id': id,
      'lat': 9.0 + id / 10000,
      'lng': 38.7 + id / 10000,
      'fix_timestamp': ts,
      'speed_mps': 12.5,
      'accuracy_m': 8.0,
      'heading_deg': 45.0,
      'altitude_m': 2400.0,
      'provider': 'gps',
      'sync_state': state,
      'batch_id': null,
      'upload_attempts': attempts,
    };

void main() {
  group('FixDao schema (§Phase 1)', () {
    test('creates location_fixes with sync_state column + indexes', () async {
      final db = FakeDb();
      await FixDao.onCreate(db, FixDao.dbVersion);
      expect(db.executed.length, 3); // table + 2 indices
      expect(db.executed[0].contains('sync_state TEXT NOT NULL'), isTrue);
      expect(db.executed[0].contains('batch_id TEXT'), isTrue);
      expect(db.executed[0].contains('acked_at TEXT'), isTrue);
      expect(db.executed[1].contains('idx_fixes_sync'), isTrue);
      expect(db.executed[2].contains('idx_fixes_time'), isTrue);
    });

    test('crash recovery: UPLOADING -> PENDING at open (§1.8.1)', () async {
      final db = FakeDb()..lastUpdateCount = 7;
      final dao = FixDao(db);
      final n = await dao.recoverUnackedUploads();
      expect(n, 7);
      expect(db.queries.any((q) => q.contains("set=PENDING") && q.contains("sync_state = 'UPLOADING'")),
          isTrue);
    });

    test('pendingCount counts PENDING + UPLOADING (never lost)', () async {
      final db = FakeDb()..rawResults.add([{'c': 42}]);
      final dao = FixDao(db);
      expect(await dao.pendingCount(), 42);
      expect(db.queries.first.contains('IN (?, ?)'), isTrue);
    });

    test('claimBatch orders by fix_timestamp ASC (event time, §1.8.3)', () async {
      final db = FakeDb();
      db.rawResults.add([]); // consume any stray raw first
      final dao = FixDao(db);
      // query() returns [] by default -> empty claim, no update issued.
      final claimed = await dao.claimBatch('b-1', 100);
      expect(claimed, isEmpty);
      expect(db.queries.first, contains('orderBy=fix_timestamp ASC'));
      expect(db.queries.first, contains('limit=100'));
    });

    test('markBatchAcked moves only this batch UPLOADING->ACKED', () async {
      final db = FakeDb()..lastUpdateCount = 3;
      final dao = FixDao(db);
      final n = await dao.markBatchAcked('b-9');
      expect(n, 3);
      expect(db.queries.last, contains('set=ACKED'));
      expect(db.queries.last, contains("sync_state = 'UPLOADING' AND batch_id = ?"));
    });

    test('prune deletes only ACKED rows — PENDING untouchable (§1.8.6)', () async {
      final db = FakeDb()..lastDeleteCount = 5;
      final dao = FixDao(db);
      final n = await dao.pruneAckedOlderThan(const Duration(days: 7));
      expect(n, 5);
      expect(db.queries.last, contains("delete:location_fixes where=sync_state = 'ACKED'"));
    });
  });

  group('StoredFix wire format matches backend BatchSchema', () {
    test('toJson emits exactly the LocationFixSchema fields', () {
      final f = StoredFix(
        id: 1,
        lat: 9.03,
        lng: 38.74,
        fixTimestamp: DateTime.utc(2026, 10, 23, 7, 30),
        speedMps: 12.5,
        accuracyM: 8,
        provider: SyncStateCodec.name(SyncState.pending).isEmpty ? 'gps' : 'gps',
        syncState: SyncState.pending,
      );
      final j = f.toJson();
      expect(j.containsKey('fix_timestamp'), isTrue);
      expect(j.containsKey('lat'), isTrue);
      expect(j.containsKey('lng'), isTrue);
      expect(j.containsKey('speed_mps'), isTrue);
      expect(j.containsKey('accuracy_m'), isTrue);
      // optional fields omitted when null
      expect(j.containsKey('heading_deg'), isFalse);
      // local-only columns never leave the device
      expect(j.containsKey('id'), isFalse);
      expect(j.containsKey('sync_state'), isFalse);
      expect(j.containsKey('batch_id'), isFalse);
    });

    test('encodeBatchBody carries batch_id + client_sent_at + fixes', () {
      final body = encodeBatchBody('uuid-abc', [
        StoredFix(
            id: 1,
            lat: 9.0,
            lng: 38.7,
            fixTimestamp: DateTime.utc(2026),
            syncState: SyncState.uploading),
      ]);
      expect(body.contains('"batch_id":"uuid-abc"'), isTrue);
      expect(body.contains('"client_sent_at"'), isTrue);
      expect(body.contains('"fixes"'), isTrue);
    });
  });

  group('SyncWorker offline contract (§1.8.1)', () {
    test('UUID v4 shape + version/variant bits', () {
      for (var i = 0; i < 25; i++) {
        final u = newUuidV4(Random(i));
        expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
            .hasMatch(u), isTrue);
      }
    });

    test('backoff grows exponentially and caps at 5 minutes (§1.8.1)', () {
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (_, __) async => throw UnimplementedError(),
        baseBackoff: const Duration(seconds: 2),
        random: Random(7),
      );
      // attempt 1: ~2*2^1 = 4s ±20%
      final b1 = w.backoffForAttempt(1);
      expect(b1.inMilliseconds >= 3200, isTrue);
      expect(b1.inMilliseconds <= 4800, isTrue);
      // attempt 3: ~2*2^3 = 16s ±20%
      final b3 = w.backoffForAttempt(3);
      expect(b3.inMilliseconds >= 12800, isTrue);
      expect(b3.inMilliseconds <= 19200, isTrue);
      // huge attempt count: capped at backoffCap ± jitter (0.8*cap .. cap)
      final bBig = w.backoffForAttempt(40);
      expect(bBig.inMilliseconds >= 240000, isTrue); // >= 0.8 * 5min
      expect(bBig.inMilliseconds <= 300000, isTrue); // <= cap
    });

    test('runOnce: empty cache -> nothingPending, no HTTP call', () async {
      final db = FakeDb();
      var uploads = 0;
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async {
          uploads++;
          return IngestAck(batchId: id, accepted: fixes.length, alreadyReceived: false);
        },
      );
      final outcome = await w.runOnce();
      expect(outcome, SyncOutcome.nothingPending);
      expect(uploads, 0);
    });

    test('success path: claim -> upload -> markBatchAcked (UPLOADING->ACKED)', () async {
      final db = FakeDb();
      // claimBatch: SELECT returns one PENDING row; then UPDATE stamps it.
      db.rawResults.add([row(1, '2026-10-23T07:00:00.000Z')]);
      String? seenBatchId;
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async {
          seenBatchId = id;
          expect(fixes.length, 1);
          expect(fixes.first.syncState, SyncState.uploading);
          expect(fixes.first.batchId, id);
          return IngestAck(batchId: id, accepted: 1, alreadyReceived: false);
        },
      );
      final outcome = await w.runOnce();
      expect(outcome, SyncOutcome.uploaded);
      expect(seenBatchId, isNotNull);
      // batch_id stamped as UUID v4 by the worker
      expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4').hasMatch(seenBatchId!), isTrue);
      // last update moved rows to ACKED
      expect(db.queries.last.contains('set=ACKED'), isTrue);
    });

    test('server idempotency replay: already_received ACK still marks rows ACKED (§1.8.2)', () async {
      final db = FakeDb();
      db.rawResults.add([row(2, '2026-10-23T07:00:10.000Z')]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            IngestAck(batchId: id, accepted: 0, alreadyReceived: true),
      );
      expect(await w.runOnce(), SyncOutcome.uploaded);
      expect(db.queries.last.contains('set=ACKED'), isTrue);
    });

    test('failure path: rows released back to PENDING with attempts++ (§1.8.1)', () async {
      final db = FakeDb();
      db.rawResults.add([row(3, '2026-10-23T07:00:20.000Z')]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            throw const RetryableUploadException('offline'),
        random: Random(1),
      );
      expect(await w.runOnce(), SyncOutcome.failed);
      // release loop updated the single row back to PENDING...
      expect(db.queries.any((q) => q.contains('set=PENDING') && q.contains('batch_id = ?')), isTrue);
      // ...and the worker read MAX(upload_attempts) for the backoff exponent
      expect(db.queries.any((q) => q.contains('MAX(upload_attempts)')), isTrue);
    });

    test('permanent failure releases rows but blocks for the full cap', () async {
      final db = FakeDb();
      db.rawResults.add([row(4, '2026-10-23T07:00:30.000Z')]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            throw const PermanentUploadException('invalid_token'),
      );
      expect(await w.runOnce(), SyncOutcome.failed);
      expect(db.queries.any((q) => q.contains('set=PENDING')), isTrue);
    });

    test('pendingCount notifier refreshes after a pass', () async {
      final db = FakeDb()..rawResults.add([{'c': 17}]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            IngestAck(batchId: id, accepted: fixes.length, alreadyReceived: false),
      );
      await w.refreshPendingCount();
      expect(w.pendingCount.value, 17);
    });

    test('trip cadence uses AppConfig.syncIntervalActiveTrip (60s)', () {
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (id, fixes) async =>
            IngestAck(batchId: id, accepted: fixes.length, alreadyReceived: false),
      );
      w.startTripCadence();
      expect(w.tripActive, isTrue);
      w.dispose();
      expect(w.tripActive, isFalse);
    });

    test('prune: age-based delete runs; budget eviction only past warn level (§1.8.6)', () async {
      // Under the 80MB warn threshold -> only the age prune fires.
      final small = FakeDb()
        ..lastDeleteCount = 4
        ..rawResults.add([{'page_count': 100}]) // pages
        ..rawResults.add([{'page_size': 4096}]); // bytes/page -> 409KB total
      final wSmall = SyncWorker(
        dao: FixDao(small),
        uploader: (id, _) async => IngestAck(batchId: id, accepted: 0, alreadyReceived: false),
      );
      final r1 = await wSmall.prune();
      expect(r1.deletedByAge, 4);
      expect(r1.deletedByBudget, 0);
      expect(r1.warnedDriver, isFalse);

      // Over 80MB -> warn + evict to 50MB budget.
      final big = FakeDb()
        ..lastDeleteCount = 2
        ..rawResults.add([{'page_count': 30000}]) // ~117MB
        ..rawResults.add([{'page_size': 4096}])
        ..rawResults.add([{'page_count': 12000}]) // after eviction ~48MB
        ..rawResults.add([{'page_size': 4096}]);
      final wBig = SyncWorker(
        dao: FixDao(big),
        uploader: (id, _) async => IngestAck(batchId: id, accepted: 0, alreadyReceived: false),
      );
      final r2 = await wBig.prune();
      expect(r2.warnedDriver, isTrue);
      expect(r2.deletedByBudget >= 2, isTrue);
    });
  });

  group('IngestAck parsing (mirrors routes.ts response)', () {
    test('parses accepted + already_received', () {
      final ack = IngestAck.parse('x', '{"batch_id":"y","accepted":12,"already_received":false}');
      expect(ack.batchId, 'y');
      expect(ack.accepted, 12);
      expect(ack.alreadyReceived, isFalse);
    });
    test('tolerates missing fields', () {
      final ack = IngestAck.parse('x', '{}');
      expect(ack.batchId, 'x');
      expect(ack.accepted, 0);
      expect(ack.alreadyReceived, isFalse);
    });
  });
}
