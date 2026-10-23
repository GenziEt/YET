/// Sandbox stub of dart:ui/foundation surface (analyze + kernel-compile).
/// IMPORTANT: this file must be SELF-CONTAINED. The CFE does not honor
/// `export` for resolving types used in the exporting library's own bodies
/// (the analyzer does), so every symbol product code imports from
/// package:flutter/foundation.dart lives here directly. debugPrint and
/// Locale mirror real Flutter's arrangement: foundation.dart owns them and
/// material/widgets re-export via _core.dart.
library flutter_stub_foundation;

void debugPrint(Object? message) {}
const bool kDebugMode = true;
const bool kReleaseMode = false;
class _VisibleForTesting { const _VisibleForTesting(); }
const visibleForTesting = _VisibleForTesting();
class _Deprecated { const _Deprecated(this.message); final String message; }
typedef Deprecated = _Deprecated;
typedef VoidCallback = void Function();
abstract class Listenable { void addListener(void Function() l); void removeListener(void Function() l); }
class ChangeNotifier implements Listenable {
  final List<void Function()> _listeners = [];
  @override void addListener(void Function() l) => _listeners.add(l);
  @override void removeListener(void Function() l) => _listeners.remove(l);
  void notifyListeners() { for (final l in List<void Function()>.from(_listeners)) l(); }
  void dispose() {}
}
class ValueNotifier<T> implements Listenable {
  ValueNotifier(this._value);
  T _value;
  T get value => _value;
  set value(T v) { _value = v; notifyListeners(); }
  final List<void Function()> _listeners = [];
  @override void addListener(void Function() l) => _listeners.add(l);
  @override void removeListener(void Function() l) => _listeners.remove(l);
  void notifyListeners() { for (final l in List<void Function()>.from(_listeners)) l(); }
  void dispose() {}
}
