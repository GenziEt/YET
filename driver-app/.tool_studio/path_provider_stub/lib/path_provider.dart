/// Sandbox stub of package:path_provider (analyze-only).
library path_provider;
import 'dart:io';
class PathProvider {
  static Future<Directory> getApplicationDocumentsDirectory() async => Directory('/tmp/stub-docs');
  static Future<Directory> getApplicationSupportDirectory() async => Directory('/tmp/stub-support');
}
