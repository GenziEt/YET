/// Sandbox stub of package:sqflite/sqflite.dart (analyze + kernel-compile only).
/// Mirrors the real sqflite API surface used by the YET offline cache
/// (Offline Contract SS1.8). Runtime behaviour is NOT emulated here - on a
/// device the real plugin takes over via pubspec dependency resolution.
library sqflite;

typedef OnDatabaseCreateFn = Future<void> Function(Database db, int version);
typedef OnDatabaseUpgradeFn = Future<void> Function(Database db, int oldVersion, int newVersion);

abstract class Transaction {
  Future<List<Map<String, Object?>>> query(String table,
      {String? where, List<Object?>? whereArgs, String? orderBy, int? limit});
  Future<List<Map<String, Object?>>> rawQuery(String sql, [List<Object?>? args]);
  Future<int> insert(String table, Map<String, Object?> values,
      {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm});
  Future<int> update(String table, Map<String, Object?> values,
      {String? where, List<Object?>? whereArgs});
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs});
  Future<int> rawInsert(String sql, [List<Object?>? args]);
  Future<int> rawUpdate(String sql, [List<Object?>? args]);
}

abstract class Database {
  String get path;
  int get version;
  Future<void> execute(String sql, [List<Object?>? arguments]);
  Future<T> transaction<T>(Future<T> Function(Transaction txn) action, {bool? exclusive});
  Future<List<Map<String, Object?>>> query(String table,
      {String? where, List<Object?>? whereArgs, String? orderBy, int? limit, int? offset});
  Future<List<Map<String, Object?>>> rawQuery(String sql, [List<Object?>? args]);
  Future<Map<String, Object?>?> rawQueryFirst(String sql, [List<Object?>? args]);
  Future<int> insert(String table, Map<String, Object?> values,
      {String? nullColumnHack, ConflictAlgorithm? conflictAlgorithm});
  Future<int> update(String table, Map<String, Object?> values,
      {String? where, List<Object?>? whereArgs});
  Future<int> delete(String table, {String? where, List<Object?>? whereArgs});
  Future<int> rawInsert(String sql, [List<Object?>? args]);
  Future<int> rawUpdate(String sql, [List<Object?>? args]);
  Future<void> close();
}

enum ConflictAlgorithm { rollback, abort, fail, ignore, replace }

abstract class DatabaseFactory {
  Future<Database> openDatabase(String path,
      {int? version,
      OnDatabaseCreateFn? onCreate,
      OnDatabaseUpgradeFn? onUpgrade,
      bool singleInstance = true});
  Future<String> getDatabasesPath();
  Future<bool> databaseExists(String path);
  Future<void> deleteDatabase(String path);
}

final DatabaseFactory databaseFactory = _StubDatabaseFactory();

class _StubDatabase implements Database {
  @override
  Future<void> execute(String sql, [List<Object?>? arguments]) async {}
  @override
  T transaction<T>(Future<T> Function(Transaction txn) action, {bool? exclusive}) =>
      throw UnimplementedError('stub: no runtime semantics');
  @override
  dynamic noSuchMethod(Invocation invocation) => null;
  @override
  final String path = 'stub.db';
  @override
  int get version => 1;
}

class _StubDatabaseFactory implements DatabaseFactory {
  @override
  Future<Database> openDatabase(String path,
          {int? version,
          OnDatabaseCreateFn? onCreate,
          OnDatabaseUpgradeFn? onUpgrade,
          bool singleInstance = true}) async =>
      _StubDatabase();
  @override
  Future<String> getDatabasesPath() async => '/tmp/stub-databases';
  @override
  Future<bool> databaseExists(String path) async => false;
  @override
  Future<void> deleteDatabase(String path) async {}
}

/// Top-level convenience matching the legacy sqflite API.
Future<Database> openDatabase(String path,
        {int? version, OnDatabaseCreateFn? onCreate, OnDatabaseUpgradeFn? onUpgrade}) =>
    databaseFactory.openDatabase(path, version: version, onCreate: onCreate, onUpgrade: onUpgrade);
