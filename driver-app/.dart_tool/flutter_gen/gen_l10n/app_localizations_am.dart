import 'app_localizations.dart';

// ignore_for_file: type=lint

/// The translations for Amharic (`am`).
class AppLocalizationsAm extends AppLocalizations {
  AppLocalizationsAm([String locale = 'am']) : super(locale);

  @override
  String get appTitle => 'የዳራፊ መተግበሪያ';

  @override
  String get consentTitle => 'የአቀማመጥ እና የእንቅስቃሴ መረጃ ፈቃድ';

  @override
  String get consentBody => 'ዒት የስልክዎን አቀማመጥ እና እንቅስቃሴ ይከታተላል፤ የአውቶሞብሊዮን ኃላፊዎ ጭነቱ የት እንዳለ ለማየት። ይህ ስልክ ብቸኛው ክትትል መሣሪያ ነው — ስልክዎን ይዘው ሲሄዱ የተሽከርካሪው ቀጥታ አቀማመጥ ማሰጠት ያቆማል።';

  @override
  String get consentCollectHeading => 'ምን እንሰበስባለን';

  @override
  String get consentCollectBody => 'በጉዞ ወቅት የႷႵስ አቀማመጥ፣ የእንቅስቃሴ ዳሳሽ መረጃ። \'እንቅስቃሴ መለየትን አሻሽል\' ካብቀሉ በስተቀር ድምጽ በፍጹም አይሰበሰብም።';

  @override
  String get consentWhoHeading => 'ማን ይመለከታል';

  @override
  String get consentWhoBody => 'የተመደቡለት የአውቶሞብሊዮን ኃላፊ ብቻ። መረጃው በኢትዮጵያ ውስጥ ባሉ ሰርቨሮች ላይ በኢትዮጵያ ሕግ (አዋጅ ቁጥር 1321/2024) ይቀመጣል።';

  @override
  String get consentRetentionHeading => 'ለምን ያህል ጊዜ እንይዛለን';

  @override
  String get consentRetentionBody => 'ዝርዝር የአቀማመጥ ታሪክ ለ90 ቀናት፤ ከዚያ ወደ ጉዞ ማጠቃለያ ይቀንሳል። በማንኛውም ጊዜ ማጥፋት ሊጠይቁ ይችላሉ፤ በ30 ቀናት ውስጥ እናጠናቅቃለን።';

  @override
  String get consentImproveMotion => 'እንቅስቃሴ መለየትን አሻሽል (አማራጭ የማይክሮፎን ናሙና፣ 1–2 ሰከንድ)';

  @override
  String get consentAgree => 'እስማማለሁ — ዒትን ለመጠቀም ጀምር';

  @override
  String get consentDecline => 'አልስማማም';

  @override
  String get consentDeclinedBody => 'ያለ ፈቃድ ዒት ምንም መረጃ ሊሰበስብ አይችልም፤ አይሰራም። ውሳኔዎን ከጊዜ በኋላ በቅንብሮች ማስተካከል ይችላሉ።';

  @override
  String get permTitle => 'ፈቃዶች ያስፈልጋሉ';

  @override
  String get permLocationBody => 'ዒት \'ሁልጊዜ\' የአቀማመጥ ፈቃድ ይጠይቃል — መተግበሪያው ተዘግቶ በመንገድ ላይ ሳሉ ክትትሉ መቀጠል ስላለበት።';

  @override
  String get permBatteryBody => 'እባክዎ ዒት የባትሪ ማስታረቂያ ማስተካከያ እንዲያልፍ ይፍቀዱ። Android ካልሆነ በስተቀር ከጥቂት ደቂቃዎች በኋላ ክትትሉን አቁሞ የጉዞ መረጃዎ ሊጠፋ ይችላል።';

  @override
  String get permContinue => 'የስልክ ቅንብሮችን ክፈት';

  @override
  String get permDone => 'ፈቃዶቹን አስተካክያለሁ';

  @override
  String get tripReadyTitle => 'ለመንዳት ዝግጁ';

  @override
  String get startTrip => 'ጉዞ ጀምር';

  @override
  String get endTrip => 'ጉዞ አብቃ';

  @override
  String pendingSync(int count) {
    return '$count መረጃ ለመላኽ ይጠብቃል';
  }

  @override
  String get offlineBanner => 'በመስመር ላይ አይደለም — በአካባቢው እየተመዘገበ ራሱ በራሱ ይልካል';

  @override
  String get languageToggle => 'English';

  @override
  String storageWarning(Object percent) {
    return 'ማከማቻው ሙሉ በሙሉ ላይ ነው ($percent%)። የGPS መረጃ ቅድሚያ ይሰጠዋል።';
  }

  @override
  String get syncBacklogZero => 'ሁሉም መረጃ ተልኳል';

  @override
  String get tripVehicleNone => 'ምንም አውቶሞብሊዮ አልተመደበም — የአውቶሞብሊዮን ኃላፊዎን ይደውሉ';

  @override
  String tripStartConfirm(String vehicle) {
    return 'ለ$vehicle ጉዞ ተጀምሯል';
  }

  @override
  String get feedbackTitle => 'ችግርን ያዘጋጁ';

  @override
  String get feedbackIntro => 'የሚያዩትን ችግር ይንኩ። ዒት ትንሽ የመረጃ ማሳወቂያ ለኃላፊዎ ይልካል።';

  @override
  String get feedbackGps => 'GPS አይሰራም';

  @override
  String get feedbackBattery => 'መተግበሪያው ባትሪ እያሟጠቸ ነው';

  @override
  String get feedbackSync => 'መረጃ አይላኽም';

  @override
  String get feedbackOther => 'ሌላ ነገር';

  @override
  String get feedbackSend => 'ዕቅዱን ላክ';

  @override
  String get feedbackSent => 'ዕቅዱ ተልኳል። እናመሰግናለን!';

  @override
  String get feedbackFailed => 'መላኽ አልተሳካም — ምልክት ሲያገኙ እንደገና ይሞክራል';

  @override
  String get offlineMapTitle => 'ያለ መስመር ካርታዎች';

  @override
  String get offlineMapBody => 'ከመነሳትዎ በፊት ለፈተናው አካባቢ ካርታዎችን ያውርዱ። በኋላ ያለ ምልክት ይሰራል።';

  @override
  String get offlineMapStart => 'ካርታዎችን አሁን አውርድ';

  @override
  String offlineMapProgress(int done, int total) {
    return 'ካርታዎች በማውረድ ላይ፦ $done ከ$total';
  }

  @override
  String offlineMapDone(int downloaded, int failed) {
    return 'ያለ መስመር ካርታዎች ዝግጁ ($downloaded አዲስ፣ $failed ወድቀዋል)';
  }

  @override
  String get notifTripStartedTitle => 'ጉዞው ጀምሯል';

  @override
  String get notifTripEndedTitle => 'ጉዞው አልቋል';

  @override
  String get notifSeparationTitle => 'የአሽከርካሪ መለያየት ማንቂያ';

  @override
  String get notifGeofenceEnterTitle => 'ወደ ግቢ ገብቷል';

  @override
  String get notifGeofenceExitTitle => 'ከግቢ ወጥቷል';

  @override
  String get notifBannerFallback => 'የአደሻ ማሳወቂያ';
}
