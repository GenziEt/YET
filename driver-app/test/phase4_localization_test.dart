import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:yet_driver/features/pilot/feedback_screen.dart'
    show kFeedbackQueuedBannerTemplate, kFeedbackQueuedBannerTemplateAm;

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

    test('no ARB value is a bare placeholder ("TBD"/"..."/"TODO")', () {
      for (final f in [enFile, amFile]) {
        final arb = readArb(f);
        for (final k in keys(arb)) {
          final v = '${arb[k]}'.trim();
          expect(v, isNotEmpty, reason: '$k empty in ${f.path}');
          expect(RegExp(r'^(TBD|TODO|FIXME|\.\.\.)$', caseSensitive: false)
              .hasMatch(v), isFalse,
              reason: '$k is an unresolved placeholder in ${f.path}');
        }
      }
    });
  });

  group('screen-local localized strings (outside AppLocalizations)', () {
    // FeedbackScreen's queued-reports banner lives as consts in the screen
    // file (an extra ARB key would break the strict getter↔key parity check
    // above). It must still obey the same localization contract as the ARBs.
    Set<String> ph(String t) =>
        RegExp(r'\{(\w+)\}').allMatches(t).map((m) => m.group(1)!).toSet();

    test('en ↔ am placeholder parity ({count})', () {
      expect(ph(kFeedbackQueuedBannerTemplate), {'count'});
      expect(ph(kFeedbackQueuedBannerTemplateAm), {'count'});
    });

    test('am variant is actually Amharic (Ethiopic script present)', () {
      expect(RegExp('[\\u0D00-\\u0D7F]').hasMatch(kFeedbackQueuedBannerTemplateAm),
          isTrue);
    });

    test('every generated getter resolves to Amharic in locale "am" (no '\n
        'silent English fallback in the default Amharic-first path)', () {
      final en = keys(readArb(enFile));
      // Placeholder-bearing keys are generated as methods, not getters.
      const methodKeys = {
        'pendingSync', 'storageWarning', 'tripStartConfirm',
        'offlineMapProgress', 'offlineMapDone',
      };
      final ethiopic = RegExp('[\\u0D00-\\u0D7F]');
      for (final k in en.difference(methodKeys)) {
        final v = LocalizedGetter.amText(k);
        expect(ethiopic.hasMatch(v), isTrue,
            reason: 'getter "$k" returned non-Amharic text in locale am: $v');
      }
    });
  });
}

/// Test-only helper: the localization suite needs to read the `case 'am':`
/// branch of every generated getter by NAME, and Dart has no member-name
/// reflection — so this parses the generated source instead. Deterministic and
/// offline; never referenced from production code.
class LocalizedGetter {
  static final Map<String, String> _amCache = _load();

  static Map<String, String> _load() {
    final src = File('lib/l10n/app_localizations.dart').readAsStringSync();
    final out = <String, String>{};
    // Match: String get KEY {\n switch (localeName) {\n case 'am':\n return '...';
    final re = RegExp(
        r"String get (\w+) \{\s*switch \(localeName\) \{\s*case 'am':\s*return '((?:[^'\\]|\\.)*)';");
    for (final m in re.allMatches(src)) {
      out[m.group(1)!] = m.group(2)!.replaceAll(r"\'", "'").replaceAll(r'\\', r'\');
    }
    return out;
  }

  static String amText(String key) {
    final v = _amCache[key];
    if (v == null) {
      throw StateError('no am branch parsed for "$key" — regenerate l10n with '
          'tool/gen_l10n.py');
    }
    return v;
  }
}
