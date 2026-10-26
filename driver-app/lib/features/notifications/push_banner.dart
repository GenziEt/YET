import 'dart:async';

import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'push_service.dart';

/// §Phase 4 (G5): foreground push-banner surface. [PushService.banners] is the
/// bus; this widget is the UI that consumes it, so a fleet alert arriving while
/// the driver is on the trip screen is actually SEEN (§1.2 operational-safety
/// notifications).
///
/// Mount it as a direct child of MaterialApp.home — it provides its own
/// [ScaffoldMessenger], and every Scaffold in the subtree (trip home, feedback,
/// offline map, pushed routes) registers with THAT messenger, so banners appear
/// above whichever screen is visible without touching those screens.
///
/// Localization contract: the backend renders title/body per recipient locale
/// (`notification/kernel.ts` renderMessage), so payload text displays verbatim.
/// The l10n `notif*` keys are the FALLBACK when a payload arrives without
/// localized text — mapped by `event_type`, with [AppLocalizations
/// .notifBannerFallback] for anything unrecognized. That keeps every string in
/// the default locale path translated while never discarding server copy.
class PushBannerHost extends StatefulWidget {
  const PushBannerHost({super.key, required this.push, required this.child});

  final PushService push;
  final Widget child;

  @override
  State<PushBannerHost> createState() => _PushBannerHostState();
}

class _PushBannerHostState extends State<PushBannerHost> {
  StreamSubscription<PushMessage>? _sub;
  PushMessage? _visible;

  @override
  void initState() {
    super.initState();
    _sub = widget.push.banners.listen(_onMessage);
  }

  @override
  void didUpdateWidget(covariant PushBannerHost old) {
    super.didUpdateWidget(old);
    if (old.push != widget.push) {
      _sub?.cancel();
      _sub = widget.push.banners.listen(_onMessage);
    }
  }

  void _onMessage(PushMessage m) {
    if (!mounted) return;
    // Latest alert wins; a new banner replaces the previous one.
    setState(() => _visible = m);
  }

  /// Server payload text first; l10n fallback only when the payload lacks it.
  static String resolveTitle(AppLocalizations l, PushMessage m) {
    if (m.title.trim().isNotEmpty) return m.title;
    switch (m.eventType) {
      case 'TRIP_STARTED':
        return l.notifTripStartedTitle;
      case 'TRIP_ENDED':
        return l.notifTripEndedTitle;
      case 'DRIVER_SEPARATION_TIMER':
        return l.notifSeparationTitle;
      case 'GEOFENCE_ENTER':
        return l.notifGeofenceEnterTitle;
      case 'GEOFENCE_EXIT':
        return l.notifGeofenceExitTitle;
      default:
        return l.notifBannerFallback;
    }
  }

  static String resolveBody(AppLocalizations l, PushMessage m) {
    if (m.body.trim().isNotEmpty) return m.body;
    return l.notifBannerFallback;
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  void _showBanner(BuildContext messengerContext, PushMessage m) {
    final l = AppLocalizations.of(messengerContext);
    ScaffoldMessenger.of(messengerContext)
      ..clearMaterialBanners()
      ..showMaterialBanner(MaterialBanner(
        leading: const Icon(Icons.notifications_active),
        content: Text(
          '${resolveTitle(l, m)}\n${resolveBody(l, m)}',
          style: const TextStyle(fontSize: 16),
        ),
        actions: [
          TextButton(
            onPressed: () =>
                ScaffoldMessenger.of(messengerContext).hideCurrentMaterialBanner(),
            child: Text(l.notifBannerDismiss),
          ),
        ],
      ));
  }

  @override
  Widget build(BuildContext context) {
    final m = _visible;
    if (m != null) {
      // Consume once so a rebuild never stacks duplicate banners.
      _visible = null;
      // Queue the banner for AFTER this frame — ScaffoldMessenger must not be
      // mutated during build. `context` here is below the messenger we provide.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!mounted) return;
        _showBanner(context, m);
      });
    }
    return ScaffoldMessenger(
      child: Builder(
        builder: (innerContext) => widget.child,
      ),
    );
  }
}
