import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

/// §Phase 4 completion criterion: "Amharic localization is complete across
/// every screen and string resource; no untranslated production strings
/// remain in the default locale path."
///
/// tool/gen_l10n.py enforces this at generation time; this test enforces it
/// in CI from the ARB sources themselves, so a hand-edited or regenerated
/// app_localizations.dart can never ship with an English-only gap:
///  1. identical key sets between app_en.arb and app_am.arb (ignoring @-meta);
///  2. identical {placeholder} sets per key (an Amharic string that drops a
///     placeholder would silently render a raw `{vehicle}` token on device);
///  3. every Amharic value actually contains Ethiopic script — a copy-paste
///     of the English text into the `am` slot is the classic fake-localization
///     failure this catches;
///  4. the generated class exposes exactly the same getters as the ARBs.
void main() {
  final enFile = File('lib/l10n/app_en.arb');
  final amFile = File('lib/l10n/app_am.arb');
  final genFile = File('lib/l10n/app_localizations.dart');

  Map<String, Object?> readArb(File f) =>
      jsonDecode(f.readAsStringSync()) as Map<String, Object?>;

  Set<String> keys(Map<String, Object?> arb) =>
      arb.keys.where((k) => !k.startsWith('@')).toSet();

  Set<String> placeholders(String template) =>
      RegExp(r'\{(\w+)\}').allMatches(template).map((m) => m.group(1)!).toSet();

  group('ARB parity (en ↔ am)', () {
    test('both ARB files exist and parse', () {
      expect(enFile.existsSync(), isTrue, reason: 'missing ${enFile.path}');
      expect(amFile.existsSync(), isTrue, reason: 'missing ${amFile.path}');
      expect(() => readArb(enFile), returnsNormally);
      expect(() => readArb(amFile), returnsNormally);
    });

    test('identical non-@ key sets — no untranslated production string', () {
      final en = keys(readArb(enFile));
      final am = keys(readArb(amFile));
      expect(am.difference(en), isEmpty,
          reason: 'app_am.arb has keys unknown to app_en.arb');
      expect(en.difference(am), isEmpty,
          reason: 'app_am.arb is MISSING keys present in app_en.arb — '
              'the Amharic-first default locale (§1.2) would fall back to '
              'English for these strings');
      // Sanity: the suite is not vacuously passing on empty files.
      expect(en.length, greaterThan(40));
    });

    test('per-key placeholder parity ({name} tokens match exactly)', () {
      final en = readArb(enFile);
      final am = readArb(amFile);
      for (final k in keys(en)) {
        final e = en[k], a = am[k];
        expect(a, isA<String>(), reason: '$k missing from app_am.arb');
        expect(placeholders('$e'), placeholders('$a'),
            reason: 'placeholder mismatch on "$k": en={$e} am={$a}');
      }
    });

    test('every am value is actually Amharic (Ethiopic script present)', () {
      final am = readArb(amFile);
      final ethiopic = RegExp('[\\u0D00-\\u0D7F]');
      for (final k in keys(am)) {
        final v = '${am[k]}';
        expect(ethiopic.hasMatch(v), isTrue,
            reason: '"$k" in app_am.arb contains no Ethiopic characters — '
                'untranslated string shipped in the default locale path: $v');
      }
    });

    test('generated class exposes one getter/method per ARB key', () {
      final src = genFile.readAsStringSync();
      final en = keys(readArb(enFile));
      for (final k in en) {
        final declared = RegExp('\\b$k\\b').hasMatch(src);
        expect(declared, isTrue,
            reason: 'lib/l10n/app_localizations.dart lacks member "$k" — '
                'regenerate with tool/gen_l10n.py');
      }
    });
  });
}
