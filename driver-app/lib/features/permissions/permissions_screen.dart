import 'package:flutter/material.dart';

import '../../core/theme/yet_theme.dart';
import '../../core/widgets/status_chip.dart';
import '../../l10n/app_localizations.dart';
import '../consent/consent_repository.dart';

/// "Permissions needed" explainer (§Phase 0 deliverable): WHY background location
/// and battery exemption are required, in driver language, before any system dialog.
/// Actual permission requests land in Phase 1 with geolocator; this screen sets
/// expectations and gates the flow. Android Doze/vendor-ROM guidance lives here too.
class PermissionsScreen extends StatelessWidget {
  const PermissionsScreen({
    super.key,
    required this.repo,
    required this.onDone,
    this.requestBatteryExemption = true,
    this.openPhoneSettings,
  });
  final ConsentRepository repo;
  final VoidCallback onDone;

  /// Phase 4 flag: when false the "Open phone settings" button stays a pure
  /// explainer (used by widget tests / devices where we deliberately do not
  /// fire platform intents).
  final bool requestBatteryExemption;

  /// Battery-optimization exemption seam (§Phase 4: "request ignore battery
  /// optimizations on Android"). Production main.dart injects an adapter over
  /// `MethodChannel('yet.dev/battery_exemption')` — the device-side Kotlin
  /// handler fires ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (manifest needs
  /// REQUEST_IGNORE_BATTERY_OPTIMIZATIONS) and opens Location settings for
  /// "Allow all the time"; see docs/PILOT-RUNBOOK.md for the manual fallback.
  /// Kept as an injected callback instead of a direct channel/plugin import so
  /// this package stays plugin-free and analyze/test runs need no platform.
  final Future<void> Function()? openPhoneSettings;

  void _onContinueTap(BuildContext context) {
    if (!requestBatteryExemption) return;
    openPhoneSettings?.call();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(AppLocalizations.of(context).permBatteryBody)),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      // Same branded onboarding composition as the consent screen — the two
      // gate screens now read as one flow instead of two disconnected forms.
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth > 720;
            return Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints:
                    BoxConstraints(maxWidth: wide ? 640 : double.infinity),
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    GradientHeader(title: l.permTitle, subtitle: l.permIntro),
                    Padding(
                      padding: EdgeInsets.symmetric(
                          horizontal: wide ? 32 : 20, vertical: 20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _step(
                            index: '1',
                            icon: Icons.share_location_rounded,
                            heading: l.permLocationHeading,
                            body: l.permLocationBody,
                          ),
                          _step(
                            index: '2',
                            icon: Icons.battery_charging_full_rounded,
                            heading: l.permBatteryHeading,
                            body: l.permBatteryBody,
                          ),
                          const SizedBox(height: 8),
                          FilledButton.tonalIcon(
                            onPressed: () => _onContinueTap(context),
                            icon: const Icon(Icons.settings_rounded),
                            label: Text(l.permContinue),
                            style: FilledButton.styleFrom(
                                minimumSize: const Size.fromHeight(56)),
                          ),
                          const SizedBox(height: 12),
                          FilledButton.icon(
                            onPressed: () async {
                              await repo.acknowledgePermissions();
                              onDone();
                            },
                            icon: const Icon(Icons.check_rounded),
                            label: Text(l.permDone),
                            style: FilledButton.styleFrom(
                                minimumSize: const Size.fromHeight(56)),
                          ),
                          const SizedBox(height: 10),
                          Center(
                            child: Text(
                              l.permSkipHint,
                              style: const TextStyle(
                                  fontSize: 14, color: YetTheme.inkSoft),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }

  /// Numbered step card — turns a wall of permission copy into a 1-2 checklist
  /// drivers can skim in under ten seconds (Mobbin onboarding best practice).
  Widget _step({
    required String index,
    required IconData icon,
    required String heading,
    required String body,
  }) =>
      Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: SoftCard(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: YetTheme.primary.withOpacity(0.10),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Icon(icon, color: YetTheme.primary, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Text(
                          '$index',
                          style: const TextStyle(
                              fontSize: 13,
                              fontWeight: FontWeight.w800,
                              color: YetTheme.primary),
                        ),
                        const SizedBox(width: 6),
                        Flexible(
                          child: Text(heading,
                              style: const TextStyle(
                                  fontSize: 17,
                                  fontWeight: FontWeight.w700,
                                  color: YetTheme.ink)),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(body,
                        style: const TextStyle(
                            fontSize: 15.5,
                            height: 1.45,
                            color: YetTheme.inkSoft)),
                  ],
                ),
              ),
            ],
          ),
        ),
      );
}
