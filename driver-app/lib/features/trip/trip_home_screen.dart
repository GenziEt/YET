import 'package:flutter/material.dart';

import '../../core/sync/sync_worker.dart';
import '../../l10n/app_localizations.dart';
import '../consent/consent_repository.dart';

/// Phase 1 trip screen. §1.2: max 3 taps to start a trip — here it is
/// ONE tap once permissions are set. GPS collection feeds the SQLite cache;
/// the pending-sync counter binds live to [SyncWorker.pendingCount] (§1.8.1).
class TripHomeScreen extends StatefulWidget {
  const TripHomeScreen({
    super.key,
    required this.consent,
    required this.onToggleLocale,
    this.sync,
  });
  final ConsentRepository consent;
  final VoidCallback onToggleLocale;

  /// Null in tests / before the cache has opened; UI then shows the local
  /// placeholder value and no cadence is started.
  final SyncWorker? sync;

  @override
  State<TripHomeScreen> createState() => _TripHomeScreenState();
}

class _TripHomeScreenState extends State<TripHomeScreen> {
  bool _tripActive = false;
  int _pendingSyncCount = 0; // fallback when no worker wired yet

  @override
  void initState() {
    super.initState();
    widget.sync?.pendingCount.addListener(_onPendingChanged);
    // Reflect current backlog as soon as the screen opens (app-foreground
    // trigger of the Offline Contract state machine).
    widget.sync?.refreshPendingCount();
  }

  @override
  void didUpdateWidget(covariant TripHomeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.sync != widget.sync) {
      oldWidget.sync?.pendingCount.removeListener(_onPendingChanged);
      widget.sync?.pendingCount.addListener(_onPendingChanged);
      widget.sync?.refreshPendingCount();
    }
  }

  void _onPendingChanged() {
    if (!mounted) return;
    setState(() => _pendingSyncCount = widget.sync!.pendingCount.value);
  }

  @override
  void dispose() {
    widget.sync?.pendingCount.removeListener(_onPendingChanged);
    super.dispose();
  }

  void _toggleTrip() {
    final sync = widget.sync;
    setState(() => _tripActive = !_tripActive);
    // §1.8.1: 60 s cadence only while a trip is active; ending pushes the tail.
    if (sync != null) {
      if (_tripActive) {
        sync.startTripCadence();
      } else {
        sync.stopTripCadence();
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.appTitle),
        actions: [TextButton(onPressed: widget.onToggleLocale, child: Text(l.languageToggle))],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l.tripReadyTitle, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              // Offline banner placeholder — driven by connectivity_plus stream in P4.
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.amber.shade100, borderRadius: BorderRadius.circular(8)),
                child: Text(l.pendingSync(_pendingSyncCount), style: const TextStyle(fontSize: 16)),
              ),
              const Spacer(),
              FilledButton(
                onPressed: _toggleTrip,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(88),
                  backgroundColor: _tripActive ? Colors.red.shade700 : Colors.green.shade700,
                  textStyle: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
                ),
                child: Text(_tripActive ? l.endTrip : l.startTrip),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
