import 'package:flutter/material.dart';

import '../../core/theme/yet_theme.dart';
import '../../core/widgets/status_chip.dart';
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
      // No AppBar: the branded gradient header carries title + locale toggle,
      // giving the consent flow a modern onboarding look (Dribble-style).
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final wide = constraints.maxWidth > 720;
            return Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: wide ? 640 : double.infinity),
                child: ListView(
                  padding: EdgeInsets.zero,
                  children: [
                    GradientHeader(
                      title: l.consentTitle,
                      subtitle: l.consentIntro,
                      trailing: TextButton(
                        style: TextButton.styleFrom(
                            foregroundColor: Colors.white,
                            backgroundColor: Colors.white.withOpacity(0.14)),
                        onPressed: widget.onToggleLocale,
                        child: Text(l.languageToggle),
                      ),
                    ),
                    Padding(
                      padding: EdgeInsets.symmetric(
                          horizontal: wide ? 32 : 20, vertical: 20),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          _section(l.consentCollectHeading, l.consentCollectBody,
                              Icons.gps_fixed_rounded),
                          _section(l.consentWhoHeading, l.consentWhoBody,
                              Icons.groups_rounded),
                          _section(l.consentRetentionHeading,
                              l.consentRetentionBody, Icons.schedule_rounded),
                          const SizedBox(height: 20),
                          FilledButton.icon(
                            onPressed: _submitting
                                ? null
                                : () async {
                                    setState(() => _submitting = true);
                                    // Mandatory scopes only — engine-audio
                                    // classification was removed from the
                                    // product surface (Phase 2, Option B).
                                    await widget.repo.accept(scopes: [
                                      'location',
                                      'motion',
                                    ]);
                                    if (context.mounted) widget.onAccepted();
                                  },
                            icon: const Icon(Icons.check_rounded, size: 26),
                            label: Text(l.consentAgree),
                            style: FilledButton.styleFrom(
                                minimumSize: const Size.fromHeight(64),
                                textStyle: const TextStyle(fontSize: 20)),
                          ),
                          const SizedBox(height: 4),
                          Center(
                            child: TextButton(
                              onPressed: _submitting
                                  ? null
                                  : () async {
                                      await widget.repo.decline();
                                      if (context.mounted) {
                                        ScaffoldMessenger.of(context)
                                            .showSnackBar(SnackBar(
                                                content:
                                                    Text(l.consentDeclinedBody)));
                                      }
                                    },
                              child: Text(l.consentDecline),
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

  /// One privacy section as an icon-led white card on the app canvas —
  /// scannable in seconds, the pattern trust/compliance screens use today.
  Widget _section(String title, String body, IconData icon) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: SoftCard(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 42,
                height: 42,
                decoration: BoxDecoration(
                  color: YetTheme.okBg,
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Icon(icon, color: YetTheme.primary, size: 22),
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w700,
                            color: YetTheme.ink)),
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
