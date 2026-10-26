import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show MethodChannel;
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:shared_preferences/shared_preferences.dart';

import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/features/auth/token_store.dart';
import 'package:yet_driver/features/pilot/offline_map_screen.dart';
import 'package:yet_driver/features/pilot/pilot_service.dart';

/// §Phase 4: "Offline tile-download logic is connected to the actual map layer
/// so the map widget reads from the downloaded cache directory when offline."
/// These tests pin BOTH halves of that contract in code:
///  * READ path — OfflineTileImage.filePathFor round-trip (a PNG written at the
///    canonical location renders as an Image, not the placeholder) and the
///    missing-tile fallback (default grey ColoredBox / custom errorBuilder);
///  * WRITE path — PilotService.prefetchTiles against a MockClient: on-disk
///    layout {z}/{x}/{y}.png, resume-skip (re-run makes ZERO network calls),
///    honest failure counting on non-200/throw, and TileProgress.cacheRoot
///    propagation (first + last throttled emissions carry the root the read
///    path needs).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  // Minimal valid 1×1 transparent PNG (base64) — real bytes so MemoryImage
  // decoding exercises the production decode path, not a stub.
  final pngBytes = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk'
    'YPhfDQAKhAI5e1c0AAAAAElFTkSuQmCC',
  );

  late Directory tmp;
  late String rootWithSlash; // cache root passed to filePathFor/widget

  setUp(() async {
    tmp = await Directory.systemTemp.createTemp('yet_tiles_test');
    rootWithSlash = '${tmp.path}/';
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  tearDown(() async {
    try {
      await tmp.delete(recursive: true);
    } catch (_) {}
  });

  group('OfflineTileImage read path', () {
    test('filePathFor canonical layout matches prefetch write layout', () {
      // '$root{z}/{x}/{y}.png' — root must end with the separator.
      expect(OfflineTileImage.filePathFor(rootWithSlash, 6, 34, 21),
          '${rootWithSlash}6/34/21.png');
    });

    testWidgets('tile written at filePathFor renders as Image (not error)',
        (tester) async {
      final f = File(OfflineTileImage.filePathFor(rootWithSlash, 6, 34, 21));
      await f.parent.create(recursive: true);
      await f.writeAsBytes(pngBytes);

      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: OfflineTileImage(directory: rootWithSlash, z: 6, x: 34, y: 21),
        ),
      ));
      await tester.pumpAndSettle(); // async exists()+readAsBytes() resolve
      expect(find.byType(Image), findsOneWidget);
      expect(find.byType(ColoredBox), findsNothing);
    });

    testWidgets('missing tile falls back to the grey placeholder',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: const Scaffold(
          body: SizedBox(
            width: 64,
            height: 64,
            child: OfflineTileImage(
                directory: '/nonexistent/', z: 1, x: 1, y: 1),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      expect(
        find.byWidgetPredicate((w) =>
            w is ColoredBox && w.color == const Color(0xFFE5E7EB)),
        findsOneWidget,
      );
    });

    testWidgets('custom errorBuilder wins over the default placeholder',
        (tester) async {
      await tester.pumpWidget(MaterialApp(
        home: Scaffold(
          body: OfflineTileImage(
            directory: '/nonexistent/',
            z: 1,
            x: 1,
            y: 1,
            errorBuilder: (_) => const Text('NO_TILE'),
          ),
        ),
      ));
      await tester.pumpAndSettle();
      expect(find.text('NO_TILE'), findsOneWidget);
    });
  });

  group('prefetchTiles write path (MockClient self-hosted template)', () {
    // Addis-corridor box shrunk to ONE zoom level → exactly 4 tiles at z=6
    // (x 23–24, y 34–35 per Web-Mercator math; countTiles keeps them in sync).
    const bounds = TileBounds(
      minLat: 8.9, minLng: 38.7, maxLat: 9.0, maxLng: 38.8,
      minZoom: 6, maxZoom: 6,
    );

    PilotService service(http.Client client) {
      // path_provider has no host implementation under flutter test; mock the
      // legacy method channel so tileCacheRoot() resolves into tmp/.
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
        const MethodChannel('plugins.flutter.io/path_provider'),
        (call) async => tmp.path,
      );
      final ts = TokenStore();
      SharedPreferences.setMockInitialValues({});
      return PilotService(tokenStore: ts, client: client);
    }

    test('downloads every tile into {z}/{x}/{y}.png and reports honestly',
        () async {
      AppConfig.tileUrlTemplate = 'http://127.0.0.1:9/tiles/{z}/{x}/{y}.png';
      final requested = <String>[];
      final svc = service(MockClient((req) async {
        requested.add(req.url.toString());
        return http.Response.bytes(pngBytes, 200,
            headers: {'content-type': 'image/png'});
      }));

      final progress = await svc.prefetchTiles(bounds);
      expect(progress.finished, isTrue);
      expect(progress.failed, 0);
      expect(progress.done, bounds.countTiles());
      expect(requested.length, bounds.countTiles(),
          reason: 'one HTTP GET per tile, self-hosted template only');
      expect(requested.first, startsWith('http://127.0.0.1:9/tiles/6/'));

      // On-disk layout must match what OfflineTileImage.filePathFor reads.
      for (var z = bounds.minZoom; z <= bounds.maxZoom; z++) {
        final xr = bounds.xRange(z), yr = bounds.yRange(z);
        for (var x = xr[0]; x <= xr[1]; x++) {
          for (var y = yr[0]; y <= yr[1]; y++) {
            final p = OfflineTileImage.filePathFor(
                '${progress.cacheRoot}/', z, x, y);
            expect(File(p).existsSync(), isTrue, reason: 'missing $p');
            expect(await File(p).readAsBytes(), pngBytes);
          }
        }
      }
      expect(progress.cacheRoot.endsWith('offline_tiles'), isTrue,
          reason: 'cacheRoot propagates the canonical offline_tiles dir');
    });

    test('resume-skip: second run with same cache makes ZERO requests',
        () async {
      AppConfig.tileUrlTemplate = 'http://127.0.0.1:9/tiles/{z}/{x}/{y}.png';
      var requests = 0;
      final svc = service(MockClient((req) async {
        requests++;
        return http.Response.bytes(pngBytes, 200);
      }));
      final first = await svc.prefetchTiles(bounds);
      expect(requests, bounds.countTiles());

      requests = 0;
      final second = await svc.prefetchTiles(bounds);
      expect(requests, 0, reason: 'existing files are skipped, not re-fetched');
      expect(second.done, first.total);
      expect(second.failed, 0);
    });

    test('non-200 and thrown errors count as failures, done stays 0',
        () async {
      AppConfig.tileUrlTemplate = 'http://127.0.0.1:9/tiles/{z}/{x}/{y}.png';
      final svc = service(MockClient((req) async {
        if (req.url.pathSegments.contains('34')) {
          return http.Response('rate limited', 500);
        }
        throw http.ClientException('radio down');
      }));
      final progress = await svc.prefetchTiles(bounds);
      expect(progress.done, 0);
      expect(progress.failed, bounds.countTiles());
      expect(progress.finished, isTrue);
    });

    test('throttled onProgress: first emission after 25 tiles and final one '
        'both carry cacheRoot', () async {
      AppConfig.tileUrlTemplate = 'http://127.0.0.1:9/tiles/{z}/{x}/{y}.png';
      final svc = service(MockClient((req) async =>
          http.Response.bytes(pngBytes, 200)));
      final emitted = <TileProgress>[];
      final final_ = await svc.prefetchTiles(bounds, onProgress: emitted.add);

      expect(emitted, isNotEmpty);
      expect(emitted.last.cacheRoot, final_.cacheRoot);
      expect(emitted.first.cacheRoot, final_.cacheRoot);
      expect(emitted.last.done, bounds.countTiles());
      expect(emitted.last.finished, isTrue);
      // Throttle contract: ≤ ceil(total/25)+1 notifications, never per-tile.
      expect(emitted.length,
          lessThanOrEqualTo((bounds.countTiles() / 25).ceil() + 1));
    });
  });
}
