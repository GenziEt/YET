import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import '../consent/consent_repository.dart';

/// "Permissions needed" explainer (§Phase 0 deliverable): WHY background location
/// and battery exemption are required, in driver language, before any system dialog.
/// Actual permission requests land in Phase 1 with geolocator; this screen sets
/// expectations and gates the flow. Android Doze/vendor-ROM guidance lives here too.
class PermissionsScreen extends StatelessWidget {
  const PermissionsScreen({super.key, required this.repo, required this.onDone});
  final ConsentRepository repo;
  final VoidCallback onDone;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.permTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.share_location, size: 64, color: Colors.green),
              const SizedBox(height: 12),
              Text(l.permLocationBody, style: const TextStyle(fontSize: 18, height: 1.4)),
              const SizedBox(height: 20),
              const Icon(Icons.battery_charging_full, size: 64, color: Colors.orange),
              const SizedBox(height: 12),
              Text(l.permBatteryBody, style: const TextStyle(fontSize: 18, height: 1.4)),
              const Spacer(),
              FilledButton.tonal(
                onPressed: () {
                  // Phase 1: launch intent to Settings (location & battery pages).
                  // Kept as explainer-only at Phase 0 per blueprint deliverable.
                },
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                child: Text(l.permContinue),
              ),
              const SizedBox(height: 10),
              FilledButton(
                onPressed: () async {
                  await repo.acknowledgePermissions();
                  onDone();
                },
                style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(56)),
                child: Text(l.permDone),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
