import 'dart:convert';
import 'dart:io' show File;

import 'package:http/http.dart' as http;

import '../../core/config/app_config.dart';
import '../../core/net/http_clients.dart';
import 'device_identity.dart';
import 'token_store.dart';

/// Client for Module 1 — Driver onboarding WITHOUT a traditional login.
///
/// Endpoint contracts live in backend/src/modules/identity/onboarding.ts:
///   POST /auth/register/otp/request   {phone}                 -> {sent, ttl_s[, dev_code]}
///   POST /auth/register/otp/verify    {phone, code, device_id}-> {registration_ticket}
///   GET  /auth/register/ticket/check  ?ticket&phone&device_id -> {valid}
///   POST /auth/register               one-time form           -> {access_token, driver, status}
///   POST /auth/session/refresh        {device_id} + Bearer    -> {access_token}  (login replacement)
///   POST /auth/pair-device            {phone, otp_code, ...}  -> {access_token}  (recovery)
///   GET/PATCH /me/profile, POST /me/documents (multipart), POST /me/vehicles|trailers
///
/// The repository owns TokenStore writes so screens never touch persistence:
/// every successful auth call stores the fresh JWT (+ phone/driver id), which
/// is what keeps the driver "always logged in" across launches.
class OnboardingRepository {
  OnboardingRepository({
    required this.tokens,
    required this.device,
    http.Client? client,
    String Function()? baseUrlOverride,
  })  : _client = client ?? AppHttp.shared,
        _baseUrl = baseUrlOverride ?? (() => AppConfig.apiBaseUrl);

  final TokenStore tokens;
  final DeviceIdentity device;
  final http.Client _client;
  final String Function() _baseUrl;

  static const appVersion = '1.0.0'; // keep in sync with pubspec version tag

  Uri _u(String path) => Uri.parse('${_baseUrl()}$path');

  Map<String, String> get _jsonHeaders => {
        'content-type': 'application/json',
        if (tokens.accessToken != null) 'authorization': 'Bearer ${tokens.accessToken}',
      };

  /// Non-2xx responses carry `{error: <machine_code>}` from the backend; we
  /// surface that code verbatim so screens can branch (otp_expired_or_invalid,
  /// account_suspended, device_not_paired, rate-limited 429, ...).
  OnboardingException _fail(http.Response res) {
    String code = 'http_${res.statusCode}';
    try {
      final body = jsonDecode(res.body);
      if (body is Map && body['error'] is String) code = body['error'] as String;
    } catch (_) {/* non-JSON error page (proxy/gateway): keep status code */}
    return OnboardingException(res.statusCode, code);
  }

  Future<Map<String, dynamic>> _postJson(
      String path, Map<String, dynamic> body) async {
    final res = await _client
        .post(_u(path), headers: _jsonHeaders, body: jsonEncode(body))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) throw _fail(res);
    return res.body.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(res.body) as Map<String, dynamic>;
  }

  // ------------------------------ step 1: OTP -------------------------------

  /// Request an SMS code. `devCode` is populated only when the server runs
  /// with OTP_DEV_ECHO=true and no gateway (dev builds) — never shown in
  /// release UI beyond the debug banner.
  Future<OtpRequestResult> requestOtp(String phone) async {
    final r = await _postJson('/auth/register/otp/request', {'phone': phone});
    return OtpRequestResult(
      sent: r['sent'] == true,
      ttlS: (r['ttl_s'] as num?)?.toInt() ?? 300,
      devCode: r['dev_code'] as String?,
    );
  }

  /// Verify the code EARLY (before the long form) and persist the one-time
  /// registration ticket so the form can be filled without the code expiring.
  Future<void> verifyOtp(String phone, String code) async {
    final r = await _postJson('/auth/register/otp/verify', {
      'phone': phone,
      'code': code,
      'device_id': device.deviceId,
    });
    final ticket = r['registration_ticket'];
    if (ticket is! String || ticket.length < 16) {
      throw const OnboardingException(500, 'malformed_ticket_response');
    }
    await tokens.saveRegistrationTicket(ticket);
  }

  /// Probe a stored ticket before rendering the form (non-consuming). False ⇒
  /// the OTP step must be repeated (expired or consumed elsewhere).
  Future<bool> ticketStillValid(String phone) async {
    final t = tokens.registrationTicket;
    if (t == null) return false;
    try {
      final res = await _client
          .get(_u('/auth/register/ticket/check')
              .replace(queryParameters: {
            'registration_ticket': t,
            'phone': phone,
            'device_id': device.deviceId,
          }))
          .timeout(const Duration(seconds: 20));
      if (res.statusCode != 200) return false;
      return (jsonDecode(res.body) as Map)['valid'] == true;
    } catch (_) {
      return false; // offline/unknown ⇒ re-verify rather than lose the flow
    }
  }

  // --------------------------- step 2: registration -------------------------

  /// The ONE-TIME form submission. Creates the driver identity + assets,
  /// pairs this install, and returns the first token — after this call the
  /// driver NEVER logs in again (session refresh handles every launch).
  Future<RegisterResult> register(RegisterForm form) async {
    final ticket = tokens.registrationTicket;
    final r = await _postJson('/auth/register', {
      'phone': form.phone,
      if (ticket != null) 'registration_ticket': ticket,
      'device_id': device.deviceId,
      'full_name': form.fullName,
      'license_number': form.licenseNumber,
      if (form.licenseClass != null && form.licenseClass!.isNotEmpty)
        'license_class': form.licenseClass,
      if (form.licenseExpiry != null) 'license_expiry': form.licenseExpiry,
      if (form.associationName != null && form.associationName!.isNotEmpty)
        'association_name': form.associationName,
      if (form.homeBase != null && form.homeBase!.isNotEmpty)
        'home_base': form.homeBase,
      'locale': form.locale,
      'app_version': appVersion,
      'platform': device.platformLabel,
      if (form.vehicle != null) 'vehicle': form.vehicle!.toJson(),
      if (form.trailers.isNotEmpty)
        'trailers': form.trailers.map((t) => t.toJson()).toList(),
    });
    // Ticket consumed server-side either way; drop the local copy.
    await tokens.clearRegistrationTicket();
    final token = r['access_token'];
    final driver = (r['driver'] as Map?)?.cast<String, dynamic>();
    if (token is! String || token.isEmpty) {
      throw const OnboardingException(500, 'missing_access_token');
    }
    await tokens.save(
      token: token,
      driverId: driver?['id'] as String?,
      phone: form.phone,
    );
    return RegisterResult(
      driver: driver ?? const {},
      status: r['status'] as String? ?? 'PENDING_REVIEW',
      licenseUploaded: driver?['license_uploaded'] == true,
      nextSteps: (r['next_steps'] as List?)?.cast<String>() ?? const [],
    );
  }

  // ------------------- silent session restore (NO login screen) -------------

  /// Called at launch when a token exists but the server rejected it (or the
  /// JWT expired while offline). Presents the paired device id; the backend
  /// re-checks pairing + account state and mints a fresh token. Returns true
  /// on success. Throws [OnboardingException] with code `device_not_paired`
  /// when the caller should fall back to OTP re-pairing, and
  /// `account_inactive`/`fleet_suspended` when the driver must see the hold
  /// screen instead.
  Future<bool> refreshSession() async {
    final t = tokens.accessToken;
    if (t == null || !tokens.hasPhone) return false;
    final res = await _client
        .post(_u('/auth/session/refresh'),
            headers: _jsonHeaders,
            body: jsonEncode({'device_id': device.deviceId}))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) throw _fail(res);
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final token = body['access_token'];
    if (token is! String) return false;
    await tokens.save(token: token);
    return true;
  }

  /// Recovery when the session is unrecoverable silently (new phone, revoked
  /// device, long-expired token): prove the phone via OTP, re-pair, get a
  /// token. Same OTP channel as registration (/otp/request above).
  Future<bool> pairDevice(String phone, String otpCode) async {
    final r = await _postJson('/auth/pair-device', {
      'phone': phone,
      'otp_code': otpCode,
      'device_id': device.deviceId,
      'platform': device.platformLabel,
      'app_version': appVersion,
    });
    final token = r['access_token'];
    if (token is! String) return false;
    await tokens.save(
      token: token,
      driverId: r['user_id'] as String?,
      phone: phone,
    );
    return true;
  }

  // ----------------------------- profile & docs -----------------------------

  /// GET /me/profile — person, license, current equipment, documents w/ status.
  Future<Map<String, dynamic>> fetchProfile() => _postGetJson('/me/profile');

  Future<Map<String, dynamic>> _postGetJson(String path) async {
    final res = await _client
        .get(_u(path), headers: _jsonHeaders)
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) throw _fail(res);
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  /// PATCH /me/profile — update personal/license details (never equipment).
  Future<void> updateProfile(Map<String, dynamic> patch) async {
    final res = await _client
        .patch(_u('/me/profile'),
            headers: _jsonHeaders, body: jsonEncode(patch))
        .timeout(const Duration(seconds: 30));
    if (res.statusCode >= 400) throw _fail(res);
  }

  /// "I changed truck": declare a new vehicle (closes the old assignment).
  Future<void> addVehicle(Map<String, dynamic> vehicle) async {
    await _postJson('/me/vehicles', vehicle);
  }

  /// Declare an additional trailer (multiple allowed).
  Future<void> addTrailer(Map<String, dynamic> trailer) async {
    await _postJson('/me/trailers', trailer);
  }

  /// Multipart document upload. docType values mirror backend DocumentType:
  /// DRIVING_LICENSE (mandatory) | NATIONAL_ID | INSURANCE | OWNERSHIP |
  /// ASSOCIATION_CARD | OTHER. expiresOn: yyyy-MM-dd (license expiry tracking).
  Future<void> uploadDocument({
    required String docType,
    required File file,
    String? expiresOn,
  }) async {
    final req = http.MultipartRequest('POST', _u('/me/documents'))
      ..headers.addAll({
        if (tokens.accessToken != null)
          'authorization': 'Bearer ${tokens.accessToken}',
      })
      ..fields['doc_type'] = docType
      ..files.add(await http.MultipartFile.fromPath('file', file.path));
    if (expiresOn != null && expiresOn.isNotEmpty) {
      req.fields['expires_on'] = expiresOn;
    }
    final streamed = await req.send().timeout(const Duration(seconds: 90));
    final res = await http.Response.fromStream(streamed);
    if (res.statusCode >= 400) throw _fail(res);
  }

  /// Sign out THIS install only (lost/sold phone). After this the app returns
  /// to onboarding; re-pairing needs a fresh OTP.
  Future<void> revokeThisDevice() async {
    await _postJson('/me/devices/revoke', {'device_id': device.deviceId});
    await tokens.clear();
  }
}

// ------------------------------- value types --------------------------------

class OnboardingException implements Exception {
  const OnboardingException(this.statusCode, this.code);
  final int statusCode;
  /// Machine-readable backend code (error field) — e.g. otp_expired_or_invalid,
  /// registration_ticket_invalid, device_not_paired, account_suspended,
  /// phone_belongs_to_staff_account, otp_limit_exceeded, validation_failed.
  final String code;

  bool get isRateLimited => statusCode == 429;
  bool get isDeviceNotPaired => code == 'device_not_paired' || code == 'unauthorized';

  @override
  String toString() => 'OnboardingException($statusCode, $code)';
}

class OtpRequestResult {
  const OtpRequestResult({required this.sent, required this.ttlS, this.devCode});
  final bool sent;
  final int ttlS;
  final String? devCode;
}

/// Vehicle block of the registration form (self-declared asset; admin confirms
/// fleet membership during review). Field names mirror backend VehicleInput.
class VehicleForm {
  const VehicleForm({
    required this.plateNumber,
    this.truckType = 'TRUCK',
    this.makeModel,
    this.capacityTons,
    this.bodyType,
    this.ownershipStatus,
  });
  final String plateNumber;
  final String truckType; // TRUCK | TRAILER_HEAD | VAN | OTHER
  final String? makeModel;
  final double? capacityTons;
  final String? bodyType; // HIGH_BED | LOW_BED | BOX | TANKER | FLATBED | CONTAINER | REFRIGERATED | OTHER
  final String? ownershipStatus; // OWNER | EMPLOYEE_DRIVER | LEASED | ASSOCIATION | OTHER

  Map<String, dynamic> toJson() => {
        'plate_number': plateNumber,
        'truck_type': truckType,
        if (makeModel != null && makeModel!.isNotEmpty) 'make_model': makeModel,
        if (capacityTons != null) 'capacity_tons': capacityTons,
        if (bodyType != null) 'body_type': bodyType,
        if (ownershipStatus != null) 'ownership_status': ownershipStatus,
      };
}

/// Trailer block (plate identity is ASSET identity, never account identity).
class TrailerForm {
  const TrailerForm({
    required this.plateNumber,
    this.trailerType,
    this.capacityTons,
    this.equipmentDetails,
  });
  final String plateNumber;
  final String? trailerType;
  final double? capacityTons;
  final String? equipmentDetails;

  Map<String, dynamic> toJson() => {
        'plate_number': plateNumber,
        if (trailerType != null && trailerType!.isNotEmpty)
          'trailer_type': trailerType,
        if (capacityTons != null) 'capacity_tons': capacityTons,
        if (equipmentDetails != null && equipmentDetails!.isNotEmpty)
          'equipment_details': equipmentDetails,
      };
}

class RegisterForm {
  const RegisterForm({
    required this.phone,
    required this.fullName,
    required this.licenseNumber,
    this.licenseClass,
    this.licenseExpiry,
    this.associationName,
    this.homeBase,
    this.locale = 'am',
    this.vehicle,
    this.trailers = const [],
  });
  final String phone;
  final String fullName;
  final String licenseNumber;
  final String? licenseClass;
  final String? licenseExpiry; // yyyy-MM-dd
  final String? associationName;
  final String? homeBase;
  final String locale;
  final VehicleForm? vehicle;
  final List<TrailerForm> trailers;
}

class RegisterResult {
  const RegisterResult({
    required this.driver,
    required this.status,
    required this.licenseUploaded,
    required this.nextSteps,
  });
  final Map<String, dynamic> driver;
  final String status; // PENDING_REVIEW until an admin verifies + moves fleet
  final bool licenseUploaded;
  final List<String> nextSteps;
}
