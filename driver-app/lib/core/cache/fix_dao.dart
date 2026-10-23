import 'dart:convert';

import 'package:sqflite/sqflite.dart';

import '../sync/sync_state.dart';

/// One stored GPS fix in the offline cache (Offline Contract §1.8).
/// Field names mirror the backend ingest contract exactly
/// (`backend/src/modules/ingest/service.ts` LocationFixSchema) so a cached row
/// serializes into an upload payload with zero translation layer.
class StoredFix {
  StoredFix({
    required this.id,
    required this.lat,
    required this.lng,
    required this.fixTimestamp,
    this.speedMps,
    this.accuracyM,
    this.headingDeg,
    this.altitudeM,
    this.provider = 'gps',
    required this.syncState,
    this.batchId,
    this.uploadAttempts = 0,
  });

  final int id; // local auto-increment — never leaves the device
  final double lat;
  final double lng;
  /// EVENT time from the device clock (§1.8.3). The backend orders/reconstructs
  /// on this, never on received_at.
  final DateTime fixTimestamp;
  final double? speedMps;
  final double? accuracyM;
  final double? headingDeg;
  final double? altitudeM;
  final String provider;

  SyncState syncState;
  /// UUID v4 stamped when the uploader claims the row (§1.8 rule 5): a crash
  /// mid-upload replays atomically because every member shares its batch_id.
  String? batchId;
  int uploadAttempts;

  Map<String, Object?> toDbRow() => {
        'id': id,
        'lat': lat,
        'lng': lng,
        'fix_timestamp': fixTimestamp.toUtc().toIso8601String(),
        'speed_mps': speedMps,
        'accuracy_m': accuracyM,
        'heading_deg': headingDeg,
        'altitude_m': altitudeM,
        'provider': provider,
        'sync_state': SyncStateCodec.name(syncState),
        'batch_id': batchId,
        'upload_attempts': uploadAttempts,
      };

  factory StoredFix.fromDbRow(Map<String, Object?> r) => StoredFix(
        id: r['id'] as int,
        lat: (r['lat'] as num).toDouble(),
        lng: (r['lng'] as num).toDouble(),
        fixTimestamp: DateTime.parse(r['fix_timestamp'] as String),
        speedMps: (r['speed_mps'] as num?)?.toDouble(),
        accuracyM: (r['accuracy_m'] as num?)?.toDouble(),
        headingDeg: (r['heading_deg'] as num?)?.toDouble(),
        altitudeM: (r['altitude_m'] as num?)?.toDouble(),
        provider: (r['provider'] as String?) ?? 'gps',
        syncState: SyncStateCodec.fromName(r['sync_state'] as String),
        batchId: r['batch_id'] as String?,
        uploadAttempts: (r['upload_attempts'] as int?) ?? 0,
      );

  /// Wire format accepted by POST /ingest/locations (LocationFixSchema).
  Map<String, Object?> toJson() => {
        'fix_timestamp': fixTimestamp.toUtc().toIso8601String(),
        'lat': lat,
        'lng': lng,
        if (speedMps != null) 'speed_mps': speedMps,
        if (accuracyM != null) 'accuracy_m': accuracyM,
        if (headingDeg != null) 'heading_deg': headingDeg,
        if (altitudeM != null) 'altitude_m': altitudeM,
        'provider': provider,
      };
}

/// Local SQLite cache for location fixes — Phase 1 deliverable.
///
/// Hard rules enforced here (see sync_state.dart doc-comment):
///  * rows are NEVER deleted before ACKED (no data loss);
///  * UPLOADING rows that were never ACKed return to PENDING on open
///    (process-death recovery, §1.8.1);
///  * pruning happens only via [pruneAckedOlderThan] / [pruneToStorageBudget].
class FixDao {
  static const tableFixes = 'location_fixes';
  static const dbVersion = 1;

  final Database db;
  FixDao(this.db);

  /// Schema. `acked_at` drives the 7-day prune; the partial-ish index on
  /// (sync_state, fix_timestamp) keeps the uploader's claim query cheap even
  /// on slow storage (low-end Android constraint §1.2).
  static Future<void> onCreate(Database db, int version) async {
    await db.execute('''
      CREATE TABLE $tableFixes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        fix_timestamp TEXT NOT NULL,
        speed_mps REAL,
        accuracy_m REAL,
        heading_deg REAL,
        altitude_m REAL,
        provider TEXT NOT NULL DEFAULT 'gps',
        sync_state TEXT NOT NULL DEFAULT 'PENDING',
        batch_id TEXT,
        upload_attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        acked_at TEXT
      )
    ''');
    await db.execute(
        'CREATE INDEX idx_fixes_sync ON $tableFixes (sync_state, fix_timestamp)');
    await db.execute('CREATE INDEX idx_fixes_time ON $tableFixes (fix_timestamp)');
  }

  /// Open + crash recovery. Call once at startup (pre-warmed off the cold-start
  /// critical path per §1.9.1).
  static Future<FixDao> openAndRecover(String path) async {
    final db = await databaseFactory.openDatabase(
      path,
      version: dbVersion,
      onCreate: onCreate,
    );
    final dao = FixDao(db);
    await dao.recoverUnackedUploads();
    return dao;
  }

  /// §1.8.1: "UPLOADING rows that were never ACKed return to PENDING on process
  /// restart." Their batch_id is cleared so they get re-stamped fresh.
  Future<int> recoverUnackedUploads() => db.update(
        tableFixes,
        {'sync_state': 'PENDING', 'batch_id': null},
        where: "sync_state = 'UPLOADING'",
      );

  /// Insert one fix collected by the GPS service. Returns the local row id.
  Future<int> insertFix(StoredFix fix) => db.insert(tableFixes, {
        ...fix.toDbRow(),
        'created_at': DateTime.now().toUtc().toIso8601String(),
      });

  Future<int> pendingCount() async {
    final rows = await db.rawQuery(
        'SELECT COUNT(*) AS c FROM $tableFixes WHERE sync_state IN (?, ?)',
        ['PENDING', 'UPLOADING']);
    return (rows.first['c'] as int?) ?? 0;
  }

  Future<int> totalRowCount() async {
    final rows =
        await db.rawQuery('SELECT COUNT(*) AS c FROM $tableFixes');
    return (rows.first['c'] as int?) ?? 0;
  }

  /// Approximate DB size on disk in bytes (§1.8.6 budget checks). sqflite
  /// exposes page_count/page_size via PRAGMA.
  Future<int> storageBytes() async {
    final pc = await db.rawQuery('PRAGMA page_count');
    final ps = await db.rawQuery('PRAGMA page_size');
    final pages = (pc.first.values.first as num?)?.toInt() ?? 0;
    final size = (ps.first.values.first as num?)?.toInt() ?? 0;
    return pages * size;
  }

  /// Claim up to [limit] oldest PENDING fixes for one batch, stamping them with
  /// [batchId] and moving PENDING→UPLOADING atomically (contract rule 5).
  /// Selecting by fix_timestamp ASC preserves event-time order within a batch,
  /// which keeps late-arriving replay windows contiguous (§1.8.3).
  Future<List<StoredFix>> claimBatch(String batchId, int limit) =>
      db.transaction((txn) async {
        final rows = await txn.query(tableFixes,
            where: "sync_state = 'PENDING'",
            orderBy: 'fix_timestamp ASC',
            limit: limit);
        final ids = rows.map((r) => r['id'] as int).toList();
        if (ids.isEmpty) return <StoredFix>[];
        final placeholders = List.generate(ids.length, (_) => '?').join(',');
        await txn.update(
          tableFixes,
          {'sync_state': 'UPLOADING', 'batch_id': batchId},
          where: 'id IN ($placeholders)',
          whereArgs: ids,
        );
        return rows
            .map((r) => StoredFix.fromDbRow(r))
            .toList()
            .asMap()
            .entries
            .map((e) => StoredFix(
                  id: e.value.id,
                  lat: e.value.lat,
                  lng: e.value.lng,
                  fixTimestamp: e.value.fixTimestamp,
                  speedMps: e.value.speedMps,
                  accuracyM: e.value.accuracyM,
                  headingDeg: e.value.headingDeg,
                  altitudeM: e.value.altitudeM,
                  provider: e.value.provider,
                  syncState: SyncState.uploading,
                  batchId: batchId,
                  uploadAttempts: e.value.uploadAttempts,
                ))
            .toList();
      });

  /// Server ACK (HTTP 200 for this batch_id): UPLOADING→ACKED, stamp acked_at.
  Future<int> markBatchAcked(String batchId) => db.update(
        tableFixes,
        {'sync_state': 'ACKED', 'acked_at': DateTime.now().toUtc().toIso8601String()},
        where: "sync_state = 'UPLOADING' AND batch_id = ?",
        whereArgs: [batchId],
      );

  /// HTTP failure / non-2xx: UPLOADING→PENDING for this batch, attempts++
  /// (drives the backoff exponent in SyncWorker). Rows keep their batch_id so
  /// a retry of the SAME records hits server idempotency cleanly (§1.8.2).
  Future<int> releaseBatchForRetry(String batchId) => db.transaction((txn) async {
        final rows = await txn.query(tableFixes,
            where: "sync_state = 'UPLOADING' AND batch_id = ?",
            whereArgs: [batchId]);
        var updated = 0;
        for (final r in rows) {
          final attempts = ((r['upload_attempts'] as int?) ?? 0) + 1;
          updated += await txn.update(
            tableFixes,
            {'sync_state': 'PENDING', 'upload_attempts': attempts},
            where: 'id = ?',
            whereArgs: [r['id']],
          );
        }
        return updated;
      });

  /// Highest upload_attempts among rows currently stamped with [batchId].
  /// SyncWorker reads this AFTER releaseBatchForRetry so the backoff exponent
  /// survives process restarts (retry state lives in SQLite, not memory).
  Future<int> maxAttemptsForBatch(String batchId) async {
    final rows = await db.rawQuery(
        'SELECT MAX(upload_attempts) AS m FROM $tableFixes WHERE batch_id = ?',
        [batchId]);
    return (rows.first['m'] as int?) ?? 0;
  }

  /// Newest cached fix by event time — feeds the Phase 4 diagnostics payload
  /// ("last fix time / accuracy") on the in-app feedback screen. Returns null
  /// when the cache is empty (fresh install, pre-permission).
  Future<StoredFix?> latestFix() async {
    final rows = await db.rawQuery(
      'SELECT * FROM $tableFixes ORDER BY fix_timestamp DESC LIMIT 1',
    );
    if (rows.isEmpty) return null;
    return StoredFix.fromDbRow(rows.first);
  }

  /// Prune policy part 1 (§1.8.1): ACKED older than [maxAge] → PRUNED (deleted).
  Future<int> pruneAckedOlderThan(Duration maxAge) => db.delete(
        tableFixes,
        where: "sync_state = 'ACKED' AND acked_at IS NOT NULL AND acked_at < ?",
        whereArgs: [
          DateTime.now().toUtc().subtract(maxAge).toIso8601String()
        ],
      );

  /// Prune policy part 2 (§1.8.1 / §1.8.6): whichever comes first — evict the
  /// OLDEST ACKED rows until the DB fits under [budgetBytes]. ACKED rows are
  /// safe to drop (server has them); PENDING/UPLOADING rows are untouchable
  /// (no-data-loss rule). GPS fixes are never discarded pre-upload.
  Future<int> pruneToStorageBudget(int budgetBytes) =>
      db.transaction((txn) async {
        var deleted = 0;
        while (true) {
          final pc = await txn.rawQuery('PRAGMA page_count');
          final ps = await txn.rawQuery('PRAGMA page_size');
          final bytes = ((pc.first.values.first as num?) ?? 0) *
              ((ps.first.values.first as num?) ?? 0);
          if (bytes <= budgetBytes) return deleted;
          final victim = await txn.query(tableFixes,
              where: "sync_state = 'ACKED'",
              orderBy: 'fix_timestamp ASC',
              limit: 500);
          if (victim.isEmpty) return deleted; // nothing safe to evict
          final ids = victim.map((r) => r['id'] as int).toList();
          final placeholders = List.generate(ids.length, (_) => '?').join(',');
          deleted += await txn.delete(tableFixes,
              where: 'id IN ($placeholders)', whereArgs: ids);
        }
      });

  Future<void> close() => db.close();
}

/// JSON helpers shared with tests: encode/decode a batch body exactly as the
/// backend BatchSchema expects.
String encodeBatchBody(String batchId, List<StoredFix> fixes) => jsonEncode({
      'batch_id': batchId,
      'client_sent_at': DateTime.now().toUtc().toIso8601String(),
      'fixes': fixes.map((f) => f.toJson()).toList(),
    });
