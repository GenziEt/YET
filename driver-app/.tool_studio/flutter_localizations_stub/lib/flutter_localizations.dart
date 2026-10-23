/// Sandbox stub of package:flutter_localizations (analyze-only).
library flutter_localizations;
import 'package:flutter/widgets.dart';
class GlobalMaterialLocalizations {
  const GlobalMaterialLocalizations._();
  static const LocalizationsDelegate<GlobalMaterialLocalizations> delegate = _D();
}
class GlobalWidgetsLocalizations {
  const GlobalWidgetsLocalizations._();
  static const LocalizationsDelegate<GlobalWidgetsLocalizations> delegate = _D();
}
class GlobalCupertinoLocalizations {
  const GlobalCupertinoLocalizations._();
  static const LocalizationsDelegate<GlobalCupertinoLocalizations> delegate = _D();
}
class _D<T> implements LocalizationsDelegate<T> {
  const _D();
  @override bool isSupported(Locale locale) => true;
  @override Future<T> load(Locale locale) => Future<T>.error(UnimplementedError());
  @override bool shouldReload(covariant LocalizationsDelegate<T> old) => false;
}
