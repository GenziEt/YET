/// Sandbox stub of package:path_provider (analyze-only).
/// Top-level functions mirror the real package API so product code imports
/// `getApplicationSupportDirectory()` directly, exactly as on device.
library path_provider;

import 'dart:io';

Future<Directory> getApplicationDocumentsDirectory() async =>
    Directory('/tmp/stub-docs');

Future<Directory> getApplicationSupportDirectory() async =>
    Directory('/tmp/stub-support');

Future<Directory> getApplicationCacheDirectory() async =>
    Directory('/tmp/stub-cache');

Future<Directory?> getExternalStorageDirectory() async =>
    Directory('/tmp/stub-external');

/// Legacy class facade kept for any older call sites.
class PathProvider {
  static Future<Directory> getApplicationDocumentsDirectory() async =>
    Directory('/tmp/stub-docs');
  static Future<Directory> getApplicationSupportDirectory() async =>
    Directory('/tmp/stub-support');
}
