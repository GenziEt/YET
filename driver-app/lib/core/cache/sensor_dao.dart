import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../sync/sync_state.dart';

/// One stored sensor record in the offline cache (Offline Contract §1.8.5).
///
/// Mirrors [StoredFix] exactly — same table pattern, same sync_state machine —
/// but serializes into the backend `POST /ingest/sensors` envelope
/// (`SensorEventSchema` in `backend/src/modules/ingest/service.ts`):
///   { event_timestamp, kind, payload }
/// Kinds are the frozen enum from that schema; anything else is rejected at
/// insert time so a bad producer can never poison an upload batch.
class StoredSensorEvent {
  StoredSensorEvent({
    required this.id,
    required this.kind,
    required this.eventTimestamp,
    required this.payload,
    required this.syncState,
    this.batchId,
    this.uploadAttempts = 0,
  });

  final int id; // local auto-increment — never leaves the device
  final String kind;
  /// EVENT time from the device clock (§1.8.3) — Trip Engine orders on this.
  final DateTime eventTimestamp;
  final Map<String, Object?> payload;

  SyncState syncState;
  String? batchId;
  int uploadAttempts;

  /// Sensor kinds accepted by POST /ingest/sensors (backend SensorEventSchema).
  static const allowedKinds = <String>{
    'accelerometer',
    'gyroscope',
    'harsh_brake',
    'harsh_accel',
    'turn',
    'vibration_gate',
    'audio_engine',
  };

  Map<String, Object?> toDbRow() => {
        'id': id,
        'kind': kind,
        'event_timestamp': eventTimestamp.toUtc().toIso8601String(),
        'payload_json': jsonEncode(payload),
        'sync_state': SyncStateCodec.name(syncState),
        'batch_id': batchId,
        'upload_attempts': uploadAttempts,
      };

  factory StoredSensorEvent.fromDbRow(Map<String, Object?> r) {
    final raw = r['payload_json'] as String? ?? '{}';
    Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } catch (_) {
      decoded = const <String, Object?>{};
    }
    return StoredSensorEvent(
      id: r['id'] as int,
      kind: r['kind'] as String,
      eventTimestamp: DateTime.parse(r['event_timestamp'] as String),
      payload: decoded is Map<String, Object?> ? decoded : const {},
      syncState: SyncStateCodec.fromName(r['sync_state'] as String),
      batchId: r['batch_id'] as String?,
      uploadAttempts: (r['upload_attempts'] as int?) ?? 0,
    );
  }

  /// Wire format accepted by POST /ingest/sensors (SensorEventSchema).
  Map<String, Object?> toJson() => {
        'event_timestamp': eventTimestamp.toUtc().toIso8601String(),
        'kind': kind,
        'payload': payload,
      };
}

/// Local SQLite cache for sensor events — Phase 4 deliverable (§1.8.5:
/// "Accelerometer/gyroscope events are written to the same SQLite cache with
/// the same sync state machine as GPS fixes").
///
/// Hard rules enforced here (identical to FixDao):
///  * rows are NEVER deleted before ACKED (no data loss);
///  * UPLOADING rows that were never ACKed return to PENDING on open
///    (process-death recovery, §1.8.1);
///  * pruning happens only via [pruneAckedOlderThan] / [pruneToStorageBudget].
///    §1.8.6: when storage is critically constrained sensor events MAY be
///    downsampled — but only ACKED ones are ever evicted, so "downsampled"
///    means "the server already has them"; pre-upload sensor rows are kept
///    until ACK like everything else.
class SensorDao {
  static const tableSensors = 'sensor_events';
  static const dbVersion = 1;

  final Database db;
  SensorDao(this.db);

  /// Schema. Same column shape as location_fixes (state machine parity) with a
  /// JSON payload instead of coordinates. Index on (sync_state, event_timestamp)
  /// keeps the uploader's claim query cheap on slow storage (§1.2).
  static Future<void> onCreate(Database db, int version) async {
    await db.execute('''
      CREATE TABLE $tableSensors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        event_timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        sync_state TEXT NOT NULL DEFAULT 'PENDING',
        batch_id TEXT,
        upload_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        acked_at TEXT
      )
    ''');
    await db.execute(
        'CREATE INDEX idx_sensors_sync ON $tableSensors (sync_state, event_timestamp)');
    await db.execute(
        'CREATE INDEX idx_sensors_time ON $tableSensors (event_timestamp)');
  }

  /// Open + crash recovery (§1.8.1). Call once at startup alongside FixDao.open.
  static Future<SensorDao> openAndRecover(String path) async {
    final db = await databaseFactory.openDatabase(
      path,
      version: dbVersion,
      onCreate: onCreate,
    );
    final dao = SensorDao(db);
    await dao.recoverUnackedUploads();
    return dao;
  }

  /// §1.8.1: UPLOADING rows that were never ACKed return to PENDING on restart.
  Future<int> recoverUnackedUploads() => db.update(
        tableSensors,
        {'sync_state': 'PENDING', 'batch_id': null},
        where: "sync_state = 'UPLOADING'",
      );

  /// Insert one sensor sample/event collected while driving. Returns the local
  /// row id, or -1 if [kind] is not in the backend enum (defensive: a bad
  /// producer must not create a row whose batch would be rejected with 400).
  Future<int> insertEvent(StoredSensorEvent e) {
    if (!StoredSensorEvent.allowedKinds.contains(e.kind)) return Future.value(-1);
    return db.insert(tableSensors, {
      ...e.toDbRow(),
      'created_at': DateTime.now().toUtc().toIso8601String(),
    });
  }

  Future<int> pendingCount() async {
    final rows = await db.rawQuery(
        'SELECT COUNT(*) AS c FROM $tableSensors WHERE sync_state IN (?, ?)',
        ['PENDING', 'UPLOADING']);
    return (rows.first['c'] as int?) ?? 0;
  }

  Future<int> totalRowCount() async {
    final rows = await db.rawQuery('SELECT COUNT(*) AS c FROM $tableSensors');
    return (rows.first['c'] as int?) ?? 0;
  }

  /// Approximate DB size on disk in bytes (§1.8.6 budget checks). Same PRAGMA
  /// approach as FixDao.storageBytes — both DAOs share ONE SQLite file, so the
  /// worker sums them for the whole-cache bound.
  Future<int> storageBytes() async {
    final pc = await db.rawQuery('PRAGMA page_count');
    final ps = await db.rawQuery('PRAGMA page_size');
    final pages = (pc.first.values.first as num?)?.toInt() ?? 0;
    final size = (ps.first.values.first as num?)?.toInt() ?? 0;
    return pages * size;
  }

  /// Claim up to [limit] oldest PENDING sensor events for one batch, stamping
  /// them with [batchId] and moving PENDING→UPLOADING atomically (contract
  /// rule 5 — same semantics as FixDao.claimBatch). Event-time ASC ordering
  /// keeps late-replay windows contiguous (§1.8.3).
  Future<List<StoredSensorEvent>> claimBatch(String batchId, int limit) =>
      db.transaction((txn) async {
        final rows = await txn.query(tableSensors,
            where: "sync_state = 'PENDING'",
            orderBy: 'event_timestamp ASC',
            limit: limit);
        final ids = rows.map((r) => r['id'] as int).toList();
        if (ids.isEmpty) return <StoredSensorEvent>[];
        final placeholders = List.generate(ids.length, (_) => '?').join(',');
        await txn.update(
          tableSensors,
          {'sync_state': 'UPLOADING', 'batch_id': batchId},
          where: 'id IN ($placeholders)',
          whereArgs: ids,
        );
        return rows
            .map((r) => StoredSensorEvent.fromDbRow(r))
            .map((e) => StoredSensorEvent(
                  id: e.id,
                  kind: e.kind,
                  eventTimestamp: e.eventTimestamp,
                  payload: e.payload,
                  syncState: SyncState.uploading,
                  batchId: batchId,
                  uploadAttempts: e.uploadAttempts,
                ))
            .toList();
      });

  /// Server ACK (HTTP 200 for this batch_id, incl. already_received §1.8.2):
  /// UPLOADING→ACKED, stamp acked_at.
  Future<int> markBatchAcked(String batchId) => db.update(
        tableSensors,
        {'sync_state': 'ACKED', 'acked_at': DateTime.now().toUtc().toIso8601String()},
        where: "sync_state = 'UPLOADING' AND batch_id = ?",
        whereArgs: [batchId],
      );

  /// HTTP failure: UPLOADING→PENDING for this batch, attempts++ (backoff
  /// exponent survives process death because it lives in SQLite, §1.8.1).
  Future<int> releaseBatchForRetry(String batchId) => db.transaction((txn) async {
        final rows = await txn.query(tableSensors,
            where: "sync_state = 'UPLOADING' AND batch_id = ?",
            whereArgs: [batchId]);
        var updated = 0;
        for (final r in rows) {
          final attempts = ((r['upload_attempts'] as int?) ?? 0) + 1;
          updated += await txn.update(
            tableSensors,
            {'sync_state': 'PENDING', 'upload_attempts': attempts},
            where: 'id = ?',
            whereArgs: [r['id']],
          );
        }
        return updated;
      });

  /// Highest upload_attempts among rows stamped with [batchId] (read AFTER
  /// release so backoff survives restarts).
  Future<int> maxAttemptsForBatch(String batchId) async {
    final rows = await db.rawQuery(
        'SELECT MAX(upload_attempts) AS m FROM $tableSensors WHERE batch_id = ?',
        [batchId]);
    return (rows.first['m'] as int?) ?? 0;
  }

  /// Prune policy part 1 (§1.8.1): ACKED older than [maxAge] → deleted.
  Future<int> pruneAckedOlderThan(Duration maxAge) => db.delete(
        tableSensors,
        where: "sync_state = 'ACKED' AND acked_at IS NOT NULL AND acked_at < ?",
        whereArgs: [
          DateTime.now().toUtc().subtract(maxAge).toIso8601String()
        ],
      );

  /// Prune policy part 2 (§1.8.6): evict OLDEST ACKED rows until the DB fits
  /// under [budgetBytes]. Safe because the server holds them; PENDING/UPLOADING
  /// rows are untouchable (no-data-loss rule).
  Future<int> pruneToStorageBudget(int budgetBytes) =>
      db.transaction((txn) async {
        var deleted = 0;
        while (true) {
          final pc = await txn.rawQuery('PRAGMA page_count');
          final ps = await txn.rawQuery('PRAGMA page_size');
          final bytes = ((pc.first.values.first as num?) ?? 0) *
              ((ps.first.values.first as num?) ?? 0);
          if (bytes <= budgetBytes) return deleted;
          final victim = await txn.query(tableSensors,
              where: "sync_state = 'ACKED'",
              orderBy: 'event_timestamp ASC',
              limit: 500);
          if (victim.isEmpty) return deleted; // nothing safe to evict
          final ids = victim.map((r) => r['id'] as int).toList();
          final placeholders = List.generate(ids.length, (_) => '?').join(',');
          deleted += await txn.delete(tableSensors,
              where: 'id IN ($placeholders)', whereArgs: ids);
        }
      });

  Future<void> close() => db.close();
}

/// JSON helpers shared with tests: encode a sensor batch body exactly as the
/// backend SensorBatchSchema expects.
String encodeSensorBatchBody(String batchId, List<StoredSensorEvent> events) =>
    jsonEncode({
      'batch_id': batchId,
      'client_sent_at': DateTime.now().toUtc().toIso8601String(),
      'events': events.map((e) => e.toJson()).toList(),
    });
