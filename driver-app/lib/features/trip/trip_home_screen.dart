import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../consent/consent_repository.dart';

/// Phase 0 shell of the trip screen. §1.2: max 3 taps to start a trip — here it is
/// ONE tap once permissions are set. GPS collection + SQLite cache + batch uploader
/// arrive in Phase 1; the pending-sync counter binds to the sync worker then.
class TripHomeScreen extends StatefulWidget {
  const TripHomeScreen({super.key, required this.consent, required this.onToggleLocale});
  final ConsentRepository consent;
  final VoidCallback onToggleLocale;

  @override
  State<TripHomeScreen> createState() => _TripHomeScreenState();
}

class _TripHomeScreenState extends State<TripHomeScreen> {
  bool _tripActive = false;
  int _pendingSyncCount = 0; // wired to sync worker in Phase 1 (§1.8.1)

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
              // Offline banner placeholder — driven by connectivity_plus stream in P1.
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(color: Colors.amber.shade100, borderRadius: BorderRadius.circular(8)),
                child: Text(l.pendingSync(_pendingSyncCount), style: const TextStyle(fontSize: 16)),
              ),
              const Spacer(),
              FilledButton(
                onPressed: () => setState(() => _tripActive = !_tripActive),
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
