import 'package:flutter/material.dart';

/// Brand status tokens — the single source of truth for semantic colors so
/// banners/chips across every screen share one visual language (no more
/// `Colors.amber.shade100` stock-material look).
abstract final class StatusTokens {
  static const Color okBg = Color(0xFFE8F5E9);
  static const Color okFg = Color(0xFF1B5E20);
  static const Color warnBg = Color(0xFFFFF6DE);
  static const Color warnFg = Color(0xFF7A5B00);
  static const Color errorBg = Color(0xFFFDECEC);
  static const Color errorFg = Color(0xFFB3261E);
  static const Color neutralBg = Color(0xFFF1F4F1);
  static const Color neutralFg = Color(0xFF37474F);
}

enum StatusTone { ok, warn, error, neutral }

/// Compact pill used for sync/assignment state — the pattern seen on modern
/// fleet & logistics apps (Samsara, Motive): icon + label, tone-colored,
/// fully localized text supplied by the caller.
class StatusChip extends StatelessWidget {
  const StatusChip({
    super.key,
    required this.icon,
    required this.label,
    this.tone = StatusTone.neutral,
    this.dense = false,
  });

  final IconData icon;
  final String label;
  final StatusTone tone;
  final bool dense;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg) = switch (tone) {
      StatusTone.ok => (StatusTokens.okBg, StatusTokens.okFg),
      StatusTone.warn => (StatusTokens.warnBg, StatusTokens.warnFg),
      StatusTone.error => (StatusTokens.errorBg, StatusTokens.errorFg),
      StatusTone.neutral => (StatusTokens.neutralBg, StatusTokens.neutralFg),
    };
    return Container(
      padding: EdgeInsets.symmetric(
          horizontal: dense ? 10 : 14, vertical: dense ? 6 : 9),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: dense ? 15 : 18, color: fg),
          SizedBox(width: dense ? 5 : 7),
          Flexible(
            child: Text(
              label,
              style: TextStyle(
                color: fg,
                fontSize: dense ? 13 : 15,
                fontWeight: FontWeight.w600,
                height: 1.2,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Full-width inline alert card (assignment gate results, offline warnings).
/// Same flat-tone language as [StatusChip] but sized for a sentence of copy.
class InlineAlert extends StatelessWidget {
  const InlineAlert({
    super.key,
    required this.icon,
    required this.message,
    this.tone = StatusTone.warn,
  });

  final IconData icon;
  final String message;
  final StatusTone tone;

  @override
  Widget build(BuildContext context) {
    final (Color bg, Color fg) = switch (tone) {
      StatusTone.ok => (StatusTokens.okBg, StatusTokens.okFg),
      StatusTone.warn => (StatusTokens.warnBg, StatusTokens.warnFg),
      StatusTone.error => (StatusTokens.errorBg, StatusTokens.errorFg),
      StatusTone.neutral => (StatusTokens.neutralBg, StatusTokens.neutralFg),
    };
    return AnimatedContainer(
      duration: const Duration(milliseconds: 220),
      curve: Curves.easeOutCubic,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: fg.withAlpha(0x1F)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Icon(icon, color: fg, size: 22),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Text(
              message,
              style: TextStyle(
                  color: fg, fontSize: 16, fontWeight: FontWeight.w600, height: 1.35),
            ),
          ),
        ],
      ),
    );
  }
}

/// Elevated rounded surface card — the base building block for the app's
/// "cards on canvas" layout. Zero elevation + hairline border reads crisp on
/// low-end LCD panels in sunlight (unlike Material shadow cards).
class SoftCard extends StatelessWidget {
  const SoftCard({
    super.key,
    required this.child,
    this.padding = const EdgeInsets.all(16),
  });

  final Widget child;
  final EdgeInsetsGeometry padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x14000000)),
      ),
      child: child,
    );
  }
}

/// Branded gradient header used at the top of consent / permissions screens —
/// instant brand recognition, generous whitespace, mobile-first composition
/// à la modern fintech onboarding flows.
class GradientHeader extends StatelessWidget {
  const GradientHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.trailing,
  });

  final String title;
  final String? subtitle;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      decoration: const BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [Color(0xFF14471A), Color(0xFF1B5E20), Color(0xFF2E7D32)],
        ),
        borderRadius: BorderRadius.only(
          bottomLeft: Radius.circular(28),
          bottomRight: Radius.circular(28),
        ),
      ),
      child: SafeArea(
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 28, 24, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  // Wordmark badge — small, confident brand moment.
                  Container(
                    width: 44,
                    height: 44,
                    decoration: BoxDecoration(
                      color: const Color(0x29FFFFFF),
                      borderRadius: BorderRadius.circular(14),
                      border: Border.all(color: const Color(0x47FFFFFF)),
                    ),
                    child: const Center(
                      child: Icon(Icons.local_shipping_rounded,
                          color: Colors.white, size: 24),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      title,
                      style: const TextStyle(
                        color: Colors.white,
                        fontSize: 24,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.2,
                        height: 1.2,
                      ),
                    ),
                  ),
                  if (trailing != null) trailing!,
                ],
              ),
              if (subtitle != null) ...[
                const SizedBox(height: 12),
                Text(
                  subtitle!,
                  style: TextStyle(
                    color: const Color(0xEBFFFFFF),
                    fontSize: 16,
                    height: 1.45,
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
