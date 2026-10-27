import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:yet_driver/core/config/app_config.dart';
import 'package:yet_driver/features/auth/token_store.dart';
import 'package:yet_driver/features/pilot/feedback_screen.dart';
import 'package:yet_driver/features/pilot/pilot_service.dart';
import 'package:yet_driver/l10n/app_localizations.dart';

/// §Phase 4 completion criterion: "One-tap driver feedback flow is complete
/// end to end, including submission, retry, and success/failure states."
///
/// test/phase4_feedback_retry_test.dart pins the PilotService queue contract;
/// this suite pins the SCREEN half of that contract — the driver-visible
/// behavior on top of it, exercised through FeedbackScreen.forTest with a
/// MockClient transport (no AppRuntime/SQLite bootstrap needed):
///  * SUCCESS: POST /ingest/diagnostics accepted → "Report sent" snackbar and
///    the screen POPS itself back to the trip home (one tap, no dead end);
///  * FAILURE: POST rejected → "Could not send — will retry when you have
///    signal" snackbar, the screen STAYS open (driver sees the honest state),
///    the payload is parked in the persistent queue, and the queued-reports
///    banner renders with the real count;
///  * clean queue → no banner (never shows "0 report(s) waiting");
///  * Amharic locale → every driver-visible string resolves in Ethiopic
///    script, including the failure copy and the localized banner.
void main() {
  const queueKey = 'pilot_feedback_queue_v1';

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    AppConfig.apiBaseUrl = 'http://127.0.0.1:9/api';
  });

  Future<PilotService> pilotWith(http.Handler handler) async {
    final ts = TokenStore();
    await ts.load();
    await ts.save(token: 'test-token');
    return PilotService(
      tokenStore: ts,
      client: MockClient(handler),
      // Sentinel -1 → battery fields omitted from the payload (no fake data).
      batteryReader: () async => const BatteryReading(levelPct: -1),
    );
  }

  Widget wrap(Widget child, {Locale locale = const Locale('en')}) =>
      MaterialApp(
        locale: locale,
        supportedLocales: AppLocalizations.supportedLocales,
        localizationsDelegates: const [AppLocalizations.delegate],
        home: child,
      );

  /// Pushes the screen inside a Navigator so a successful pop can be observed
  /// by checking that the placeholder route is visible again.
  Future<void> pumpFeedback(
      WidgetTester tester, PilotService pilot, {Locale locale = const Locale('en')}) async {
    await tester.pumpWidget(wrap(
      Builder(
        builder: (ctx) => Scaffold(
          body: Center(
            child: ElevatedButton(
              onPressed: () => Navigator.of(ctx).push(MaterialPageRoute<void>(
                  builder: (_) => FeedbackScreen.forTest(testPilot: pilot))),
              child: const Text('OPEN_FEEDBACK'),
            ),
          ),
        ),
      ),
      locale: locale,
    ));
    await tester.tap(find.text('OPEN_FEEDBACK'));
    await tester.pumpAndSettle();
    expect(find.text(AppLocalizations(locale.languageCode).feedbackTitle),
        findsOneWidget);
  }

  group('FeedbackScreen one-tap flow', () {
    testWidgets('success: POST accepted → feedbackSent snackbar + screen pops',
        (tester) async {
      Uri? posted;
      String? authHeader;
      final pilot = await pilotWith((req) async {
        posted = req.url;
        authHeader = req.headers['authorization'];
        return http.Response(jsonEncode({'status': 'received'}), 202,
            headers: {'content-type': 'application/json'});
      });

      await pumpFeedback(tester, pilot);

      await tester.tap(find.widgetWithText(FilledButton,
          AppLocalizations('en').feedbackSend));
      await tester.pump(); // send starts
      await tester.pumpAndSettle(); // snackbar + pop settle

      // Real request went out, authenticated, to the diagnostics endpoint.
      expect(posted?.path, '/ingest/diagnostics');
      expect(authHeader, 'Bearer test-token');

      // Success state: thank-you snackbar…
      expect(find.text(AppLocalizations('en').feedbackSent), findsOneWidget);
      // …and the screen popped itself back to the previous route.
      expect(find.text('OPEN_FEEDBACK'), findsOneWidget);
      expect(find.text(AppLocalizations('en').feedbackSend), findsNothing);
    });

    testWidgets('failure: POST rejected → feedbackFailed snackbar, stays open, '\n
        'payload parked, queued banner appears', (tester) async {
      var requests = 0;
      final pilot = await pilotWith((req) async {
        requests++;
        return http.Response('unavailable', 503);
      });

      await pumpFeedback(tester, pilot);

      await tester.tap(find.widgetWithText(FilledButton,
          AppLocalizations('en').feedbackSend));
      await tester.pump();
      await tester.pumpAndSettle();

      // Honest failure state: "will retry when you have signal" — backed by
      // the queue below, not just copy (see phase4_feedback_retry_test.dart).
      expect(find.text(AppLocalizations('en').feedbackFailed), findsOneWidget);

      // Screen did NOT pop — the driver keeps seeing the failure state.
      expect(requests, 1);
      expect(find.text(AppLocalizations('en').feedbackSend), findsOneWidget);

      // The payload really was parked for the connectivity-triggered flush.
      final sp = await SharedPreferences.getInstance();
      final queued = jsonDecode(sp.getString(queueKey) ?? '[]') as List;
      expect(queued.length, 1);
      expect(queued.single['issue'], 'gps_not_working'); // default selection

      // And the UI says so: queued-reports banner with the true count.
      // (Banner.message renders inside a Directionality — force layout so it
      // lands inside the test viewport before find.textContaining scans.)
      await tester.binding.setSurfaceSize(const Size(800, 1200));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpAndSettle();
      expect(find.textContaining('1 report(s) waiting for signal'),
          findsOneWidget);
    });

    testWidgets('clean queue: no banner shown at zero pending reports',
        (tester) async {
      final pilot = await pilotWith((req) async => http.Response('{}', 500));
      await pumpFeedback(tester, pilot);
      await tester.pumpAndSettle();
      expect(find.textContaining('waiting for signal'), findsNothing);
    });

    testWidgets('amharic locale: every driver-visible string is Ethiopic '\n
        '(default Amharic-first path has no English-only gap)', (tester) async {
      final l = AppLocalizations('am');
      final ethiopic = RegExp('[\\u0D00-\\u0D7F]');
      final pilot = await pilotWith((req) async => http.Response('x', 503));

      await tester.pumpWidget(wrap(
        Builder(
          builder: (ctx) => Scaffold(
            body: Center(
              child: ElevatedButton(
                onPressed: () => Navigator.of(ctx).push(MaterialPageRoute<void>(
                    builder: (_) => FeedbackScreen.forTest(testPilot: pilot))),
                child: const Text('OPEN_FEEDBACK'),
              ),
            ),
          ),
        ),
        locale: const Locale('am'),
      ));
      await tester.tap(find.text('OPEN_FEEDBACK'));
      await tester.pumpAndSettle();

      // Title, intro, all four issue labels, and the send button render in
      // Amharic on the first frame.
      for (final s in [
        l.feedbackTitle, l.feedbackIntro, l.feedbackGps, l.feedbackBattery,
        l.feedbackSync, l.feedbackOther, l.feedbackSend,
      ]) {
        expect(find.text(s), findsOneWidget, reason: 'missing Amharic "$s"');
        expect(ethiopic.hasMatch(s), isTrue,
            reason: '"$s" is not Ethiopic script');
      }

      await tester.tap(find.widgetWithText(FilledButton, l.feedbackSend));
      await tester.pump();
      await tester.pumpAndSettle();

      // Failure copy AND the queued banner are localized too.
      expect(find.text(l.feedbackFailed), findsOneWidget);
      expect(find.textContaining('ምልክት እየጠበቁ ነው'), findsOneWidget);
    });
  });
}
