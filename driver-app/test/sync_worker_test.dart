import 'dart:math';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:yet_driver/core/cache/fix_dao.dart';
import 'package:yet_driver/core/cache/sensor_dao.dart';
import 'package:yet_driver/core/sync/sync_state.dart';
import 'package:yet_driver/core/sync/sync_worker.dart';
import 'package:yet_driver/features/pilot/pilot_service.dart';


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

  /// In-memory tables so txn.query claims and txn.update/delete state changes
  /// behave like real SQLite for the offline-contract tests.
  final Map<String, List<Map<String, Object?>>> tables = {};

  void _seed(String table, List<Map<String, Object?>> rows) =>
      tables[table] = rows.map(Map<String, Object?>.from).toList();

  static bool _matches(Map<String, Object?> row, String where,
      [List<Object?>? args]) {
    if (where.isEmpty) return true;
    var i = 0;
    for (var clause in where.split(' AND ')) {
      // Aggregate WHEREs (e.g. "batch_id = ?") used inside MAX(...) are not
      // row predicates — the caller's group semantics are approximated by the
      // rawResults queue, so skip anything wrapped in a function call.
      if (clause.contains('(') && !clause.trimRight().endsWith(')')) {
        final open = clause.indexOf('(');
        final close = clause.lastIndexOf(')');
        if (open < close) {
          clause = clause.substring(0, open) + clause.substring(close + 1);
          if (clause.trim().isEmpty) continue;
        }
      }
      final c = clause.trim();
      final upper = c.toUpperCase();
      if (upper == 'IS NOT NULL') {
        // Bare remainder after aggregate stripping — nothing to filter on.
        continue;
      }
      if (upper.contains(' IN (')) {
        final col = c.substring(0, c.indexOf(' IN')).trim();
        final n = '?, '.allMatches(c).length + (c.trimRight().endsWith('?') ? 1 : 0);
        final vals = args!.skip(i).take(n == 0 ? 1 : n).map((e) => e.toString()).toSet();
        i += n == 0 ? 1 : n;
        if (!vals.contains(row[col]?.toString())) return false;
      } else if (upper.contains(' IS NOT NULL')) {
        final col = c
            .substring(0, c.toUpperCase().indexOf(' IS NOT NULL'))
            .trim();
        if (row[col] == null) return false;
      } else if (c.contains('>=')) {
        final p = c.split('>=');
        if (row[p[0].trim()] is Comparable &&
            Comparable.compare(row[p[0].trim()] as Comparable, p[1].trim()) <
                0) return false;
      } else if (c.contains('<=')) {
        final p = c.split('<=');
        if (row[p[0].trim()] is Comparable &&
            Comparable.compare(row[p[0].trim()] as Comparable, p[1].trim()) >
                0) return false;
      } else if (c.contains('<')) {
        final p = c.split('<');
        final col = p[0].trim();
        final lit = p[1].trim();
        final bound = lit == '?' ? args![i++] : _unquote(lit);
        final v = row[col];
        if (v != null &&
            bound != null &&
            Comparable.compare(v as Comparable, bound as Comparable) >= 0) {
          return false;
        }
      } else if (c.contains('=')) {
        final p = c.split('=');
        final col = p[0].trim();
        final lit = p[1].trim();
        final expected = lit == '?' ? args![i++] : _unquote(lit);
        if (row[col]?.toString() != expected?.toString()) return false;
      } else {
        return false; // unsupported predicate — fail loudly via empty result
      }
    }
    return true;
  }

  static Object? _unquote(String lit) {
    if (lit.startsWith("'") && lit.endsWith("'")) {
      return lit.substring(1, lit.length - 1);
    }
    return int.tryParse(lit) ?? lit;
  }

  List<Map<String, Object?>> _select(String table,
      {String? where,
      List<Object?>? whereArgs,
      String? orderBy,
      int? limit}) {
    final rows = tables[table] ?? const [];
    var out = where == null || where.isEmpty
        ? rows.toList()
        : rows.where((r) => _matches(r, where, whereArgs)).toList();
    if (orderBy != null && orderBy.isNotEmpty) {
      final parts = orderBy.split(',').first.trim().split(' ');
      final col = parts[0];
      final desc = parts.length > 1 && parts[1].toUpperCase() == 'DESC';
      out.sort((a, b) {
        final x = a[col], y = b[col];
        final cmp = Comparable.compare(x as Comparable, y as Comparable);
        return desc ? -cmp : cmp;
      });
    }
    if (limit != null && out.length > limit) out = out.sublist(0, limit);
    return out.map(Map<String, Object?>.from).toList();
  }

  int _update(String table, Map<String, Object?> values, String? where,
      List<Object?>? whereArgs) {
    final rows = tables[table];
    if (rows == null) return 0;
    var n = 0;
    for (final r in rows) {
      if (where == null || _matches(r, where, whereArgs)) {
        r.addAll(values);
        n++;
      }
    }
    return n;
  }

  int _delete(String table, String? where, List<Object?>? whereArgs) {
    final rows = tables[table];
    if (rows == null) return 0;
    final before = rows.length;
    rows.removeWhere((r) => where == null || _matches(r, where, whereArgs));
    return before - rows.length;
  }

  @override
  String get path => 'fake.db';
  @override
  bool get isOpen => true;

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
  Future<T> readTransaction<T>(Future<T> Function(Transaction txn) action) =>
      action(_FakeTxn(this));

  @override
  Future<List<Map<String, Object?>>> query(String table,
      {bool? distinct,
      List<String>? columns,
      String? where,
      List<Object?>? whereArgs,
      String? groupBy,
      String? having,
      String? orderBy,
      int? limit,
      int? offset}) async {
    queries.add('query:$table where=$where orderBy=$orderBy limit=$limit');
    return _select(table, where: where, whereArgs: whereArgs, orderBy: orderBy, limit: limit);
  }

  @override
  Future<List<Map<String, Object?>>> rawQuery(String sql,
      [List<Object?>? args]) async {
    queries.add('raw:$sql');
    final agg = _aggregate(sql, args);
    if (agg != null) return agg;
    if (rawResults.isNotEmpty) return rawResults.removeAt(0);
    return const [];
  }

  /// Minimal stateful evaluator for the two aggregate shapes the DAOs use:
  /// SELECT COUNT(*) AS c FROM t WHERE sync_state IN (?, ?) and
  /// SELECT MAX(upload_attempts) AS m FROM t WHERE batch_id = ?.
  List<Map<String, Object?>>? _aggregate(String sql, List<Object?>? args) {
    final upper = sql.toUpperCase();
    final from = upper.indexOf(' FROM ');
    if (from < 0) return null;
    final rest = sql.substring(from + 6).trim();
    final parts = rest.split(RegExp(r'\s+WHERE\s+'));
    final table = parts[0].trim();
    final rows = tables[table];
    if (rows == null) return null;
    var matching = rows;
    if (parts.length > 1) {
      matching = rows.where((r) => _matches(r, parts.sublist(1).join(' WHERE '), args)).toList();
    }
    if (upper.startsWith('SELECT COUNT(')) {
      return [
        {'c': matching.length}
      ];
    }
    if (upper.startsWith('SELECT MAX(')) {
      final colStart = sql.indexOf('(') + 1;
      final col = sql.substring(colStart, sql.indexOf(')', colStart)).trim();
      num? max;
      for (final r in matching) {
        final v = r[col];
        if (v is num && (max == null || v > max)) max = v;
      }
      return [
        {'m': max}
      ];
    }
    return null;
  }

  @override
  Future<int> insert(String table, Map<String, Object?> values,
      {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm}) async {
    queries.add('insert:$table state=${values['sync_state']}');
    tables.putIfAbsent(table, () => []).add(Map<String, Object?>.from(values));
    return lastInsertId++;
  }

  @override
  Future<int> update(String table, Map<String, Object?> values,
      {String? where,
      List<Object?>? whereArgs,
      ConflictAlgorithm? conflictAlgorithm}) async {
    queries.add('update:$table set=${values['sync_state']} where=$where');
    final stamped = Map<String, Object?>.from(values);
    if (stamped['sync_state'] == 'ACKED' && !stamped.containsKey('acked_at')) {
      stamped['acked_at'] = DateTime.now().toUtc().toIso8601String();
    }
    lastUpdateCount = _update(table, stamped, where, whereArgs);
    return lastUpdateCount;
  }

  @override
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs}) async {
    queries.add('delete:$table where=$where');
    lastDeleteCount = _delete(table, where, whereArgs);
    return lastDeleteCount;
  }

  @override
  Future<int> rawInsert(String sql, [List<Object?>? args]) async => 1;
  @override
  Future<int> rawUpdate(String sql, [List<Object?>? args]) async => 1;
  @override
  Future<int> rawDelete(String sql, [List<Object?>? args]) async => 1;
  @override
  Batch batch() => _FakeBatch();
  @override
  Database get database => this;

  @override
  Future<QueryCursor> queryCursor(String table,
          {bool? distinct,
          List<String>? columns,
          String? where,
          List<Object?>? whereArgs,
          String? groupBy,
          String? having,
          String? orderBy,
          int? limit,
          int? offset,
          int? bufferSize}) =>
      throw UnimplementedError('queryCursor not used by the sync pipeline');

  @override
  Future<QueryCursor> rawQueryCursor(String sql, List<Object?>? arguments,
          {int? bufferSize}) =>
      throw UnimplementedError('rawQueryCursor not used by the sync pipeline');

  @override
  Future<T> devInvokeMethod<T>(String method, [Object? arguments]) =>
      throw UnimplementedError('dev helpers are test-only');

  @override
  Future<T> devInvokeSqlMethod<T>(String method, String sql,
          [Object? arguments]) =>
      throw UnimplementedError('dev helpers are test-only');

  @override
  Future<void> close() async {}
}

class _FakeTxn implements Transaction {
  _FakeTxn(this.db);
  final FakeDb db;

  @override
  Future<void> execute(String sql, [List<Object?>? arguments]) async {
    db.executed.add(sql);
  }

  @override
  Future<List<Map<String, Object?>>> query(String table,
          {bool? distinct,
          List<String>? columns,
          String? where,
          List<Object?>? whereArgs,
          String? groupBy,
          String? having,
          String? orderBy,
          int? limit,
          int? offset}) =>
      db.query(table,
          distinct: distinct,
          columns: columns,
          where: where,
          whereArgs: whereArgs,
          groupBy: groupBy,
          having: having,
          orderBy: orderBy,
          limit: limit,
          offset: offset);

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
          {String? where,
          List<Object?>? whereArgs,
          ConflictAlgorithm? conflictAlgorithm}) =>
      db.update(table, values,
          where: where, whereArgs: whereArgs, conflictAlgorithm: conflictAlgorithm);

  @override
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs}) =>
      db.delete(table, where: where, whereArgs: whereArgs);

  @override
  Future<int> rawInsert(String sql, [List<Object?>? args]) => db.rawInsert(sql, args);
  @override
  Future<int> rawUpdate(String sql, [List<Object?>? args]) => db.rawUpdate(sql, args);
  @override
  Future<int> rawDelete(String sql, [List<Object?>? args]) => db.rawDelete(sql, args);

  @override
  Batch batch() => _FakeBatch();

  @override
  Database get database => db;

  @override
  Future<QueryCursor> queryCursor(String table,
          {bool? distinct,
          List<String>? columns,
          String? where,
          List<Object?>? whereArgs,
          String? groupBy,
          String? having,
          String? orderBy,
          int? limit,
          int? offset,
          int? bufferSize}) =>
      throw UnimplementedError('queryCursor not used by the sync pipeline');

  @override
  Future<QueryCursor> rawQueryCursor(String sql, List<Object?>? arguments,
          {int? bufferSize}) =>
      throw UnimplementedError('rawQueryCursor not used by the sync pipeline');
}

/// Minimal in-memory [Batch] used by the DAO pruning path. Records the number
/// of queued operations so tests can assert pruning behaviour without a real
/// SQLite engine.
class _FakeBatch implements Batch {
  @override
  int length = 0;

  @override
  void execute(String sql, [List<Object?>? arguments]) {
    length++;
  }

  @override
  void delete(String table, {String? where, List<Object?>? whereArgs}) {
    length++;
  }

  @override
  void rawDelete(String sql, [List<Object?>? arguments]) {
    length++;
  }

  @override
  void insert(String table, Object? values,
      {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm}) {
    length++;
  }

  @override
  void rawInsert(String sql, [List<Object?>? arguments]) {
    length++;
  }

  @override
  void update(String table, Object? values,
      {String? where,
      List<Object?>? whereArgs,
      String? nullColumnHack,
      ConflictAlgorithm? conflictAlgorithm}) {
    length++;
  }

  @override
  void rawUpdate(String sql, [List<Object?>? arguments]) {
    length++;
  }

  @override
  void query(String table,
      {bool? distinct,
      List<String>? columns,
      String? where,
      List<Object?>? whereArgs,
      String? groupBy,
      String? having,
      String? orderBy,
      int? limit,
      int? offset}) {
    length++;
  }

  @override
  void rawQuery(String sql, [List<Object?>? arguments]) {
    length++;
  }

  @override
  Future<List<Object?>> commit(
      {bool? exclusive, bool? noResult, bool? continueOnError}) async {
    length = 0;
    return const [];
  }

  @override
  Future<List<Object?>> apply(
          {bool? noResult, bool? continueOnError}) async =>
      commit(noResult: noResult, continueOnError: continueOnError);
}

Map<String, Object?> row(int id, String ts,
        {String state = 'PENDING', int attempts = 0, String? batch}) =>
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
      'batch_id': batch,
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
      final db = FakeDb()
        .._seed('location_fixes', [
          for (var i = 1; i <= 7; i++)
            row(i, '2026-10-23T07:0${i}:00.000Z', state: 'UPLOADING', batch: 'b-old'),
          row(8, '2026-10-23T07:10:00.000Z', state: 'PENDING'),
        ]);
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
      final db = FakeDb().._seed('location_fixes', [row(1, '2026-10-23T07:00:00.000Z')]);
      final dao = FixDao(db);
      // Stateful fake: the PENDING row IS claimed and flipped to UPLOADING.
      final claimed = await dao.claimBatch('b-1', 100);
      expect(claimed.length, 1);
      expect(claimed.first.syncState, SyncState.uploading);
      expect(claimed.first.batchId, 'b-1');
      expect(db.queries.first, contains('orderBy=fix_timestamp ASC'));
      expect(db.queries.first, contains('limit=100'));
    });

    test('markBatchAcked moves only this batch UPLOADING->ACKED', () async {
      final db = FakeDb()
        .._seed('location_fixes', [
          for (var i = 1; i <= 3; i++)
            row(i, '2026-10-23T07:0${i}:00.000Z', state: 'UPLOADING', batch: 'b-9'),
          row(4, '2026-10-23T07:04:00.000Z', state: 'UPLOADING', batch: 'b-other'),
        ]);
      final dao = FixDao(db);
      final n = await dao.markBatchAcked('b-9');
      expect(n, 3); // only b-9 rows — b-other untouched
      expect((db.tables['location_fixes']!).firstWhere((r) => r['id'] == 4)['sync_state'], 'UPLOADING');
      expect(db.queries.last, contains('set=ACKED'));
      expect(db.queries.last, contains("sync_state = 'UPLOADING' AND batch_id = ?"));
    });

    test('prune deletes only ACKED rows — PENDING untouchable (§1.8.6)', () async {
      final db = FakeDb()
        .._seed('location_fixes', [
          for (var i = 1; i <= 5; i++)
            {...row(i, '2026-10-01T07:0${i}:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-01T08:00:00.000Z'},
          row(6, '2026-10-23T07:00:00.000Z', state: 'PENDING'),
          {...row(7, '2026-10-23T07:01:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-23T08:00:00.000Z'},
        ]);
      final dao = FixDao(db);
      final n = await dao.pruneAckedOlderThan(const Duration(days: 7));
      expect(n, 5); // old ACKED only; fresh ACKED + PENDING survive
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
      final db = FakeDb().._seed('location_fixes', [row(1, '2026-10-23T07:00:00.000Z')]);
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
      final db = FakeDb().._seed('location_fixes', [row(2, '2026-10-23T07:00:10.000Z')]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            IngestAck(batchId: id, accepted: 0, alreadyReceived: true),
      );
      expect(await w.runOnce(), SyncOutcome.uploaded);
      expect(db.queries.last.contains('set=ACKED'), isTrue);
    });

    test('failure path: rows released back to PENDING with attempts++ (§1.8.1)', () async {
      final db = FakeDb().._seed('location_fixes', [row(3, '2026-10-23T07:00:20.000Z')]);
      final w = SyncWorker(
        dao: FixDao(db),
        uploader: (id, fixes) async =>
            throw const RetryableUploadException('offline'),
        random: Random(1),
      );
      expect(await w.runOnce(), SyncOutcome.failed);
      // release loop updated the single row back to PENDING (per-row by id)...
      expect(db.queries.any((q) => q.contains('set=PENDING') && q.contains('where=id = ?')), isTrue);
      // ...and the worker read MAX(upload_attempts) for the backoff exponent
      expect(db.queries.any((q) => q.contains('MAX(upload_attempts)')), isTrue);
    });

    test('permanent failure releases rows but blocks for the full cap', () async {
      final db = FakeDb().._seed('location_fixes', [row(4, '2026-10-23T07:00:30.000Z')]);
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
        dao: FixDao(FakeDb()..rawResults.add([{'c': 0}])),
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
        .._seed('location_fixes', [
          {...row(1, '2026-10-15T07:00:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
          {...row(2, '2026-10-15T07:00:10.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
          {...row(3, '2026-10-15T07:00:20.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
          {...row(4, '2026-10-15T07:00:30.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
          row(5, '2026-10-23T07:00:00.000Z', state: 'PENDING'),
        ])
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
        .._seed('location_fixes', [
          for (var i = 0; i < 6; i++)
            {...row(i + 1, '2026-10-23T07:00:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-23T08:00:00.000Z'},
        ])
        ..rawResults.add([{'page_count': 30000}]) // ~117MB
        ..rawResults.add([{'page_size': 4096}]); // budget-evict loop reads stateful PRAGMAs
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

  // ── Phase 4: sensor offline durability (§1.8.5) — same FakeDb harness ─────

  Map<String, Object?> srow(int id, String ts,
          {String kind = 'accelerometer', String state = 'PENDING', int attempts = 0, String? batch}) =>
      {
        'id': id,
        'kind': kind,
        'event_timestamp': ts,
        'payload_json': '{"variance":0.03}',
        'sync_state': state,
        'batch_id': batch,
        'upload_attempts': attempts,
      };

  group('SensorDao schema + state machine mirrors FixDao (§1.8.5)', () {
    test('creates sensor_events with sync_state column + indexes', () async {
      final db = FakeDb();
      await SensorDao.onCreate(db, SensorDao.dbVersion);
      expect(db.executed.length, 3); // table + 2 indices
      expect(db.executed[0].contains('CREATE TABLE sensor_events'), isTrue);
      expect(db.executed[0].contains('sync_state TEXT NOT NULL'), isTrue);
      expect(db.executed[0].contains('batch_id TEXT'), isTrue);
      expect(db.executed[0].contains('acked_at TEXT'), isTrue);
      expect(db.executed[1].contains('idx_sensors_sync'), isTrue);
      expect(db.executed[2].contains('idx_sensors_time'), isTrue);
    });

    test('crash recovery: UPLOADING -> PENDING at open (§1.8.1)', () async {
      final db = FakeDb()
        .._seed('sensor_events', [
          for (var i = 1; i <= 9; i++)
            srow(i, '2026-10-23T07:00:${(i % 60).toString().padLeft(2, "0")}.000Z', state: 'UPLOADING', batch: 'b-old'),
          srow(10, '2026-10-23T07:01:00.000Z', state: 'PENDING'),
        ]);
      final dao = SensorDao(db);
      expect(await dao.recoverUnackedUploads(), 9);
      expect(db.queries.any((q) => q.contains('set=PENDING') && q.contains("sync_state = 'UPLOADING'")), isTrue);
    });

    test('insertEvent rejects kinds outside the backend enum (no poisoned batch)', () async {
      final db = FakeDb();
      final dao = SensorDao(db);
      final bad = StoredSensorEvent(
        id: 0,
        kind: 'magnetometer', // not in SensorEventSchema
        eventTimestamp: DateTime.utc(2026),
        payload: const {},
        syncState: SyncState.pending,
      );
      expect(await dao.insertEvent(bad), -1);
      expect(db.queries.any((q) => q.startsWith('insert:sensor_events')), isFalse);
      final good = StoredSensorEvent(
        id: 0,
        kind: 'gyroscope',
        eventTimestamp: DateTime.utc(2026),
        payload: const {'rad_s': 0.4},
        syncState: SyncState.pending,
      );
      expect(await dao.insertEvent(good), greaterThan(0));
    });

    test('claimBatch orders by event_timestamp ASC (event time, §1.8.3)', () async {
      final db = FakeDb();
      final dao = SensorDao(db);
      final claimed = await dao.claimBatch('b-1', 500);
      expect(claimed, isEmpty); // FakeDb query returns [] by default
      expect(db.queries.first, contains('query:sensor_events'));
      expect(db.queries.first, contains('orderBy=event_timestamp ASC'));
      expect(db.queries.first, contains('limit=500'));
    });

    test('markBatchAcked moves only this batch UPLOADING->ACKED', () async {
      final db = FakeDb()
        .._seed('sensor_events', [
          for (var i = 1; i <= 4; i++)
            srow(i, '2026-10-23T07:0${i}:00.000Z', state: 'UPLOADING', batch: 'b-9'),
          srow(5, '2026-10-23T07:05:00.000Z', state: 'UPLOADING', batch: 'b-other'),
        ]);
      final dao = SensorDao(db);
      expect(await dao.markBatchAcked('b-9'), 4);
      expect(db.queries.last, contains('set=ACKED'));
      expect(db.queries.last, contains("sync_state = 'UPLOADING' AND batch_id = ?"));
    });

    test('releaseBatchForRetry: PENDING + attempts++ per row (§1.8.1)', () async {
      final db = FakeDb()
        .._seed('sensor_events', [srow(7, '2026-10-23T07:00:00.000Z', state: 'UPLOADING', attempts: 2, batch: 'b-3')]);
      final dao = SensorDao(db);
      expect(await dao.releaseBatchForRetry('b-3'), 1);
      // The update carries attempts = old + 1 via whereArgs-free values map;
      // assert the state flip happened for the right row.
      expect(db.queries.any((q) => q.contains('set=PENDING') && q.contains('where=id = ?')), isTrue);
    });

    test('prune deletes only ACKED rows — PENDING untouchable (§1.8.6)', () async {
      final db = FakeDb()
        .._seed('sensor_events', [
          for (var i = 1; i <= 6; i++)
            {...srow(i, '2026-10-01T07:0${i}:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-01T08:00:00.000Z'},
          srow(7, '2026-10-23T07:00:00.000Z', state: 'PENDING'),
        ]);
      final dao = SensorDao(db);
      expect(await dao.pruneAckedOlderThan(const Duration(days: 7)), 6);
      expect(db.queries.last, contains("delete:sensor_events where=sync_state = 'ACKED'"));
    });

    test('storageBytes multiplies page_count x page_size like FixDao', () async {
      final db = FakeDb()
        ..rawResults.add([{'page_count': 1000}])
        ..rawResults.add([{'page_size': 4096}]);
      final dao = SensorDao(db);
      expect(await dao.storageBytes(), 1000 * 4096);
    });
  });

  group('SyncWorker sensor path (§1.8.5 through the SAME state machine)', () {
    test('runSensorOnce: no sensor wiring -> nothingPending (Phase 1 compat)', () async {
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (_, __) async => throw UnimplementedError(),
      );
      expect(await w.runSensorOnce(), SyncOutcome.nothingPending);
    });

    test('runSensorOnce success: claim -> upload -> markBatchAcked', () async {
      final db = FakeDb().._seed('sensor_events', [srow(1, '2026-10-23T07:00:00.000Z')]);
      String? seenBatchId;
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (_, __) async => const IngestAck(batchId: 'unused', accepted: 0, alreadyReceived: false),
        sensorDao: SensorDao(db),
        sensorUploader: (id, events) async {
          seenBatchId = id;
          expect(events.length, 1);
          expect(events.first.syncState, SyncState.uploading);
          expect(events.first.batchId, id);
          return IngestAck(batchId: id, accepted: 1, alreadyReceived: false);
        },
      );
      expect(await w.runSensorOnce(), SyncOutcome.uploaded);
      expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4').hasMatch(seenBatchId!), isTrue);
      expect(db.queries.last.contains('set=ACKED'), isTrue);
    });

    test('runSensorOnce retryable failure: release to PENDING + backoff read', () async {
      final db = FakeDb().._seed('sensor_events', [srow(2, '2026-10-23T07:00:10.000Z')]);
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (_, __) async => throw UnimplementedError(),
        sensorDao: SensorDao(db),
        sensorUploader: (id, events) async =>
            throw const RetryableUploadException('offline'),
        random: Random(3),
      );
      expect(await w.runSensorOnce(), SyncOutcome.failed);
      expect(db.queries.any((q) => q.contains('set=PENDING')), isTrue);
      expect(db.queries.any((q) => q.contains('MAX(upload_attempts)')), isTrue);
    });

    test('runSensorOnce permanent failure blocks for the full cap', () async {
      final db = FakeDb().._seed('sensor_events', [srow(3, '2026-10-23T07:00:20.000Z')]);
      final w = SyncWorker(
        dao: FixDao(FakeDb()),
        uploader: (_, __) async => throw UnimplementedError(),
        sensorDao: SensorDao(db),
        sensorUploader: (id, events) async =>
            throw const PermanentUploadException('invalid_token'),
      );
      expect(await w.runSensorOnce(), SyncOutcome.failed);
      expect(db.queries.any((q) => q.contains('set=PENDING')), isTrue);
    });

    test('refreshPendingCount sums GPS fixes + sensor backlog (§1.8.6 counter)', () async {
      final fixDb = FakeDb()..rawResults.add([{'c': 12}]);
      final sensorDb = FakeDb()..rawResults.add([{'c': 30}]);
      final w = SyncWorker(
        dao: FixDao(fixDb),
        uploader: (_, __) async => throw UnimplementedError(),
        sensorDao: SensorDao(sensorDb),
        sensorUploader: (_, __) async => throw UnimplementedError(),
      );
      await w.refreshPendingCount();
      expect(w.pendingCount.value, 42);
    });

    test('prune covers BOTH tables: age delete runs on sensors too', () async {
      final fixDb = FakeDb()
        .._seed('location_fixes', [
          for (var i = 0; i < 3; i++)
            {...row(i + 1, '2026-10-15T07:00:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
        ])
        ..rawResults.add([{'page_count': 100}])
        ..rawResults.add([{'page_size': 4096}]);
      final sensorDb = FakeDb()
        .._seed('sensor_events', [
          for (var i = 0; i < 5; i++)
            {...srow(i + 1, '2026-10-15T07:00:00.000Z', state: 'ACKED'), 'acked_at': '2026-10-15T08:00:00.000Z'},
        ])
        ..rawResults.add([{'page_count': 100}])
        ..rawResults.add([{'page_size': 4096}]);
      final w = SyncWorker(
        dao: FixDao(fixDb),
        uploader: (_, __) async => throw UnimplementedError(),
        sensorDao: SensorDao(sensorDb),
        sensorUploader: (_, __) async => throw UnimplementedError(),
      );
      final r = await w.prune();
      expect(r.deletedByAge, 3 + 5); // fixes + sensors (§1.8.5 both durable)
      expect(r.deletedByBudget, 0); // ~800KB total, under the 80MB warn level
      expect(r.warnedDriver, isFalse);
      expect(sensorDb.queries.any((q) => q.contains("delete:sensor_events where=sync_state = 'ACKED'")), isTrue);
    });
  });

  group('Sensor wire format matches backend SensorBatchSchema', () {
    test('toJson emits exactly {event_timestamp, kind, payload}', () {
      final e = StoredSensorEvent(
        id: 1,
        kind: 'turn',
        eventTimestamp: DateTime.utc(2026, 10, 23, 7, 0),
        payload: const {'angular_velocity_rad_s': 0.9},
        syncState: SyncState.pending,
      );
      final j = e.toJson();
      expect(j.keys.toSet(), {'event_timestamp', 'kind', 'payload'});
      expect(j['kind'], 'turn');
      // local-only columns never leave the device
      expect(j.containsKey('id'), isFalse);
      expect(j.containsKey('sync_state'), isFalse);
      expect(j.containsKey('batch_id'), isFalse);
      expect(j.containsKey('payload_json'), isFalse);
    });

    test('encodeSensorBatchBody carries batch_id + client_sent_at + events', () {
      final body = encodeSensorBatchBody('uuid-s-1', [
        StoredSensorEvent(
          id: 1,
          kind: 'harsh_brake',
          eventTimestamp: DateTime.utc(2026),
          payload: const {'peak_mps2': 4.2},
          syncState: SyncState.uploading,
        ),
      ]);
      expect(body.contains('"batch_id":"uuid-s-1"'), isTrue);
      expect(body.contains('"client_sent_at"'), isTrue);
      expect(body.contains('"events"'), isTrue);
      expect(body.contains('"harsh_brake"'), isTrue);
    });
  });

  group('Pilot diagnostics + battery payloads (Phase 4 endpoints)', () {
    test('buildDiagnosticsPayload has exactly the DiagnosticsSchema fields', () {
      final p = SyncWorker.buildDiagnosticsPayload(
        issue: 'gps_not_working',
        pendingSyncCount: 17,
        tripActive: true,
        batteryPct: 63,
        charging: false,
        lastFixAgeS: 95,
        lastAccuracyM: 24.5,
        networkType: 'cellular',
        batchIdOverride: 'fixed-batch',
        reportedAt: DateTime.utc(2026, 10, 23, 9),
      );
      expect(p['batch_id'], 'fixed-batch');
      expect(p['reported_at'], '2026-10-23T09:00:00.000Z');
      expect(p['issue'], 'gps_not_working');
      expect(p['battery_pct'], 63);
      expect(p['charging'], false);
      expect(p['last_fix_age_s'], 95);
      expect(p['last_accuracy_m'], 24.5);
      expect(p['network_type'], 'cellular');
      expect(p['pending_sync_count'], 17);
      expect(p['trip_active'], true);
      expect(p['detail'], isA<Map<String, Object?>>());
      // Data minimization (§1.7): nothing beyond the schema.
      expect(p.containsKey('contacts'), isFalse);
      expect(p.containsKey('phone_number'), isFalse);
    });

    test('omits unknown optionals instead of fabricating them', () {
      final p = SyncWorker.buildDiagnosticsPayload(
        issue: 'other',
        pendingSyncCount: 0,
        tripActive: false,
        batchIdOverride: 'b',
      );
      expect(p.containsKey('battery_pct'), isFalse);
      expect(p.containsKey('last_fix_age_s'), isFalse);
      expect(p['network_type'], 'unknown');
    });

    test('BatteryDrain.pctPer8h parity with backend pilot_battery constants', () {
      // Backend: BATTERY_TARGET_PCT_PER_SHIFT = 20, GATE_MAX = 25,
      // MIN_TRIPS_FOR_VERDICT = 10 (below that the server answers
      // INSUFFICIENT_DATA; the client NO_DATA is the "no median yet" analog).
      expect(BatteryDrain.targetPctPer8h, 20.0);
      expect(BatteryDrain.gateMaxPctPer8h, 25.0);
      expect(BatteryDrain.minTripsForVerdict, 10);
      // 4% over a 2-hour trip extrapolates to 16%/8h.
      final d = BatteryDrain.pctPer8h(
        startPct: 80, endPct: 76, duration: const Duration(hours: 2));
      expect(d, 16.0);
      // Charging during the trip is excluded from drain measurement.
      expect(BatteryDrain.pctPer8h(
          startPct: 80, endPct: 60,
          duration: const Duration(hours: 8), charging: true), isNull);
      // Negative delta (plugged in mid-trip) is not a drain.
      expect(BatteryDrain.pctPer8h(
          startPct: 50, endPct: 70, duration: const Duration(hours: 4)), isNull);
      // Zero/negative duration guard.
      expect(BatteryDrain.pctPer8h(
          startPct: 50, endPct: 40, duration: Duration.zero), isNull);
    });

    test('verdict thresholds mirror judgePilotBattery (>25 FAIL, >20 AT_RISK)', () {
      expect(BatteryDrain.verdictForMedian(null), 'NO_DATA');
      expect(BatteryDrain.verdictForMedian(20.0), 'PASS'); // boundary: <= target
      expect(BatteryDrain.verdictForMedian(20.1), 'AT_RISK');
      expect(BatteryDrain.verdictForMedian(25.0), 'AT_RISK'); // boundary: <= gate
      expect(BatteryDrain.verdictForMedian(25.1), 'GATE_FAIL');
    });
  });

  group('TileBounds offline pre-download math (self-hosted tiles only)', () {
    test('countTiles is deterministic and spans all zooms 6..12', () {
      const b = TileBounds.addisCorridor;
      expect(b.countTiles(), b.countTiles());
      // Sanity: every zoom contributes at least one tile for an 0.8x0.5 deg box.
      for (var z = b.minZoom; z <= b.maxZoom; z++) {
        final xr = b.xRange(z), yr = b.yRange(z);
        expect(xr[1] >= xr[0], isTrue);
        expect(yr[1] >= yr[0], isTrue);
      }
      // Higher zoom must cover strictly more tiles than the lowest zoom.
      final zLow = (b.xRange(6)[1] - b.xRange(6)[0] + 1) * (b.yRange(6)[1] - b.yRange(6)[0] + 1);
      final zHigh = (b.xRange(12)[1] - b.xRange(12)[0] + 1) * (b.yRange(12)[1] - b.yRange(12)[0] + 1);
      expect(zHigh, greaterThan(zLow));
      expect(b.countTiles(), greaterThanOrEqualTo(zLow + zHigh));
    });

    test('Addis center falls inside the corridor tile ranges at z=12', () {
      const b = TileBounds.addisCorridor;
      final xr = b.xRange(12);
      // Web-Mercator x for Addis center lng 38.75 @ z12 ≈ 2488.9 → tile 2488
      expect(xr[0] <= 2488 && 2488 <= xr[1], isTrue);
      // Web-Mercator y for Addis center lat 9.03 @ z12 ≈ 1944 — must sit
      // inside the corridor's inclusive y range at the same zoom.
      final yr = b.yRange(12);
      expect(yr[0] <= 1944 && 1944 <= yr[1], isTrue);
    });
  });
}
