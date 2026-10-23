/// Sandbox stub core (analyze-only). Single source of truth for the fake
/// Flutter API surface; material.dart and widgets.dart re-export it so they
/// can never drift apart (the previous duplicate-declaration bug broke every
/// file importing package:flutter/material.dart through widgets.dart).
library flutter_stub_core;

export 'foundation.dart' show VoidCallback, ChangeNotifier, ValueNotifier, Listenable, kDebugMode;
export 'ui.dart' show Locale;

// ---- widgets -------------------------------------------------------------
abstract class Key { const Key(); }
class ValueKey<T> implements Key { const ValueKey(this.value); final T value; }

abstract class Widget { const Widget({this.key}); final Key? key; }

class BuildContext {
  /// Real Flutter >=3.7/3.8 exposes `context.mounted`.
  bool get mounted => true;
}

typedef WidgetBuilder = Widget Function(BuildContext);

void runApp(Widget app) {}

class Text extends Widget {
  const Text(this.data, {super.key, this.style});
  final String data;
  final TextStyle? style;
}

class SizedBox extends Widget {
  const SizedBox({super.key, this.height, this.width});
  const SizedBox.expand({super.key}) : height = null, width = null;
  final double? height;
  final double? width;
}

class Icon extends Widget {
  const Icon(this.icon, {super.key, this.size, this.color});
  final IconData? icon;
  final double? size;
  final Color? color;
}

class IconData { const IconData(this.codePoint); final int codePoint; }

class Spacer extends Widget { const Spacer({super.key}); }

class Container extends Widget {
  const Container({super.key, this.child, this.padding, this.decoration, this.margin, this.color});
  final Widget? child;
  final EdgeInsetsGeometry? padding;
  final EdgeInsetsGeometry? margin;
  final BoxDecoration? decoration;
  final Color? color;
}

class Padding extends Widget {
  const Padding({super.key, required this.padding, this.child});
  final EdgeInsetsGeometry padding;
  final Widget? child;
}

class SafeArea extends Widget {
  const SafeArea({super.key, this.child});
  final Widget? child;
}

class Column extends Widget {
  const Column({super.key, this.children = const [], this.crossAxisAlignment, this.mainAxisAlignment, this.mainAxisSize});
  final List<Widget> children;
  final CrossAxisAlignment? crossAxisAlignment;
  final MainAxisAlignment? mainAxisAlignment;
  final MainAxisSize? mainAxisSize;
}

class Row extends Widget {
  const Row({super.key, this.children = const [], this.crossAxisAlignment, this.mainAxisAlignment});
  final List<Widget> children;
  final CrossAxisAlignment? crossAxisAlignment;
  final MainAxisAlignment? mainAxisAlignment;
}

class Stack extends Widget {
  const Stack({super.key, this.children = const []});
  final List<Widget> children;
}

enum CrossAxisAlignment { start, center, end, stretch }
enum MainAxisAlignment { start, center, end, spaceBetween, spaceAround, spaceEvenly }
enum MainAxisSize { min, max }

class Expanded extends Widget {
  const Expanded({super.key, this.child});
  final Widget? child;
}

// ---- geometry ------------------------------------------------------------
class EdgeInsetsGeometry { const EdgeInsetsGeometry(); }
class EdgeInsets extends EdgeInsetsGeometry {
  const EdgeInsets.all(double a) : super();
  const EdgeInsets.only({double top = 0, double bottom = 0, double left = 0, double right = 0}) : super();
  const EdgeInsets.symmetric({double horizontal = 0, double vertical = 0}) : super();
  const EdgeInsets.fromLTRB(double l, double t, double r, double b) : super();
}
class BorderRadius extends EdgeInsetsGeometry {
  const BorderRadius.all(Radius r) : super();
  // Non-const static like real Flutter's `BorderRadius.circular` (it also does
  // implicit clampToRadius math), so lint behavior matches production.
  static BorderRadius circular(double v) => BorderRadius.all(Radius.circular(v));
}
class Radius { const Radius.circular(double v); }

// ---- painting ------------------------------------------------------------
class Color { const Color(int value); const Color.fromARGB(int a, int r, int g, int b); }
class Colors {
  static const Color amber = Color(0xFFFFC107);
  static const Color red = Color(0xFFF44336);
  static const Color green = Color(0xFF4CAF50);
  static const Color grey = Color(0xFF9E9E9E);
  static const Color blue = Color(0xFF2196F3);
  static const Color orange = Color(0xFFFF9800);
  static const Color white = Color(0xFFFFFFFF);
  static const Color black = Color(0xFF000000);
  static const Color transparent = Color(0x00000000);
}
extension MaterialColorShades on Color {
  Color get shade50 => this; Color get shade100 => this; Color get shade200 => this;
  Color get shade300 => this; Color get shade400 => this; Color get shade500 => this;
  Color get shade600 => this; Color get shade700 => this; Color get shade800 => this;
  Color get shade900 => this;
}
class BoxDecoration { const BoxDecoration({this.color, this.borderRadius}); final Color? color; final BorderRadius? borderRadius; }
class TextStyle {
  const TextStyle({this.fontSize, this.fontWeight, this.color, this.height});
  final double? fontSize;
  final FontWeight? fontWeight;
  final Color? color;
  final double? height;
  TextStyle copyWith({Color? color, FontWeight? fontWeight, double? fontSize}) => this;
}
class FontWeight {
  const FontWeight._();
  static const FontWeight bold = FontWeight._();
  static const FontWeight normal = FontWeight._();
  static const FontWeight w500 = FontWeight._();
  static const FontWeight w700 = FontWeight._();
}

// ---- stateful/stateless --------------------------------------------------
abstract class StatelessWidget extends Widget {
  const StatelessWidget({super.key});
  Widget build(BuildContext context);
}

abstract class StatefulWidget extends Widget {
  const StatefulWidget({super.key});
  State createState();
}

/// Concrete base — real Flutter's State provides these members; subclasses in
/// product code must not be forced to implement them.
class State<T extends StatefulWidget> {
  T get widget => throw UnimplementedError('stub');
  BuildContext get context => BuildContext();
  bool get mounted => true;
  void initState() {}
  void dispose() {}
  void setState(void Function() fn) => fn();
  Widget build(BuildContext context) => const SizedBox();
}

// ---- app scaffolding ------------------------------------------------------
class AppBar extends Widget {
  const AppBar({super.key, this.title, this.actions});
  final Widget? title;
  final List<Widget>? actions;
}

class Scaffold extends Widget {
  const Scaffold({super.key, this.appBar, this.body, this.floatingActionButton});
  final Widget? appBar;
  final Widget? body;
  final Widget? floatingActionButton;
}

class FloatingActionButton extends Widget {
  const FloatingActionButton({super.key, this.onPressed, this.child});
  final VoidCallback? onPressed;
  final Widget? child;
}

class ThemeMode { const ThemeMode._(); static const ThemeMode light = ThemeMode._(); static const ThemeMode dark = ThemeMode._(); static const ThemeMode system = ThemeMode._(); }

class ThemeData {
  const ThemeData({this.textTheme = const TextTheme(), this.colorScheme, this.useMaterial3 = false, this.snackBarTheme});
  final TextTheme textTheme;
  final ColorScheme? colorScheme;
  final bool useMaterial3;
  final SnackBarThemeData? snackBarTheme;
  static ThemeData light() => const ThemeData();
  static ThemeData dark() => const ThemeData();
}

class ColorScheme {
  const ColorScheme();
  // Intentionally NOT const in the stub: mirrors real Flutter where fromSeed
  // builds tonal palettes at runtime (keeps prefer_const_constructors honest).
  factory ColorScheme.fromSeed({Color? seedColor}) => const ColorScheme();
}

class TextTheme {
  const TextTheme();
  TextStyle? get headlineSmall => null;
  TextStyle? get titleMedium => null;
  TextStyle? get bodyMedium => null;
  TextStyle? get titleSmall => null;
  TextStyle? get headlineMedium => null;
}

class Theme extends Widget {
  const Theme({super.key, this.data, this.child});
  final ThemeData? data;
  final Widget? child;
  static ThemeData of(BuildContext c) => const ThemeData();
}

class SnackBarThemeData { const SnackBarThemeData({this.contentTextStyle}); final TextStyle? contentTextStyle; }
class MaterialApp extends Widget {
  const MaterialApp({super.key, this.home, this.title, this.theme, this.localizationsDelegates, this.supportedLocales, this.locale, this.debugShowCheckedModeBanner = true});
  final Widget? home;
  final String? title;
  final ThemeData? theme;
  final dynamic localizationsDelegates;
  final Iterable<Locale>? supportedLocales;
  final Locale? locale;
  final bool debugShowCheckedModeBanner;
}

class ScaffoldMessengerState { void showSnackBar(SnackBar s) {} }
class ScaffoldMessenger { static ScaffoldMessengerState of(BuildContext c) => ScaffoldMessengerState(); }

class SnackBar extends Widget {
  const SnackBar({super.key, this.content});
  final Widget? content;
}

// ---- buttons ---------------------------------------------------------------
class ButtonStyle { const ButtonStyle(); }
class FilledButton extends Widget {
  const FilledButton({super.key, this.onPressed, this.child, this.style});
  const FilledButton.icon({super.key, this.onPressed, this.child, this.style, this.icon});
  const FilledButton.tonal({super.key, this.onPressed, this.child, this.style, this.icon});
  final VoidCallback? onPressed;
  final Widget? child;
  final ButtonStyle? style;
  final Widget? icon;
  static ButtonStyle styleFrom({Size? minimumSize, Color? backgroundColor, TextStyle? textStyle}) => const ButtonStyle();
}
class TextButton extends Widget {
  const TextButton({super.key, this.onPressed, this.child});
  final VoidCallback? onPressed;
  final Widget? child;
}
class OutlinedButton extends Widget {
  const OutlinedButton({super.key, this.onPressed, this.child});
  final VoidCallback? onPressed;
  final Widget? child;
}
class ElevatedButton extends Widget {
  const ElevatedButton({super.key, this.onPressed, this.child});
  final VoidCallback? onPressed;
  final Widget? child;
}

class Size { const Size(this.width, this.height); final double width; final double height; const Size.fromHeight(double h) : width = 0, height = h; }

// ---- misc widgets used by app ----------------------------------------------
class Center extends Widget { const Center({super.key, this.child}); final Widget? child; }
class Align extends Widget { const Align({super.key, this.child}); final Widget? child; }
class Opacity extends Widget { const Opacity({super.key, this.opacity = 1, this.child}); final double opacity; final Widget? child; }
class Card extends Widget { const Card({super.key, this.child}); final Widget? child; }
class ListTile extends Widget { const ListTile({super.key, this.title, this.subtitle, this.onTap}); final Widget? title; final Widget? subtitle; final VoidCallback? onTap; }
class Switch extends Widget { const Switch({super.key, this.value, this.onChanged}); final bool? value; final void Function(bool)? onChanged; }
class Checkbox extends Widget { const Checkbox({super.key, this.value, this.onChanged}); final bool? value; final void Function(bool?)? onChanged; }
class CircularProgressIndicator extends Widget { const CircularProgressIndicator({super.key}); }
class LinearProgressIndicator extends Widget { const LinearProgressIndicator({super.key, this.value}); final double? value; }
class Divider extends Widget { const Divider({super.key}); }
class ListView extends Widget {
  const ListView({super.key, this.children = const [], this.padding});
  final List<Widget> children;
  final EdgeInsetsGeometry? padding;
}
class SingleChildScrollView extends Widget { const SingleChildScrollView({super.key, this.child}); final Widget? child; }
class InkWell extends Widget { const InkWell({super.key, this.child, this.onTap}); final Widget? child; final VoidCallback? onTap; }
class GestureDetector extends Widget { const GestureDetector({super.key, this.child, this.onTap}); final Widget? child; final VoidCallback? onTap; }
class IgnorePointer extends Widget { const IgnorePointer({super.key, this.ignoring = true, this.child}); final bool ignoring; final Widget? child; }
class Tooltip extends Widget { const Tooltip({super.key, this.message, this.child}); final String? message; final Widget? child; }
class RefreshIndicator extends Widget { const RefreshIndicator({super.key, this.child, this.onRefresh}); final Widget? child; final Future<void> Function()? onRefresh; }

class Icons {
  static const IconData share_location = IconData(0xe0c3);
  static const IconData battery_charging_full = IconData(0xe0a8);
  static const IconData cloud_off = IconData(0xe2bd);
  static const IconData cloud_done = IconData(0xe2be);
  static const IconData my_location = IconData(0xe55e);
  static const IconData refresh = IconData(0xe5d5);
  static const IconData sync = IconData(0xe627);
  static const IconData warning = IconData(0xe002);
}

class SwitchListTile extends Widget { const SwitchListTile({super.key, this.title, this.value, this.onChanged}); final Widget? title; final bool? value; final void Function(bool)? onChanged; }

class WidgetsFlutterBinding { static void ensureInitialized() {} }

// ---- widgets-library surface also visible via material.dart --------------
abstract class LocalizationsDelegate<T> {
  const LocalizationsDelegate();
  bool isSupported(Locale locale);
  Future<T> load(Locale locale);
  bool shouldReload(covariant LocalizationsDelegate<T> old);
}

class Localizations {
  static T? of<T>(BuildContext c, Type t) => null;
}
