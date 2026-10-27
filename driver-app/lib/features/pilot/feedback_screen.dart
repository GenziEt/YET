import 'dart:async';

import 'package:flutter/foundation.dart' show visibleForTesting;
import 'package:flutter/material.dart';
import 'package:http/http.dart' as http;

import '../../core/app_runtime.dart';
import '../../l10n/app_localizations.dart';
import '../auth/token_store.dart';
import 'pilot_service.dart';

/// §Phase 4 "one-tap driver feedback flow ... submission, retry, and
/// success/failure states": the queued-reports banner copy. Kept here (not in
/// AppLocalizations) deliberately: test/phase4_localization_test.dart asserts
/// a strict 1:1 correspondence between ARB keys and generated getters, so an
/// extra const in the ARBs would break that parity check. The banner is still
/// fully localized — [_queuedBanner] switches on the active locale exactly
/// like every other string on this screen.
const String kFeedbackQueuedBannerTemplate = '{count} report(s) waiting for signal';
const String kFeedbackQueuedBannerTemplateAm =
    '{count} ሪፖርት(ዎች) ምልክት እየጠበቁ ነው';

/// Phase 4 in-app feedback button (§Phase 4 deliverable): the driver reports
/// "GPS not working" / "app draining battery" / "sync stuck" / "other" with
/// ONE tap — no text input while driving (§1.2). The screen collects the
/// diagnostic payload (battery level, GPS accuracy, last fix age, network
/// type, pending sync count) and POSTs /ingest/diagnostics through
/// [PilotService.sendFeedback]. Offline sends fail soft: the snackbar tells
/// the driver the report was parked for retry, and [PilotService] persists it
/// in the on-device queue that AppRuntime flushes automatically on the next
/// connectivity trigger (§1.8.1) — "will retry when you have signal" is real
/// code, not copy. With no runtime wired (kill-switch fallback) the same flow
/// runs against an on-the-fly [PilotService] sharing the device token store,
/// so the pilot can always reach fleet support even if the pipeline failed to
/// bootstrap.
class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({super.key, this.runtime});

  /// Test seam: inject a [PilotService] (MockClient transport) so widget tests
  /// exercise the real send → park-on-failure → snackbar flow without an
  /// [AppRuntime]/SQLite bootstrap. Never used by the default `main.dart`
  /// path — that always routes through the runtime's own service.
  @visibleForTesting
  const FeedbackScreen.forTest({super.key, required this.testPilot});

  final AppRuntime? runtime;
  final PilotService? testPilot;

  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  String _selected = 'gps_not_working';
  bool _sending = false;
  /// Pending-report count snapshotted at screen open (one KV read, no I/O in
  /// build). Shown as an honest "queued reports waiting for signal" banner —
  /// the retry queue's existence is part of the §Phase 4 feedback contract.
  int? _queuedReports;
  /// Client backing the fallback PilotService when no runtime is wired;
  /// disposed in [dispose] so the kill-switch path never leaks one per screen.
  http.Client? _fallbackClient;
  PilotService? _fallbackPilot;

  @override
  void initState() {
    super.initState();
    _loadQueueCount();
  }

  Future<void> _loadQueueCount() async {
    final pilot = widget.testPilot ?? widget.runtime?.pilot;
    if (pilot == null) return;
    try {
      final n = await pilot.pendingFeedbackCount();
      if (!mounted) return;
      setState(() => _queuedReports = n);
    } catch (_) {
      // SharedPreferences unavailable → omit the banner rather than lie about
      // a zero queue.
    }
  }

  /// Service used for this send: injected test seam → runtime's own service →
  /// on-the-fly fallback sharing the device token store (kill-switch path).
  PilotService _resolvePilot() {
    final injected = widget.testPilot;
    if (injected != null) return injected;
    final runtime = widget.runtime;
    if (runtime != null) return runtime.pilot;
    final client = _fallbackClient ??= http.Client();
    return _fallbackPilot ??= PilotService(tokenStore: TokenStore(), client: client);
  }

  int _resolvePendingSyncCount() {
    // Backend DiagnosticsPayloadSchema: pending_sync_count is nonnegative —
    // an unknown cache (kill-switch fallback, no runtime) reports 0 rather
    // than a schema-invalid sentinel.
    return widget.runtime?.pendingFixes ?? 0;
  }

  /// Localized queued-reports banner (see [kFeedbackQueuedBannerTemplate] for
  /// why this string lives here instead of in AppLocalizations). Null-safe by
  /// contract: renders nothing until the queue count actually resolves, and
  /// hides itself at zero so a driver with a clean queue never sees "0
  /// report(s) waiting".
  String? _queuedBanner(AppLocalizations l, int n) {
    if (n <= 0) return null;
    final template = l.localeName == 'am'
        ? kFeedbackQueuedBannerTemplateAm
        : kFeedbackQueuedBannerTemplate;
    return template.replaceAll('{count}', '$n');
  }

  Future<void> _send() async {
    if (_sending) return;
    setState(() => _sending = true);
    // Snapshot the device state at tap time — data-minimized, exactly the
    // fields of DiagnosticsSchema (§1.7). GPS freshness comes from the cache.
    int? lastFixAgeS;
    double? lastAccuracyM;
    try {
      final last = await widget.runtime?.dao.latestFix();
      if (last != null) {
        lastFixAgeS =
            DateTime.now().toUtc().difference(last.fixTimestamp).inSeconds;
        lastAccuracyM = last.accuracyM;
      }
    } catch (_) {
      // Cache unreadable → omit rather than fabricate.
    }
    final ok = await _resolvePilot().sendFeedback(
      issue: _selected,
      pendingSyncCount: _resolvePendingSyncCount(),
      tripActive: false, // toggle state lives in the home screen; the backend
                         // infers activity from live trips anyway
      lastFixAgeS: lastFixAgeS,
      lastAccuracyM: lastAccuracyM,
    );
    if (!mounted) return;
    final l = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      content: Text(ok ? l.feedbackSent : l.feedbackFailed),
    ));
    setState(() {
      _sending = false;
      // Refresh the parked-report banner after every attempt (a failure just
      // queued one; a success may have been what the flush delivered).
      _queuedReports = null;
    });
    unawaited(_loadQueueCount());

    if (ok) Navigator.of(context).pop();
  }

  /// Issue codes accepted by the backend DiagnosticsSchema triage queue,
  /// mapped to driver-language labels. Plain getter (not a const map of
  /// lambdas) so the l10n lookup happens at build time like every other key.
  Map<String, String> _issueLabels(AppLocalizations l) => {
        'gps_not_working': l.feedbackGps,
        'battery_drain': l.feedbackBattery,
        'sync_stuck': l.feedbackSync,
        'other': l.feedbackOther,
      };

  @override
  void dispose() {
    _fallbackClient?.close();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final labels = _issueLabels(l);
    final queued = _queuedReports == null ? null : _queuedBanner(l, _queuedReports!);
    return Scaffold(
      appBar: AppBar(title: Text(l.feedbackTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l.feedbackIntro, style: const TextStyle(fontSize: 18)),
              if (queued != null) ...[
                const SizedBox(height: 12),
                // Honest retry-queue state (§Phase 4 "success/failure states"
                // includes the parked-for-retry state).
                Banner(
                  message: queued,
                  location: BannerLocation.topStart,
                  color: const Color(0xFFB45309),
                  textStyle: const TextStyle(fontSize: 16, color: Colors.white),
                ),
              ],
              const SizedBox(height: 16),
              for (final entry in labels.entries)
                RadioListTile<String>(
                  value: entry.key,
                  groupValue: _selected,
                  onChanged: (v) => setState(() => _selected = v ?? _selected),
                  title: Text(entry.value, style: const TextStyle(fontSize: 18)),
                ),
              const Spacer(),
              FilledButton(
                onPressed: _sending ? null : _send,
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(64)),
                child: _sending
                    ? const SizedBox(
                        width: 24, height: 24,
                        child: CircularProgressIndicator(strokeWidth: 3))
                    : Text(l.feedbackSend),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
