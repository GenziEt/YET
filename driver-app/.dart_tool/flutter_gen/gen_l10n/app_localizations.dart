import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:intl/intl.dart' as intl;

import 'app_localizations_am.dart';
import 'app_localizations_en.dart';

// ignore_for_file: type=lint

/// Callers can lookup localized strings with an instance of AppLocalizations
/// returned by `AppLocalizations.of(context)`.
///
/// Applications need to include `AppLocalizations.delegate()` in their app's
/// `localizationDelegates` list, and the locales they support in the app's
/// `supportedLocales` list. For example:
///
/// ```dart
/// import 'gen_l10n/app_localizations.dart';
///
/// return MaterialApp(
///   localizationsDelegates: AppLocalizations.localizationsDelegates,
///   supportedLocales: AppLocalizations.supportedLocales,
///   home: MyApplicationHome(),
/// );
/// ```
///
/// ## Update pubspec.yaml
///
/// Please make sure to update your pubspec.yaml to include the following
/// packages:
///
/// ```yaml
/// dependencies:
///   # Internationalization support.
///   flutter_localizations:
///     sdk: flutter
///   intl: any # Use the pinned version from flutter_localizations
///
///   # Rest of dependencies
/// ```
///
/// ## iOS Applications
///
/// iOS applications define key application metadata, including supported
/// locales, in an Info.plist file that is built into the application bundle.
/// To configure the locales supported by your app, you’ll need to edit this
/// file.
///
/// First, open your project’s ios/Runner.xcworkspace Xcode workspace file.
/// Then, in the Project Navigator, open the Info.plist file under the Runner
/// project’s Runner folder.
///
/// Next, select the Information Property List item, select Add Item from the
/// Editor menu, then select Localizations from the pop-up menu.
///
/// Select and expand the newly-created Localizations item then, for each
/// locale your application supports, add a new item and select the locale
/// you wish to add from the pop-up menu in the Value field. This list should
/// be consistent with the languages listed in the AppLocalizations.supportedLocales
/// property.
abstract class AppLocalizations {
  AppLocalizations(String locale) : localeName = intl.Intl.canonicalizedLocale(locale.toString());

  final String localeName;

  static AppLocalizations of(BuildContext context) {
    return Localizations.of<AppLocalizations>(context, AppLocalizations)!;
  }

  static const LocalizationsDelegate<AppLocalizations> delegate = _AppLocalizationsDelegate();

  /// A list of this localizations delegate along with the default localizations
  /// delegates.
  ///
  /// Returns a list of localizations delegates containing this delegate along with
  /// GlobalMaterialLocalizations.delegate, GlobalCupertinoLocalizations.delegate,
  /// and GlobalWidgetsLocalizations.delegate.
  ///
  /// Additional delegates can be added by appending to this list in
  /// MaterialApp. This list does not have to be used at all if a custom list
  /// of delegates is preferred or required.
  static const List<LocalizationsDelegate<dynamic>> localizationsDelegates = <LocalizationsDelegate<dynamic>>[
    delegate,
    GlobalMaterialLocalizations.delegate,
    GlobalCupertinoLocalizations.delegate,
    GlobalWidgetsLocalizations.delegate,
  ];

  /// A list of this localizations delegate's supported locales.
  static const List<Locale> supportedLocales = <Locale>[
    Locale('am'),
    Locale('en')
  ];

  /// No description provided for @appTitle.
  ///
  /// In en, this message translates to:
  /// **'YET Driver'**
  String get appTitle;

  /// No description provided for @consentTitle.
  ///
  /// In en, this message translates to:
  /// **'Location & motion data consent'**
  String get consentTitle;

  /// No description provided for @consentBody.
  ///
  /// In en, this message translates to:
  /// **'YET tracks your phone\'s location and motion so your fleet manager can see where the shipment is. This phone is the only tracker — when you walk away with it, the truck\'s live position stops updating.'**
  String get consentBody;

  /// No description provided for @consentCollectHeading.
  ///
  /// In en, this message translates to:
  /// **'What we collect'**
  String get consentCollectHeading;

  /// No description provided for @consentCollectBody.
  ///
  /// In en, this message translates to:
  /// **'GPS location during trips, movement sensor data (accelerometer/gyroscope). Audio is NEVER collected.'**
  String get consentCollectBody;

  /// No description provided for @consentWhoHeading.
  ///
  /// In en, this message translates to:
  /// **'Who sees it'**
  String get consentWhoHeading;

  /// No description provided for @consentWhoBody.
  ///
  /// In en, this message translates to:
  /// **'Only your assigned fleet manager. Data is stored on servers inside Ethiopia under Ethiopian law (Proclamation No. 1321/2024).'**
  String get consentWhoBody;

  /// No description provided for @consentRetentionHeading.
  ///
  /// In en, this message translates to:
  /// **'How long we keep it'**
  String get consentRetentionHeading;

  /// No description provided for @consentRetentionBody.
  ///
  /// In en, this message translates to:
  /// **'Detailed location history for 90 days, then reduced to trip summaries. You can request deletion at any time; we complete it within 30 days.'**
  String get consentRetentionBody;

  /// No description provided for @consentAgree.
  ///
  /// In en, this message translates to:
  /// **'I agree — start using YET'**
  String get consentAgree;

  /// No description provided for @consentDecline.
  ///
  /// In en, this message translates to:
  /// **'Do not agree'**
  String get consentDecline;

  /// No description provided for @consentDeclinedBody.
  ///
  /// In en, this message translates to:
  /// **'Without consent YET cannot collect any data and will not run. You may change this decision later in Settings.'**
  String get consentDeclinedBody;

  /// No description provided for @permTitle.
  ///
  /// In en, this message translates to:
  /// **'Permissions needed'**
  String get permTitle;

  /// No description provided for @permLocationBody.
  ///
  /// In en, this message translates to:
  /// **'YET needs location access \'All the time\' because tracking must continue while the app is closed and you are driving.'**
  String get permLocationBody;

  /// No description provided for @permBatteryBody.
  ///
  /// In en, this message translates to:
  /// **'Please allow YET to ignore battery optimization. Android would otherwise stop tracking after a few minutes and your trip data would be lost.'**
  String get permBatteryBody;

  /// No description provided for @permContinue.
  ///
  /// In en, this message translates to:
  /// **'Open phone settings'**
  String get permContinue;

  /// No description provided for @permDone.
  ///
  /// In en, this message translates to:
  /// **'I have set the permissions'**
  String get permDone;

  /// No description provided for @tripReadyTitle.
  ///
  /// In en, this message translates to:
  /// **'Ready to drive'**
  String get tripReadyTitle;

  /// No description provided for @startTrip.
  ///
  /// In en, this message translates to:
  /// **'START TRIP'**
  String get startTrip;

  /// No description provided for @endTrip.
  ///
  /// In en, this message translates to:
  /// **'END TRIP'**
  String get endTrip;

  /// No description provided for @pendingSync.
  ///
  /// In en, this message translates to:
  /// **'{count} records pending sync'**
  String pendingSync(int count);

  /// No description provided for @offlineBanner.
  ///
  /// In en, this message translates to:
  /// **'Offline — recording locally, will upload automatically'**
  String get offlineBanner;

  /// No description provided for @languageToggle.
  ///
  /// In en, this message translates to:
  /// **'አማርኛ'**
  String get languageToggle;

  /// No description provided for @storageWarning.
  ///
  /// In en, this message translates to:
  /// **'Storage is almost full ({percent}%). Sync will prioritize GPS fixes.'**
  String storageWarning(Object percent);

  /// No description provided for @syncBacklogZero.
  ///
  /// In en, this message translates to:
  /// **'All fixes synced'**
  String get syncBacklogZero;

  /// No description provided for @tripVehicleNone.
  ///
  /// In en, this message translates to:
  /// **'No truck assigned — call your fleet manager'**
  String get tripVehicleNone;

  /// No description provided for @tripStartConfirm.
  ///
  /// In en, this message translates to:
  /// **'Trip started for {vehicle}'**
  String tripStartConfirm(String vehicle);

  /// No description provided for @feedbackTitle.
  ///
  /// In en, this message translates to:
  /// **'Report a problem'**
  String get feedbackTitle;

  /// No description provided for @feedbackIntro.
  ///
  /// In en, this message translates to:
  /// **'Tap the problem you are seeing. YET sends a small diagnostic message to your fleet manager.'**
  String get feedbackIntro;

  /// No description provided for @feedbackGps.
  ///
  /// In en, this message translates to:
  /// **'GPS not working'**
  String get feedbackGps;

  /// No description provided for @feedbackBattery.
  ///
  /// In en, this message translates to:
  /// **'App draining battery'**
  String get feedbackBattery;

  /// No description provided for @feedbackSync.
  ///
  /// In en, this message translates to:
  /// **'Data not uploading'**
  String get feedbackSync;

  /// No description provided for @feedbackOther.
  ///
  /// In en, this message translates to:
  /// **'Something else'**
  String get feedbackOther;

  /// No description provided for @feedbackSend.
  ///
  /// In en, this message translates to:
  /// **'Send report'**
  String get feedbackSend;

  /// No description provided for @feedbackSent.
  ///
  /// In en, this message translates to:
  /// **'Report sent. Thank you!'**
  String get feedbackSent;

  /// No description provided for @feedbackFailed.
  ///
  /// In en, this message translates to:
  /// **'Could not send — will retry when you have signal'**
  String get feedbackFailed;

  /// No description provided for @offlineMapTitle.
  ///
  /// In en, this message translates to:
  /// **'Offline maps'**
  String get offlineMapTitle;

  /// No description provided for @offlineMapBody.
  ///
  /// In en, this message translates to:
  /// **'Download maps for the pilot region before departing. Works without signal later.'**
  String get offlineMapBody;

  /// No description provided for @offlineMapStart.
  ///
  /// In en, this message translates to:
  /// **'Download maps now'**
  String get offlineMapStart;

  /// No description provided for @offlineMapProgress.
  ///
  /// In en, this message translates to:
  /// **'Downloading maps: {done} of {total}'**
  String offlineMapProgress(int done, int total);

  /// No description provided for @offlineMapDone.
  ///
  /// In en, this message translates to:
  /// **'Offline maps ready ({downloaded} new, {failed} failed)'**
  String offlineMapDone(int downloaded, int failed);

  /// No description provided for @offlineMapAttribution.
  ///
  /// In en, this message translates to:
  /// **'Map tiles © YET self-hosted tiles, based on OpenStreetMap data © OpenStreetMap contributors'**
  String get offlineMapAttribution;

  /// No description provided for @offlineMapNoTiles.
  ///
  /// In en, this message translates to:
  /// **'No cached map tiles yet — download maps before dropping a pin'**
  String get offlineMapNoTiles;

  /// No description provided for @notifTripStartedTitle.
  ///
  /// In en, this message translates to:
  /// **'Trip started'**
  String get notifTripStartedTitle;

  /// No description provided for @notifTripEndedTitle.
  ///
  /// In en, this message translates to:
  /// **'Trip ended'**
  String get notifTripEndedTitle;

  /// No description provided for @notifSeparationTitle.
  ///
  /// In en, this message translates to:
  /// **'Driver separation alert'**
  String get notifSeparationTitle;

  /// No description provided for @notifGeofenceEnterTitle.
  ///
  /// In en, this message translates to:
  /// **'Entered zone'**
  String get notifGeofenceEnterTitle;

  /// No description provided for @notifGeofenceExitTitle.
  ///
  /// In en, this message translates to:
  /// **'Left zone'**
  String get notifGeofenceExitTitle;

  /// No description provided for @notifBannerFallback.
  ///
  /// In en, this message translates to:
  /// **'Fleet notification'**
  String get notifBannerFallback;

  /// No description provided for @notifBannerDismiss.
  ///
  /// In en, this message translates to:
  /// **'Dismiss'**
  String get notifBannerDismiss;
}

class _AppLocalizationsDelegate extends LocalizationsDelegate<AppLocalizations> {
  const _AppLocalizationsDelegate();

  @override
  Future<AppLocalizations> load(Locale locale) {
    return SynchronousFuture<AppLocalizations>(lookupAppLocalizations(locale));
  }

  @override
  bool isSupported(Locale locale) => <String>['am', 'en'].contains(locale.languageCode);

  @override
  bool shouldReload(_AppLocalizationsDelegate old) => false;
}

AppLocalizations lookupAppLocalizations(Locale locale) {


  // Lookup logic when only language code is specified.
  switch (locale.languageCode) {
    case 'am': return AppLocalizationsAm();
    case 'en': return AppLocalizationsEn();
  }

  throw FlutterError(
    'AppLocalizations.delegate failed to load unsupported locale "$locale". This is likely '
    'an issue with the localizations generation tool. Please file an issue '
    'on GitHub with a reproducible sample app and the gen-l10n configuration '
    'that was used.'
  );
}
