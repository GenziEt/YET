import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'consent_repository.dart';

/// PDPP-compliant consent screen in Amharic and English (§1.7).
/// Plain language, no legalese, explicit opt-in BEFORE any collection.
class ConsentScreen extends StatefulWidget {
  const ConsentScreen({
    super.key,
    required this.repo,
    required this.onAccepted,
    required this.onToggleLocale,
  });
  final ConsentRepository repo;
  final VoidCallback onAccepted;
  final VoidCallback onToggleLocale;

  @override
  State<ConsentScreen> createState() => _ConsentScreenState();
}

class _ConsentScreenState extends State<ConsentScreen> {
  bool _submitting = false;

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(
        title: Text(l.consentTitle),
        actions: [
          TextButton(onPressed: widget.onToggleLocale, child: Text(l.languageToggle)),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(l.consentBody, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 20),
            _section(l.consentCollectHeading, l.consentCollectBody),
            _section(l.consentWhoHeading, l.consentWhoBody),
            _section(l.consentRetentionHeading, l.consentRetentionBody),
            const SizedBox(height: 16),
            FilledButton(
              onPressed: _submitting
                  ? null
                  : () async {
                      setState(() => _submitting = true);
                      // Mandatory scopes only — engine-audio classification was
                      // removed from the product surface (Phase 2, Option B).
                      await widget.repo.accept(scopes: [
                        'location',
                        'motion',
                      ]);
                      if (context.mounted) widget.onAccepted();
                    },
              style: FilledButton.styleFrom(
                  minimumSize: const Size.fromHeight(64),
                  textStyle: const TextStyle(fontSize: 20)),
              child: Text(l.consentAgree),
            ),
            TextButton(
              onPressed: _submitting
                  ? null
                  : () async {
                      await widget.repo.decline();
                      if (context.mounted) {
                        ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(content: Text(l.consentDeclinedBody)));
                      }
                    },
              child: Text(l.consentDecline),
            ),
          ],
        ),
      ),
    );
  }

  Widget _section(String title, String body) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: Theme.of(context).textTheme.titleSmall?.copyWith(fontWeight: FontWeight.bold)),
          Text(body, style: const TextStyle(fontSize: 16, height: 1.4)),
        ]),
      );
}
