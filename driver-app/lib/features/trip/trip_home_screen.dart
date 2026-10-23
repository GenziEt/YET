import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
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
    this.runtime,
  });
  final ConsentRepository consent;
  final VoidCallback onToggleLocale;

  /// Null in tests / before the cache has opened; UI then shows the local
  /// placeholder value and no cadence is started.
  final SyncWorker? sync;

  /// Composition root (Phase 1). When present, the Start/End button drives
  /// BOTH the 60 s sync cadence and GPS duty-cycling through it, and the
  /// foreground trigger of §1.8.1 fires on app resume. [sync] remains the
  /// source of the pending counter so tests can wire the worker alone.
  final AppRuntime? runtime;

  @override
  State<TripHomeScreen> createState() => _TripHomeScreenState();
}

class _TripHomeScreenState extends State<TripHomeScreen>
    with WidgetsBindingObserver {
  bool _tripActive = false;
  int _pendingSyncCount = 0; // fallback when no worker wired yet

  SyncWorker? get _worker => widget.sync ?? widget.runtime?.worker;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _worker?.pendingCount.addListener(_onPendingChanged);
    // Reflect current backlog as soon as the screen opens (app-foreground
    // trigger of the Offline Contract state machine).
    _worker?.refreshPendingCount();
  }

  @override
  void didUpdateWidget(covariant TripHomeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    final oldWorker = oldWidget.sync ?? oldWidget.runtime?.worker;
    if (oldWorker != _worker) {
      oldWorker?.pendingCount.removeListener(_onPendingChanged);
      _worker?.pendingCount.addListener(_onPendingChanged);
      _worker?.refreshPendingCount();
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // §1.8.1 trigger #1: app came to foreground -> immediate sync cycle.
    if (state == AppLifecycleState.resumed) {
      if (widget.runtime != null) {
        widget.runtime!.onAppForeground();
      } else {
        _worker?.onAppForeground();
      }
    }
  }

  void _onPendingChanged() {
    if (!mounted) return;
    setState(() => _pendingSyncCount = _worker?.pendingCount.value ?? 0);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _worker?.pendingCount.removeListener(_onPendingChanged);
    super.dispose();
  }

  void _toggleTrip() {
    final runtime = widget.runtime;
    setState(() => _tripActive = !_tripActive);
    if (runtime != null) {
      // One tap starts GPS + cadence together, ends both + flushes the tail.
      runtime.onTripToggled(active: _tripActive);
      return;
    }
    final sync = widget.sync;
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
