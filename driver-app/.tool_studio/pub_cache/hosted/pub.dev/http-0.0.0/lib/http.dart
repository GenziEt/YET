class Response {
  const Response({this.statusCode = 200, this.body = ''});
  final int statusCode;
  final String body;
}
class Request {
  Request(this.method, this.url);
  final String method;
  final Uri url;
  Map<String, String> headers = {};
  String? body;
}
typedef _Future = Future<Response>;
_Future post(Object url, {Map<String, String>? headers, Object? body}) async => const Response();
_Future get(Object url, {Map<String, String>? headers}) async => const Response();
_Future put(Object url, {Map<String, String>? headers, Object? body}) async => const Response();
_Future delete(Object url, {Map<String, String>? headers}) async => const Response();
class Client {
  _Future post(Object url, {Map<String, String>? headers, Object? body}) async => const Response();
  _Future get(Object url, {Map<String, String>? headers}) async => const Response();
  void close() {}
}

/// Real http exposes `BaseClient` (which `http.Client` extends) and typed
/// exceptions the sync worker must distinguish for backoff decisions (§1.8.1).
class BaseClient extends Client {}
class ClientException implements Exception {
  const ClientException([this.message = '']);
  final String message;
  @override String toString() => 'ClientException: $message';
}
class TimeoutException implements Exception {
  const TimeoutException([this.message = '']);
  final String message;
  @override String toString() => 'TimeoutException: $message';
}
