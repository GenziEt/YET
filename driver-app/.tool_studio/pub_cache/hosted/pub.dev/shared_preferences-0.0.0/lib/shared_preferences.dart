class SharedPreferences {
  static final SharedPreferences _inst = SharedPreferences();
  static Future<SharedPreferences> getInstance() async => _inst;
  final Map<String, Object> _m = {};
  bool? getBool(String k) => _m[k] as bool?;
  String? getString(String k) => _m[k] as String?;
  int? getInt(String k) => _m[k] as int?;
  Future<bool> setBool(String k, bool v) async { _m[k] = v; return true; }
  Future<bool> setString(String k, String v) async { _m[k] = v; return true; }
  Future<bool> setInt(String k, int v) async { _m[k] = v; return true; }
  Future<bool> remove(String k) async { _m.remove(k); return true; }
}
