import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'onboarding_repository.dart';

/// Post-registration status screen + the "always logged in" hold states.
///
/// Shown when:
///  * registration just finished (status PENDING_REVIEW) — driver waits for an
///    admin to verify documents and move them into a real fleet;
///  * launch finds a paired session whose account is ACTIVE but was suspended
///    meanwhile (`account_suspended` / `fleet_suspended` from any API call).
///
/// The app NEVER asks for credentials here: the device stays paired, so as
/// soon as the admin approves, "Check status" (or simply launching the app)
/// moves straight into the trip flow.
class PendingReviewScreen extends StatefulWidget {
  const PendingReviewScreen({
    super.key,
    required this.repo,
    required this.onReady,
    this.suspended = false,
    this.nextSteps = const [],
  });

  final OnboardingRepository repo;
  /// Called when GET /me/profile reports registration_status == 'ACTIVE'.
  final VoidCallback onReady;
  final bool suspended;
  final List<String> nextSteps;

  @override
  State<PendingReviewScreen> createState() => _PendingReviewScreenState();
}

class _PendingReviewScreenState extends State<PendingReviewScreen> {
  bool _busy = false;
  String? _note;

  Future<void> _check() async {
    final l = AppLocalizations.of(context);
    setState(() {
      _busy = true;
      _note = null;
    });
    try {
      final profile = await widget.repo.fetchProfile();
      if (!mounted) return;
      final status = profile['registration_status'] as String?;
      if (status == 'ACTIVE') {
        widget.onReady();
      } else {
        setState(() => _note = l.obPendingBody);
      }
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() => _note = e.code == 'network_error' ? l.obNetworkError : l.obPendingBody);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(28),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Icon(widget.suspended ? Icons.lock_clock : Icons.hourglass_top_rounded,
                    size: 72,
                    color: Theme.of(context).colorScheme.primary),
                const SizedBox(height: 16),
                Text(
                  widget.suspended ? l.obSuspendedTitle : l.obPendingTitle,
                  textAlign: TextAlign.center,
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const SizedBox(height: 12),
                Text(
                  widget.suspended ? l.obSuspendedBody : l.obPendingBody,
                  textAlign: TextAlign.center,
                ),
                if (!widget.suspended && widget.nextSteps.isNotEmpty) ...[
                  const SizedBox(height: 16),
                  ...widget.nextSteps.map((s) => Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text('• '),
                            Expanded(child: Text(s)),
                          ],
                        ),
                      )),
                ],
                if (_note != null) ...[
                  const SizedBox(height: 16),
                  Text(_note!, textAlign: TextAlign.center),
                ],
                const SizedBox(height: 28),
                FilledButton(
                  onPressed: _busy || widget.suspended ? null : _check,
                  child: Padding(
                    padding: const EdgeInsets.symmetric(vertical: 14),
                    child: Text(l.obRefreshApp),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
