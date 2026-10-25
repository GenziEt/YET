import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../l10n/app_localizations.dart';

/// Phase 4 in-app feedback button (§Phase 4 deliverable): the driver reports
/// "GPS not working" / "app draining battery" / "sync stuck" / "other" with
/// ONE tap — no text input while driving (§1.2). The screen collects the
/// diagnostic payload (battery level, GPS accuracy, last fix age, network
/// type, pending sync count) and POSTs /ingest/diagnostics through
/// [PilotService.sendFeedback]. Offline sends fail soft: the snackbar tells
/// the driver it didn't go through; nothing is auto-retried (diagnostics are
/// point-in-time — a stale one is worse than none).
class FeedbackScreen extends StatefulWidget {
  const FeedbackScreen({super.key, this.runtime});

  final AppRuntime? runtime;

  @override
  State<FeedbackScreen> createState() => _FeedbackScreenState();
}

class _FeedbackScreenState extends State<FeedbackScreen> {
  String _selected = 'gps_not_working';
  bool _sending = false;

  /// Issue codes accepted by the backend DiagnosticsSchema triage queue,
  /// mapped to driver-language labels. Plain getter (not a const map of
  /// lambdas) so the l10n lookup happens at build time like every other key.
  Map<String, String> _issueLabels(AppLocalizations l) => {
        'gps_not_working': l.feedbackGps,
        'battery_drain': l.feedbackBattery,
        'sync_stuck': l.feedbackSync,
        'other': l.feedbackOther,
      };

  Future<void> _send() async {
    final runtime = widget.runtime;
    if (runtime == null || _sending) return;
    setState(() => _sending = true);
    // Snapshot the device state at tap time — data-minimized, exactly the
    // fields of DiagnosticsSchema (§1.7). GPS freshness comes from the cache.
    int? lastFixAgeS;
    double? lastAccuracyM;
    try {
      final last = await runtime.dao.latestFix();
      if (last != null) {
        lastFixAgeS =
            DateTime.now().toUtc().difference(last.fixTimestamp).inSeconds;
        lastAccuracyM = last.accuracyM;
      }
    } catch (_) {
      // Cache unreadable → omit rather than fabricate.
    }
    final ok = await runtime.pilot.sendFeedback(
      issue: _selected,
      pendingSyncCount: runtime.pendingFixes,
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
    setState(() => _sending = false);
    if (ok) Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final labels = _issueLabels(l);
    return Scaffold(
      appBar: AppBar(title: Text(l.feedbackTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l.feedbackIntro, style: const TextStyle(fontSize: 18)),
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
