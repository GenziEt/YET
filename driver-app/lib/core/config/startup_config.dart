import 'app_config.dart';

/// Compile-time startup configuration (§STARTUP-OPTIMIZATION.md §5.3).
///
/// Every value below is a `const` read of a `--dart-define`, which means:
///  * In AOT (release) builds the Dart CFE **constant-folds** them — an unset
///    flag compiles to the literal default and the branch simply does not
///    exist in the snapshot (dead-code elimination ⇒ smaller binary AND zero
///    runtime cost on the launch path).
///  * Nothing here touches disk or platform channels, so reading these values
///    during `main()` is free within the §1.9.1 cold-start budget.
///
/// CI/release builds set them via `flutter build appbundle
/// --dart-define=...` (see driver-app/tool/cold_start_device.sh header for the
/// canonical release invocation). Never put secrets in dart-defines — they are
/// embedded in the binary and readable from it.
class StartupConfig {
  StartupConfig._();

  /// Kill-switch mirroring main()'s `_pipelineEnabled`: set
  /// `--dart-define=PIPELINE_ENABLED=false` to ship a Phase-0-only build
  /// (no SQLite/sync bootstrap at all — even the post-frame one). Default on.
  static const bool pipelineEnabled =
      bool.fromEnvironment('PIPELINE_ENABLED', defaultValue: true);

  /// Post-first-frame socket warm-up (DNS+TCP+TLS prepay) against the API
  /// gateway. Set `PRECONNECT=false` only if pilot networks show the warm-up
  /// request colliding with first uploads on very weak edges. Default on.
  static const bool preconnectEnabled =
      bool.fromEnvironment('PRECONNECT', defaultValue: true);

  /// Environment-pinned API base. When provided it OVERRIDES the
  /// kDebugMode/release split in [AppConfig] — this lets CI promote the exact
  /// same compiled artifact across staging/prod by rebuilding with a single
  /// define instead of mutating code. Must be an absolute https:// URL in
  /// release (data-sovereignty gateway, PDPP §1.7). Empty string = unset.
  static const String apiBaseUrlOverride =
      String.fromEnvironment('API_BASE_URL');

  /// Same idea for the self-hosted tile endpoint ({z}/{x}/{y} template).
  static const String tileUrlOverride =
      String.fromEnvironment('TILE_BASE_URL');

  /// Applies the overrides once at the top of `main()` — plain field writes,
  /// no I/O, safe inside the cold-start budget. Call BEFORE runApp; after the
  /// first frame nothing re-reads these except lazily-constructed services.
  static void apply() {
    if (apiBaseUrlOverride.isNotEmpty) AppConfig.apiBaseUrl = apiBaseUrlOverride;
    if (tileUrlOverride.isNotEmpty) AppConfig.tileUrlTemplate = tileUrlOverride;
  }
}
