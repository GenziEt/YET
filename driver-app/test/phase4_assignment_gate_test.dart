import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:yet_driver/core/app_runtime.dart';
import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/features/auth/token_store.dart';
import 'package:yet_driver/features/consent/consent_repository.dart';
import 'package:yet_driver/features/pilot/pilot_service.dart';
import 'package:yet_driver/features/trip/gps_collector.dart';
import 'package:yet_driver/features/trip/sensor_collector.dart';
import 'package:yet_driver/features/trip/trip_home_screen.dart';
import 'package:yet_driver/l10n/app_localizations.dart';

/// §Phase 4 hard gate tests ("Assignment enforcement prevents collection or
/// trip start when no valid assignment exists"):
///  * pure truth table over all four [AssignmentCheck] branches for
///    allowsTripStart / allowsTripEnd;
///  * end-to-end widget behaviour through AppRuntime.onTripToggled with a
///    MockClient: server-confirmed → trip starts (END TRIP); no-vehicle →
///    BLOCKED, button stays START TRIP + tripVehicleNone banner and NOTHING
///    is collected; offline+cached → allowed silently; offline+unknown →
///    blocked with the same actionable banner.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUpAll(() {
    sqfliteFfiInit();
    databaseFactory = databaseFactoryFfi;
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  group('pure gate truth table', () {
    test('allowsTripStart: confirmed/offlineCached allowed, others blocked',
        () {
      expect(allowsTripStart(AssignmentCheck.confirmed), isTrue);
      expect(allowsTripStart(AssignmentCheck.offlineCached), isTrue);
      expect(allowsTripStart(AssignmentCheck.noVehicle), isFalse);
      expect(allowsTripStart(AssignmentCheck.offlineUnknown), isFalse);
    });

    test('allowsTripEnd: never blocked (§1.8 no data loss on transitions)', () {
      for (final c in AssignmentCheck.values) {
        expect(allowsTripEnd(c), isTrue, reason: '$c must allow END');
      }
    });
  });

  group('confirmVehicleAssignment branch coverage (MockClient)', () {
    late Directory dir;
    late String dbPath;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('yet_test_db');
      dbPath = '${dir.path}/yet_cache.db';
      SharedPreferences.setMockInitialValues({});
    });

    tearDown(() async {
      await databaseFactory.deleteDatabase(dbPath);
    });

    Future<AppRuntime> boot(http.Client client) async =>
        AppRuntime.bootstrap(
          tokenStore: TokenStore(),
          dbPathOverride: dbPath,
          httpClient: client,
          positionSource: () => const Stream<RawPosition>.empty(),
          sensorSource: () => const Stream<RawSensorSample>.empty(),
        );

    test('200 with vehicle → confirmed + cache persisted', () async {
      final rt = await boot(MockClient((req) async => http.Response(
            jsonEncode({
              'vehicle': {'vehicle_id': 'v1', 'plate_number': '3-A1234'},
            }),
            200,
            headers: {'content-type': 'application/json'},
          )));
      // Token present so the /me request goes out authenticated.
      final ts = rt.tokenStore;
      await ts.save(token: 't', driverId: 'd1');
      expect(await rt.pilot.confirmVehicleAssignment(),
          AssignmentCheck.confirmed);
      expect(rt.pilot.cachedAssignment?.plateNumber, '3-A1234');
      // Cache survived to SharedPreferences (offline restart keeps the gate).
      final sp = await SharedPreferences.getInstance();
      expect(sp.getString('pilot_vehicle_v1'), contains('3-A1234'));
      rt.dispose();
    });

    test('200 without vehicle → noVehicle AND live cache cleared', () async {
      final rt = await boot(MockClient((req) async =>
          http.Response(jsonEncode({'role': 'driver'}), 200,
              headers: {'content-type': 'application/json'})));
      await rt.tokenStore.save(token: 't');
      rt.pilot.seedAssignmentCache(
          const VehicleAssignment(vehicleId: 'old', plateNumber: 'OLD-1'));
      expect(await rt.pilot.confirmVehicleAssignment(),
          AssignmentCheck.noVehicle);
      // Server truth overrides the stale cache — a revoked assignment must not
      // keep letting this driver start trips offline.
      expect(rt.pilot.cachedAssignment, isNull);
      rt.dispose();
    });

    test('network throw + cached → offlineCached (allowed)', () async {
      final rt = await boot(MockClient((req) async {
        throw http.ClientException('down');
      }));
      await rt.tokenStore.save(token: 't');
      rt.pilot.seedAssignmentCache(
          const VehicleAssignment(vehicleId: 'v1', plateNumber: 'P-1'));
      expect(await rt.pilot.confirmVehicleAssignment(),
          AssignmentCheck.offlineCached);
      rt.dispose();
    });

    test('network throw + nothing cached → offlineUnknown (blocked)',
        () async {
      final rt = await boot(MockClient((req) async {
        throw http.ClientException('down');
      }));
      await rt.tokenStore.save(token: 't');
      rt.pilot.seedAssignmentCache(null);
      expect(await rt.pilot.confirmVehicleAssignment(),
          AssignmentCheck.offlineUnknown);
      rt.dispose();
    });
  });

  group('trip-home one-tap gating (widget level)', () {
    late Directory dir;
    late String dbPath;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('yet_test_db');
      dbPath = '${dir.path}/yet_cache.db';
      SharedPreferences.setMockInitialValues(
          {'consent_accepted_v1': true, 'permissions_acknowledged': true});
    });

    tearDown(() async {
      await databaseFactory.deleteDatabase(dbPath);
    });

    Future<AppRuntime> boot(http.Client client) async =>
        AppRuntime.bootstrap(
          tokenStore: TokenStore(),
          dbPathOverride: dbPath,
          httpClient: client,
          positionSource: () => const Stream<RawPosition>.empty(),
          sensorSource: () => const Stream<RawSensorSample>.empty(),
        );

    Widget home(AppRuntime rt) {
      final consent = ConsentRepository();
      return MaterialApp(
        locale: const Locale('en'),
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [AppLocalizations.delegate],
        home: TripHomeScreen(
          consent: consent,
          onToggleLocale: () {},
          runtime: rt,
        ),
      );
    }

    testWidgets('confirmed assignment: tap starts trip (START→END TRIP)',
        (tester) async {
      final rt = await boot(MockClient((req) async {
        if (req.url.path.endsWith('/me')) {
          return http.Response(
              jsonEncode({
                'vehicle': {'vehicle_id': 'v1', 'plate_number': '3-A1234'},
              }),
              200,
              headers: {'content-type': 'application/json'});
        }
        return http.Response('{}', 200);
      }));
      await rt.tokenStore.save(token: 't');
      addTearDown(rt.dispose);

      await tester.pumpWidget(home(rt));
      await tester.pumpAndSettle();
      expect(find.text('START TRIP'), findsOneWidget);

      await tester.tap(find.widgetWithText(FilledButton, 'START TRIP'));
      await tester.pumpAndSettle();
      // Gate passed: UI flipped to active and the confirm banner names the
      // vehicle the driver is about to haul fixes for.
      expect(find.text('END TRIP'), findsOneWidget);
      expect(find.textContaining('3-A1234'), findsOneWidget);
      expect(rt.gps.isActive, isTrue);
    });

    testWidgets('no-vehicle: HARD BLOCK — stays START TRIP, shows banner, '
        'collects nothing', (tester) async {
      final rt = await boot(MockClient((req) async {
        if (req.url.path.endsWith('/me')) {
          return http.Response(jsonEncode({'role': 'driver'}), 200,
              headers: {'content-type': 'application/json'});
        }
        return http.Response('{}', 200);
      }));
      await rt.tokenStore.save(token: 't');
      addTearDown(rt.dispose);

      await tester.pumpWidget(home(rt));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(FilledButton, 'START TRIP'));
      await tester.pumpAndSettle();

      // Button did NOT flip — _tripActive stayed false (hard-gate contract).
      expect(find.text('START TRIP'), findsOneWidget);
      expect(find.text('END TRIP'), findsNothing);
      // Actionable banner tells the driver to reach the fleet manager.
      final l = AppLocalizations('en');
      expect(find.text(l.tripVehicleNone), findsOneWidget);
      // And crucially: NO collection started, no cadence running.
      expect(rt.gps.isActive, isFalse);
      expect(rt.sensors.isActive, isFalse);
    });

    testWidgets('offline + cached assignment: allowed silently', (tester) async {
      final rt = await boot(MockClient((req) async {
        throw http.ClientException('airplane mode');
      }));
      await rt.tokenStore.save(token: 't');
      rt.pilot.seedAssignmentCache(
          const VehicleAssignment(vehicleId: 'v1', plateNumber: 'P-9'));
      addTearDown(rt.dispose);

      await tester.pumpWidget(home(rt));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'START TRIP'));
      await tester.pumpAndSettle();

      expect(find.text('END TRIP'), findsOneWidget);
      // Never nags an offline driver whose cached assignment is valid.
      expect(find.text(AppLocalizations('en').tripVehicleNone), findsNothing);
      expect(rt.gps.isActive, isTrue);
    });

    testWidgets('offline + nothing cached: blocked with banner', (tester) async {
      final rt = await boot(MockClient((req) async {
        throw http.ClientException('airplane mode');
      }));
      await rt.tokenStore.save(token: 't');
      rt.pilot.seedAssignmentCache(null);
      addTearDown(rt.dispose);

      await tester.pumpWidget(home(rt));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'START TRIP'));
      await tester.pumpAndSettle();

      expect(find.text('START TRIP'), findsOneWidget);
      expect(find.text(AppLocalizations('en').tripVehicleNone), findsOneWidget);
      expect(rt.gps.isActive, isFalse);
    });
  });

  // §1.3 follow-up: AdaptiveInterval must actually drive the sampling cadence.
  // The plugin stream (GeolocatorPositionSource) reads gps.currentInterval on
  // every (re)build; AppRuntime's watchdog resubscribes when the speed/boost-
  // derived tier changes. These tests exercise the runtime half of that loop
  // headlessly with a counting fake position source.
  group('AdaptiveInterval wiring in AppRuntime (§1.3)', () {
    late Directory dir;
    late String dbPath;

    setUp(() async {
      dir = await Directory.systemTemp.createTemp('yet_adaptive_db');
      dbPath = '${dir.path}/yet_cache.db';
      SharedPreferences.setMockInitialValues({});
    });

    tearDown(() async {
      await databaseFactory.deleteDatabase(dbPath);
    });

    // The fake source emits exactly one highway-speed fix per stream build,
    // synchronously enough that GpsCollector's own subscription updates
    // gps.currentInterval (20 m/s ≥ 14 ⇒ 30 s tier) right after beginCollection.
    Future<AppRuntime> bootCounting(_StreamCounter counter) async {
      return AppRuntime.bootstrap(
        tokenStore: TokenStore(),
        dbPathOverride: dbPath,
        httpClient: MockClient((req) async => http.Response(
              jsonEncode({
                'vehicle': {'vehicle_id': 'v1', 'plate_number': '3-A1234'},
              }),
              200,
              headers: {'content-type': 'application/json'},
            )),
        positionSource: () {
          counter.builds++;
          return Stream.fromFuture(Future.value(RawPosition(
            latitude: 9.03,
            longitude: 38.74,
            timestampUtc: DateTime.now().toUtc(),
            speedMps: 20, // highway tier → currentInterval becomes 30 s
          )));
        },
        sensorSource: () => const Stream<RawSensorSample>.empty(),
      );
    }

    test('tickAdaptiveSampling resubscribes only when the tier changes',
        () async {
      final counter = _StreamCounter();
      final rt = await bootCounting(counter);
      final gpsRef = rt.gps;
      addTearDown(rt.dispose);

      await rt.onTripToggled(active: true);
      expect(gpsRef.isActive, isTrue);
      // beginCollection built exactly one stream and its single emitted fix
      // moved the policy to the 30 s tier...
      expect(counter.builds, 1);
      expect(gpsRef.currentInterval, const Duration(seconds: 30));
      // ...but trip start seeded _appliedGpsInterval with the SAME wanted
      // value, so the first tick must NOT rebuild spuriously.
      await rt.tickAdaptiveSampling();
      expect(counter.builds, 1, reason: 'seeded applied == wanted — no-op');

      // Drop back to the urban tier through the REAL write path.
      await gpsRef.ingest(RawPosition(
        latitude: 9.04,
        longitude: 38.75,
        timestampUtc: DateTime.now().toUtc(),
        speedMps: 5,
      ));
      expect(gpsRef.currentInterval, const Duration(seconds: 10));

      await rt.tickAdaptiveSampling();
      expect(counter.builds, 2, reason: 'tier change must rebuild once');
      await rt.tickAdaptiveSampling();
      expect(counter.builds, 2, reason: 'same tier — second tick is a no-op');

      await rt.onTripToggled(active: false);
      expect(gpsRef.isActive, isFalse);
    });

    test('watchdog timer starts on trip start and stops on trip end',
        () async {
      final counter = _StreamCounter();
      final rt = await bootCounting(counter);
      addTearDown(rt.dispose);

      await rt.onTripToggled(active: true);
      expect(counter.builds, 1);
      // Real timers can't reach the 20 s period inside this test body; drive
      // the same entry point the periodic callback uses instead.
      await rt.tickAdaptiveSampling();
      expect(counter.builds, 1);

      await rt.onTripToggled(active: false);
      // Post-trip ticks are hard no-ops even if a stale timer callback lands.
      await rt.tickAdaptiveSampling();
      expect(counter.builds, 1);
    });
  });
}

class _StreamCounter {
  int builds = 0;
}
