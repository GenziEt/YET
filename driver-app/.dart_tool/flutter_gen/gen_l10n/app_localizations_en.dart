import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for English (`en`).
class AppLocalizationsEn extends AppLocalizations {
  AppLocalizationsEn([String locale = 'en']) : super(locale);

  @override
  String get appTitle => 'YET Driver';

  @override
  String get consentTitle => 'Location & motion data consent';

  @override
  String get consentBody => 'YET tracks your phone\'s location and motion so your fleet manager can see where the shipment is. This phone is the only tracker — when you walk away with it, the truck\'s live position stops updating.';

  @override
  String get consentCollectHeading => 'What we collect';

  @override
  String get consentCollectBody => 'GPS location during trips, movement sensor data (accelerometer/gyroscope). Audio is NEVER collected unless you turn on \'Improve motion detection\' below.';

  @override
  String get consentWhoHeading => 'Who sees it';

  @override
  String get consentWhoBody => 'Only your assigned fleet manager. Data is stored on servers inside Ethiopia under Ethiopian law (Proclamation No. 1321/2024).';

  @override
  String get consentRetentionHeading => 'How long we keep it';

  @override
  String get consentRetentionBody => 'Detailed location history for 90 days, then reduced to trip summaries. You can request deletion at any time; we complete it within 30 days.';

  @override
  String get consentImproveMotion => 'Improve motion detection (optional microphone sampling, 1–2 seconds)';

  @override
  String get consentAgree => 'I agree — start using YET';

  @override
  String get consentDecline => 'Do not agree';

  @override
  String get consentDeclinedBody => 'Without consent YET cannot collect any data and will not run. You may change this decision later in Settings.';

  @override
  String get permTitle => 'Permissions needed';

  @override
  String get permLocationBody => 'YET needs location access \'All the time\' because tracking must continue while the app is closed and you are driving.';

  @override
  String get permBatteryBody => 'Please allow YET to ignore battery optimization. Android would otherwise stop tracking after a few minutes and your trip data would be lost.';

  @override
  String get permContinue => 'Open phone settings';

  @override
  String get permDone => 'I have set the permissions';

  @override
  String get tripReadyTitle => 'Ready to drive';

  @override
  String get startTrip => 'START TRIP';

  @override
  String get endTrip => 'END TRIP';

  @override
  String pendingSync(int count) {
    return '$count records pending sync';
  }

  @override
  String get offlineBanner => 'Offline — recording locally, will upload automatically';

  @override
  String get languageToggle => 'አማርኛ';

  @override
  String storageWarning(Object percent) {
    return 'Storage is almost full ($percent%). Sync will prioritize GPS fixes.';
  }

  @override
  String get syncBacklogZero => 'All fixes synced';

  @override
  String get tripVehicleNone => 'No truck assigned — call your fleet manager';

  @override
  String tripStartConfirm(String vehicle) {
    return 'Trip started for $vehicle';
  }

  @override
  String get feedbackTitle => 'Report a problem';

  @override
  String get feedbackIntro => 'Tap the problem you are seeing. YET sends a small diagnostic message to your fleet manager.';

  @override
  String get feedbackGps => 'GPS not working';

  @override
  String get feedbackBattery => 'App draining battery';

  @override
  String get feedbackSync => 'Data not uploading';

  @override
  String get feedbackOther => 'Something else';

  @override
  String get feedbackSend => 'Send report';

  @override
  String get feedbackSent => 'Report sent. Thank you!';

  @override
  String get feedbackFailed => 'Could not send — will retry when you have signal';

  @override
  String get offlineMapTitle => 'Offline maps';

  @override
  String get offlineMapBody => 'Download maps for the pilot region before departing. Works without signal later.';

  @override
  String get offlineMapStart => 'Download maps now';

  @override
  String offlineMapProgress(int done, int total) {
    return 'Downloading maps: $done of $total';
  }

  @override
  String offlineMapDone(int downloaded, int failed) {
    return 'Offline maps ready ($downloaded new, $failed failed)';
  }

  @override
  String get notifTripStartedTitle => 'Trip started';

  @override
  String get notifTripEndedTitle => 'Trip ended';

  @override
  String get notifSeparationTitle => 'Driver separation alert';

  @override
  String get notifGeofenceEnterTitle => 'Entered zone';

  @override
  String get notifGeofenceExitTitle => 'Left zone';

  @override
  String get notifBannerFallback => 'Fleet notification';
}
