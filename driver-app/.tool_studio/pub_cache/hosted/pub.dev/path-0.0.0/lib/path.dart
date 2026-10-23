String join(String a, [String? b, String? c]) => [a, b, c].where((e) => e != null).join('/');
String basename(String p) => p.split('/').last;
