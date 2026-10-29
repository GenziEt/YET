import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'package:yet_driver/core/cache/fix_dao.dart';
import 'package:yet_driver/core/sync/sync_worker.dart';
import 'package:yet_driver/features/consent/consent_repository.dart';
import 'package:yet_driver/features/trip/trip_home_screen.dart';
import 'package:yet_driver/l10n/app_localizations.dart';

/// §STARTUP-OPTIMIZATION.md — boot-path regression guards for the two claims
/// that make the §1.9.1 cold-start budget (≤3 s to a usable "Start Trip" on a
/// 2 GB RAM Android 10 device) hold as the app evolves:
///
///  * §5.2 LAYOUT FLATTENING — Trip Home's first-frame widget tree stays
///    bounded, so no PR silently re-introduces multi-pass layout depth on the
///    boot-critical screen (the Flutter analogue of the ride-hailing
///    Compose/SwiftUI single-pass drawing rule).
///  * §3   LOCAL-FIRST HYDRATION — the usable screen is a pure function of
///    local state: with AppRuntime == null (SQLite bootstrap not yet landed)
///    and zero network, ONE pump must already show the interactive START TRIP
///    surface — never a spinner, never an awaited blank.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Depth budget: measured baseline + margin. Ordinary M3 scaffolding
  // (MaterialApp → Scaffold → AppBar/MediaQuery/Padding chains) accounts for
  // most of it; the gate exists to catch Column-of-Cards-of-Lists creep.
  const maxDepth = 14;

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
  });

  /// Longest root-to-leaf path in the rendered element tree.
  int measureDepth(Element root) {
    var deepest = 0;
    void walk(Element e, int d) {
      if (d > deepest) deepest = d;
      e.visitChildren((c) => walk(c, d + 1));
    }

    walk(root, 0);
    return deepest;
  }

  /// The exact cold-start shape main.dart paints at t≈0: consent flags from
  /// KV, runtime still null, worker bound to an empty in-memory cache.
  Future<Widget> bootFrame() async {
    final db = await databaseFactory.openDatabase(inMemoryDatabasePath);
    await FixDao.onCreate(db, 1);
    final worker = SyncWorker(
      dao: FixDao(db),
      // Any upload attempt during these tests is itself a contract breach
      // (boot must touch zero network) — throw loudly instead of acking.
      uploader: (batchId, fixes) async =>
          throw StateError('boot path must not upload ($batchId)'),
    );
    return MaterialApp(
      locale: const Locale('en'),
      supportedLocales: AppLocalizations.supportedLocales,
      localizationsDelegates: const [AppLocalizations.delegate],
      home: TripHomeScreen(
        consent: ConsentRepository()
          ..accepted = true
          ..permissionsAcknowledged = true,
        runtime: null,
        sync: worker,
        onToggleLocale: () {},
      ),
    );
  }

  testWidgets('cold-start frame renders interactive START TRIP with NO runtime/network',
      (tester) async {
    await tester.pumpWidget(await bootFrame());

    // ONE pump: any hidden await/FutureBuilder would still be pending here.
    expect(find.text('START TRIP'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsNothing);
    // The tap target is live before SQLite-backed bootstrap lands — this is
    // precisely the "usable Start Trip screen" the 3 s budget is measured to.
    expect(
        tester
            .widget<FilledButton>(find.widgetWithText(FilledButton, 'START TRIP'))
            .enabled,
        isTrue);
  });

  testWidgets('boot-path layout flattening budget: depth <= $maxDepth',
      (tester) async {
    await tester.pumpWidget(await bootFrame());

    final depth = measureDepth(tester.element(find.byType(MaterialApp)));
    // ignore: avoid_print
    print('TripHome first-frame widget depth: $depth');
    expect(depth, lessThanOrEqualTo(maxDepth),
        reason: 'Boot-path nesting grew past the flattening budget — each '
            'extra level is another layout pass on the launch critical path. '
            'See docs/STARTUP-OPTIMIZATION.md §5.2.');
  });
}
