import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../core/sync/sync_worker.dart';
import '../../l10n/app_localizations.dart';
import '../consent/consent_repository.dart';
import '../pilot/feedback_screen.dart';
import '../pilot/offline_map_screen.dart';
import '../pilot/pilot_service.dart' show AssignmentCheck, allowsTripStart;

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

  /// Null in tests / before the cache has opened; UI then shows the cached
  /// queue-count default and no upload cadence is started.
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
  /// Result of the most recent trip-toggle attempt (one-tap GET /me vehicle
  /// assignment confirm, §Phase 4 hard gate).
  AssignmentCheck _assignment = AssignmentCheck.offlineUnknown;

  /// Banner text for the last toggle outcome; null = show nothing.
  ///
  /// The §Phase 4 hard gate means a BLOCKED start never flips [the trip] to
  /// active — so blocked banners ([AssignmentCheck.noVehicle],
  /// [AssignmentCheck.offlineUnknown]) show regardless of `_tripActive`, and
  /// success banners only make sense while actually tracking.
  String? _assignmentBanner(AppLocalizations l) {
    switch (_assignment) {
      case AssignmentCheck.confirmed:
        if (!_tripActive) return null; // stale confirm after an end tap
        final v = widget.runtime?.pilot.cachedAssignment;
        return v == null ? null : l.tripStartConfirm(v.label);
      case AssignmentCheck.noVehicle:
        // Hard-gated start: server says no assignment — tell the driver to
        // call the fleet manager instead of collecting doomed fixes.
        return l.tripVehicleNone;
      case AssignmentCheck.offlineCached:
        // Allowed via cache; no banner — never nag an offline driver (§1.8).
        return null;
      case AssignmentCheck.offlineUnknown:
        if (_tripActive) return null; // end tap returns this sentinel silently
        // Blocked fresh start with zero connectivity: nothing proves an
        // assignment exists. Same actionable copy as noVehicle — the driver
        // must reach their fleet manager either way.
        return l.tripVehicleNone;
    }
  }

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

  /// True while the async assignment confirm of a START tap is in flight —
  /// guards against double-taps starting two cadences.
  bool _toggling = false;

  Future<void> _toggleTrip() async {
    if (_toggling) return;
    final runtime = widget.runtime;
    if (runtime != null) {
      if (!_tripActive) {
        // START: run the §Phase 4 hard gate FIRST. AppRuntime returns the
        // AssignmentCheck without collecting anything when the gate blocks,
        // so the UI must NOT flip to "END TRIP" on a blocked start — the
        // driver stays on the honest idle button plus the actionable banner.
        setState(() => _toggling = true);
        final check = await runtime.onTripToggled(active: true);
        if (!mounted) return;
        setState(() {
          _toggling = false;
          _assignment = check;
          if (allowsTripStart(check)) _tripActive = true;
        });
        return;
      }
      // END: never blocked by assignment state (allowsTripEnd == true) — a
      // driver whose assignment lapsed mid-trip must always be able to stop
      // collection and flush the cache (§1.8 "no data loss on transitions").
      setState(() => _tripActive = false);
      final check = await runtime.onTripToggled(active: false);
      if (!mounted) return;
      setState(() => _assignment = check);
      return;
    }
    // No runtime wired (tests / kill-switch fallback): plain UI + cadence.
    setState(() => _tripActive = !_tripActive);
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
    final banner = _assignmentBanner(l);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.appTitle),
        actions: [
          // Phase 4 in-app feedback: one nav hop, chips only, no typing (§1.2).
          IconButton(
            icon: const Icon(Icons.feedback_outlined),
            tooltip: l.feedbackTitle,
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => FeedbackScreen(runtime: widget.runtime),
            )),
          ),
          // Phase 4 offline-map pre-download for the pilot region (§1.6:
          // driver app must work without signal in remote areas).
          IconButton(
            icon: const Icon(Icons.map_outlined),
            tooltip: l.offlineMapTitle,
            onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
              builder: (_) => OfflineMapScreen(runtime: widget.runtime),
            )),
          ),
          TextButton(onPressed: widget.onToggleLocale, child: Text(l.languageToggle)),
        ],
      ),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l.tripReadyTitle, style: Theme.of(context).textTheme.headlineSmall),
              const SizedBox(height: 8),
              // Offline/pending-sync banner: count comes from the real local
              // cache via AppRuntime.pendingFixes (SyncWorker.pendingCount).
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.amber.shade100, borderRadius: BorderRadius.circular(8)),
                child: Text(l.pendingSync(_pendingSyncCount), style: const TextStyle(fontSize: 16)),
              ),
              // One-tap Start Trip vehicle-assignment confirmation banner.
              if (banner != null) ...[
                const SizedBox(height: 8),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: _assignment == AssignmentCheck.noVehicle
                        ? Colors.red.shade100
                        : Colors.green.shade100,
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(banner, style: const TextStyle(fontSize: 16)),
                ),
              ],
              const Spacer(),
              FilledButton(
                onPressed: _toggling ? null : _toggleTrip,
                style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(88),
                  backgroundColor: _tripActive ? Colors.red.shade700 : Colors.green.shade700,
                  textStyle: const TextStyle(fontSize: 26, fontWeight: FontWeight.bold),
                ),
                child: _toggling
                    ? const SizedBox(
                        width: 28, height: 28,
                        child: CircularProgressIndicator(
                            strokeWidth: 3, color: Colors.white))
                    : Text(_tripActive ? l.endTrip : l.startTrip),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
