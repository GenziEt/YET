/// Sandbox stub of package:flutter_test (analyze + kernel-compile only).
library flutter_test;

class Matcher { const Matcher(); }
const Matcher isTrue = Matcher();
const Matcher isFalse = Matcher();
const Matcher isNull = Matcher();
const Matcher isNotNull = Matcher();
const Matcher isEmpty = Matcher();
const Matcher isNotEmpty = Matcher();
Matcher equals(Object? expected) => const Matcher();
Matcher contains(Object? expected) => const Matcher();
Matcher greaterThan(num n) => const Matcher();
Matcher lessThan(num n) => const Matcher();
Matcher throwsA(Matcher m) => const Matcher();
Matcher anyOf(Iterable<Matcher> ms) => const Matcher();

int failures = 0;
int passes = 0;
void group(String description, void Function() body) => body();
void test(String description, dynamic Function() body) {
  try {
    body();
    passes++;
  } catch (e) {
    failures++;
    print('FAIL $description: $e');
  }
}
void expect(Object? actual, Object? matcher, {String? reason}) {
  if (matcher is! Matcher) {
    if (actual != matcher) throw 'expect failed: $actual != $matcher ${reason ?? ''}';
  }
}
void flushAndReport() => print('RESULT passes=$passes failures=$failures');
