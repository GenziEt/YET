import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/core/sync/sync_worker.dart';
import 'package:yet_driver/features/auth/token_store.dart';
import 'package:yet_driver/features/pilot/pilot_service.dart';

/// §Phase 4: "One-tap driver feedback flow is complete end to end, including
/// submission, retry, and success/failure states." The l10n promise "Could not
/// send — will retry when you have signal" must be backed by the persistent
/// queue in PilotService, not just copy. These tests pin every branch of that
/// queue contract:
///  * failed POST → payload parked (pendingFeedbackCount == 1);
///  * dedupe on batch_id — re-tapping the same failing report never stacks;
///  * cap at 20 entries with OLDEST evicted first (triage wants fresh data);
///  * flush-success delivers everything and empties the queue;
///  * stop-at-first-failure preserves [B, C] order after delivering A.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const queueKey = 'pilot_feedback_queue_v1';

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  Future<PilotService> svc(http.Client client) async {
    final ts = TokenStore();
    await ts.save(token: 't');
    return PilotService(
      tokenStore: ts,
      client: client,
      // Sentinel -1 → battery fields omitted from the payload (no lying).
      batteryReader: () async => const BatteryReading(levelPct: -1),
    );
  }

  Map<String, Object?> payload(String batchId) =>
      SyncWorker.buildDiagnosticsPayload(
        issue: 'gps_not_working',
        pendingSyncCount: 3,
        tripActive: false,
        batchIdOverride: batchId,
      );

  Future<List<dynamic>> rawQueue() async {
    final sp = await SharedPreferences.getInstance();
    final raw = sp.getString(queueKey);
    return raw == null ? [] : jsonDecode(raw) as List<dynamic>;
  }

  group('sendFeedback failure → retry queue', () {
    test('POST failure parks exactly one payload; success sends nothing new',
        () async {
      final s = await svc(MockClient((req) async {
        if (req.url.path.endsWith('/ingest/diagnostics')) {
          throw http.ClientException('no signal');
        }
        return http.Response('{}', 200);
      }));
      final ok = await s.sendFeedback(
          issue: 'gps_not_working', pendingSyncCount: 3, tripActive: false);
      expect(ok, isFalse, reason: 'driver UI shows the failure state honestly');
      expect(await s.pendingFeedbackCount(), 1);

      // Same tap now SUCCEEDING: delivered live, queue untouched by a second
      // entry (success path must never enqueue).
      final s2 = await svc(MockClient((req) async =>
          req.method.name == 'POST' && req.url.path.endsWith('/ingest/diagnostics')
              ? http.Response('{"accepted":true}', 201)
              : http.Response('{}', 200)));
      expect(await s2.sendFeedback(
          issue: 'battery_drain', pendingSyncCount: 0, tripActive: true),
          isTrue);
      expect(await s2.pendingFeedbackCount(), 0);
    });

    test('dedupe on batch_id: two enqueues of the same batch stay count 1',
        () async {
      final s = await svc(MockClient((req) async => http.Response('nope', 500)));
      final p = payload('fixed-batch-1');
      await s.queueFeedbackRetry(p);
      await s.queueFeedbackRetry(p);
      expect(await s.pendingFeedbackCount(), 1,
          reason: 're-tapping the same failing report must not stack');
      final q = await rawQueue();
      expect((q.single as Map)['batch_id'], 'fixed-batch-1');
    });

    test('cap 20: 21 distinct batches → oldest evicted, newest kept',
        () async {
      final s = await svc(MockClient((req) async => http.Response('nope', 500)));
      for (var i = 0; i < 21; i++) {
        await s.queueFeedbackRetry(payload('b$i'));
      }
      expect(await s.pendingFeedbackCount(), 20);
      final ids = (await rawQueue()).map((e) => (e as Map)['batch_id']).toList();
      expect(ids.first, 'b1', reason: 'b0 (oldest) was evicted');
      expect(ids.last, 'b20', reason: 'newest report matters most in triage');
      expect(ids.contains('b0'), isFalse);
    });
  });

  group('flushFeedbackQueue', () {
    test('all-delivered success clears the queue', () async {
      final s = await svc(MockClient((req) async =>
          http.Response('{"accepted":true}', 201)));
      await s.queueFeedbackRetry(payload('x1'));
      await s.queueFeedbackRetry(payload('x2'));
      expect(await s.pendingFeedbackCount(), 2);
      expect(await s.flushFeedbackQueue(), 2);
      expect(await s.pendingFeedbackCount(), 0);
    });

    test('stop-at-first-failure: A delivered, B fails → returns 1 and keeps '
        '[B, C] in order', () async {
      final seen = <String>[];
      final s = await svc(MockClient((req) async {
        final body = jsonDecode(req.body!) as Map<String, dynamic>;
        final id = body['batch_id'] as String;
        seen.add(id);
        return id == 'B' || id == 'C'
            ? http.Response('still offline', 503)
            : http.Response('{"accepted":true}', 201);
      }));
      await s.queueFeedbackRetry(payload('A'));
      await s.queueFeedbackRetry(payload('B'));
      await s.queueFeedbackRetry(payload('C'));

      expect(await s.flushFeedbackQueue(), 1);
      expect(seen, ['A', 'B'],
          reason: 'flush stops at the FIRST failure — no hammering C');
      final remaining =
          (await rawQueue()).map((e) => (e as Map)['batch_id']).toList();
      expect(remaining, ['B', 'C'], reason: 'failed + untried keep FIFO order');

      // Recovery: signal returns → the preserved queue drains fully.
      final sOk = await svc(MockClient((req) async =>
          http.Response('{"accepted":true}', 201)));
      expect(await sOk.flushFeedbackQueue(), 2);
      expect(await sOk.pendingFeedbackCount(), 0);
    });

    test('empty queue flushes to zero without touching the network', () async {
      var hits = 0;
      final s = await svc(MockClient((req) async {
        hits++;
        return http.Response('{}', 200);
      }));
      expect(await s.flushFeedbackQueue(), 0);
      expect(hits, 0);
    });

    test('corrupt queue string starts clean instead of crashing the pilot flow',
        () async {
      SharedPreferences.setMockInitialValues({queueKey: 'not-json['});
      final s = await svc(MockClient((req) async =>
          http.Response('{"accepted":true}', 201)));
      expect(await s.pendingFeedbackCount(), 0);
      expect(await s.flushFeedbackQueue(), 0);
    });
  });
}
