import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../core/sync/sync_worker.dart';
import '../../core/theme/yet_theme.dart';
import '../../core/widgets/status_chip.dart';
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

  /// Banner copy for the last toggle outcome; null = show nothing. The string
  /// itself is localized via ARB keys ([AppLocalizations.tripStartConfirm] /
  /// [AppLocalizations.tripVehicleNone]); the tone + icon pair below keeps the
  /// §Phase 4 hard-gate states visually honest (green confirm vs red block).
  (String, StatusTone, IconData)? _assignmentBanner(AppLocalizations l) {
    switch (_assignment) {
      case AssignmentCheck.confirmed:
        if (!_tripActive) return null; // stale confirm after an end tap
        final v = widget.runtime?.pilot.cachedAssignment;
        return v == null
            ? null
            : (l.tripStartConfirm(v.label), StatusTone.ok, Icons.check_circle_outline);
      case AssignmentCheck.noVehicle:
        // Hard-gated start: server says no assignment — tell the driver to
        // call the fleet manager instead of collecting doomed fixes.
        return (l.tripVehicleNone, StatusTone.error, Icons.error_outline);
      case AssignmentCheck.offlineCached:
        // Allowed via cache; no banner — never nag an offline driver (§1.8).
        return null;
      case AssignmentCheck.offlineUnknown:
        if (_tripActive) return null; // end tap returns this sentinel silently
        // Blocked fresh start with zero connectivity: nothing proves an
        // assignment exists. Same actionable copy as noVehicle — the driver
        // must reach their fleet manager either way.
        return (l.tripVehicleNone, StatusTone.error, Icons.wifi_off_rounded);
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
          Padding(
            padding: const EdgeInsets.only(right: 8),
            child: TextButton(
              style: TextButton.styleFrom(foregroundColor: YetTheme.onPrimary),
              onPressed: widget.onToggleLocale,
              child: Text(l.languageToggle),
            ),
          ),
        ],
      ),
      // §5.2 flattening contract: the boot-critical body lives in _body() and
      // is measured by test/startup_flattening_test.dart against a hard depth
      // budget — keep new nesting out of that tree.
      body: SafeArea(child: Builder(builder: (context) => _body(context, AppLocalizations.of(context)))),
    );
  }

  Widget _body(BuildContext context, AppLocalizations l) {
    final banner = _assignmentBanner(l);
    // Sync pill: live backlog count from the local cache; zero → calm green.
    final syncTone = _pendingSyncCount > 0 ? StatusTone.warn : StatusTone.ok;
    final syncLabel = _pendingSyncCount > 0
        ? l.syncRecordsPending(_pendingSyncCount)
        : l.syncAllSynced;
    return LayoutBuilder(
          builder: (context, constraints) {
            // Responsive: generous centered column on tablets/wide screens,
            // edge-to-edge on phones — no stretched buttons on a 7" tablet.
            final wide = constraints.maxWidth > 720;
            return Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: wide ? 640 : double.infinity),
                child: Padding(
                  padding: EdgeInsets.symmetric(
                      horizontal: wide ? 32 : 20, vertical: 20),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      // ── Hero status card: greeting + live state + sync pill.
                      // Row layout (not nested Columns) keeps this boot-critical
                      // frame inside the §5.2 flattening budget.
                      SoftCard(
                        padding: const EdgeInsets.all(18),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            // Accent rail — quiet brand moment on the idle frame;
                            // turns tracking-red while a trip is live.
                            Container(
                              width: 4,
                              height: 56,
                              margin: const EdgeInsets.only(right: 14),
                              decoration: BoxDecoration(
                                color: _tripActive
                                    ? YetTheme.tracking
                                    : YetTheme.primary,
                                borderRadius: BorderRadius.circular(999),
                              ),
                            ),
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    l.tripGreeting,
                                    style: TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                      color: YetTheme.inkSoft,
                                      letterSpacing: 0.2,
                                    ),
                                  ),
                                  const SizedBox(height: 4),
                                  Text(
                                    l.tripReadyTitle,
                                    style: const TextStyle(
                                      fontSize: 26,
                                      fontWeight: FontWeight.w800,
                                      color: YetTheme.ink,
                                      height: 1.15,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 10),
                            // Live-state pill rides beside the headline so the
                            // driver reads state at a glance, not below it.
                            StatusChip(
                                icon: _tripActive
                                    ? Icons.navigation_rounded
                                    : Icons.circle_outlined,
                                label: _tripActive
                                    ? l.tripStatusTracking
                                    : l.tripStatusReady,
                                tone: _tripActive
                                    ? StatusTone.error
                                    : StatusTone.ok,
                                dense: true,
                              ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 10),
                      // Sync pill on its own quiet row: backlog count is the
                      // one number ops watches, so it never wraps mid-count.
                      // (Stretch column → left-aligned; no extra layout pass.)
                      StatusChip(
                        icon: _pendingSyncCount > 0
                            ? Icons.sync_rounded
                            : Icons.cloud_done_rounded,
                        label: syncLabel,
                        tone: syncTone,
                        dense: true,
                      ),
                      // One-tap Start Trip vehicle-assignment confirmation alert.
                      if (banner != null) ...[
                        const SizedBox(height: 12),
                        InlineAlert(
                          icon: banner.$3,
                          message: banner.$1,
                          tone: banner.$2,
                        ),
                      ],
                      const Spacer(),
                      FilledButton(
                        onPressed: _toggling ? null : _toggleTrip,
                        style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(92),
                          backgroundColor: _tripActive
                              ? YetTheme.tracking
                              : YetTheme.idle,
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(24)),
                          textStyle: const TextStyle(
                              fontSize: 26,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 1.2),
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
          },
    );
  }
}
