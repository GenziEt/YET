import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'onboarding_repository.dart';

/// Step 1 of driver onboarding: phone number + OTP verification.
///
/// There is NO password anywhere in this flow — the verified phone becomes the
/// account identity and this install becomes the session credential (paired at
/// registration). The code is verified EARLY so the driver can take their time
/// on the long form without the SMS expiring (the backend grants a one-time
/// 15-minute registration ticket on success).
class OtpScreen extends StatefulWidget {
  const OtpScreen({
    super.key,
    required this.repo,
    required this.onVerified,
    this.initialPhone,
    this.repairsMode = false,
    this.onRepairsPaired,
  });

  final OnboardingRepository repo;
  /// Called after the OTP is verified AND a registration ticket is stored.
  final VoidCallback onVerified;
  /// Pre-fill when re-entering the flow (stored phone from a previous step).
  final String? initialPhone;
  /// Re-pairing mode (session lost / new phone): verifies + calls pairDevice
  /// instead of handing over to the registration form.
  final bool repairsMode;
  final VoidCallback? onRepairsPaired;

  @override
  State<OtpScreen> createState() => _OtpScreenState();
}

class _OtpScreenState extends State<OtpScreen> {
  final _phoneCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  String? _errorKey;
  String? _devCode; // OTP_DEV_ECHO only (dev builds) — never shown in release UI paths that matter
  bool _codeSent = false;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    _phoneCtrl.text = widget.initialPhone ?? '';
  }

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  /// Ethiopian mobile normalization mirroring the backend PhoneSchema:
  /// 09XXXXXXXX / 9XXXXXXXX / 07XXXXXXXX / 7XXXXXXXX -> +2519XXXXXXXX.
  String? _normalizePhone(String raw) {
    final digits = raw.replaceAll(RegExp(r'[^\d]'), '');
    if (digits.length == 10 && digits.startsWith('0')) {
      return '+251${digits.substring(1)}';
    }
    if (digits.length == 9 && (digits.startsWith('9') || digits.startsWith('7'))) {
      return '+251$digits';
    }
    if (digits.length == 12 && digits.startsWith('251')) return '+$digits';
    return null;
  }

  Future<void> _sendCode() async {
    final l = AppLocalizations.of(context);
    final phone = _normalizePhone(_phoneCtrl.text);
    if (phone == null) {
      setState(() => _errorKey = 'phone');
      return;
    }
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      final r = await widget.repo.requestOtp(phone);
      if (!mounted) return;
      setState(() {
        _codeSent = true;
        _devCode = r.devCode;
      });
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() => _errorKey = e.isRateLimited ? 'rate' : 'network');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _verify() async {
    final phone = _normalizePhone(_phoneCtrl.text);
    final code = _codeCtrl.text.trim();
    if (phone == null || code.length != 6) {
      setState(() => _errorKey = 'code');
      return;
    }
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      if (widget.repairsMode) {
        final ok = await widget.repo.pairDevice(phone, code);
        if (!mounted) return;
        if (ok) {
          widget.onRepairsPaired?.call();
        } else {
          setState(() => _errorKey = 'code');
        }
      } else {
        await widget.repo.verifyOtp(phone, code);
        if (!mounted) return;
        widget.onVerified();
      }
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() => _errorKey = switch (e.code) {
        'otp_expired_or_invalid' => 'code',
        'otp_limit_exceeded' => 'rate',
        'account_suspended' => 'suspended',
        'driver_not_registered' => 'notRegistered',
        _ => 'network',
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const SizedBox(height: 12),
              Icon(Icons.directions_bus_rounded, size: 64, color: Theme.of(context).colorScheme.primary),
              const SizedBox(height: 12),
              Text(
                widget.repairsMode ? l.obRepairsTitle : l.obPhoneTitle,
                style: Theme.of(context).textTheme.headlineSmall,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 8),
              Text(
                widget.repairsMode ? l.obRepairsBody : l.obPhoneBody,
                textAlign: TextAlign.center,
              ),
              const SizedBox(height: 24),
              TextField(
                controller: _phoneCtrl,
                keyboardType: TextInputType.phone,
                enabled: !_codeSent && !_busy,
                decoration: InputDecoration(
                  labelText: l.obPhoneHint,
                  border: const OutlineInputBorder(),
                  prefixText: '+251 ',
                ),
              ),
              if (_codeSent) ...[
                const SizedBox(height: 16),
                Text(l.obCodeSent),
                if (_devCode != null) ...[
                  const SizedBox(height: 8),
                  Container(
                    padding: const EdgeInsets.all(10),
                    color: Colors.amber.withValues(alpha: 0.2),
                    child: Text(l.obDevCodeBanner(_devCode!)),
                  ),
                ],
                const SizedBox(height: 16),
                TextField(
                  controller: _codeCtrl,
                  keyboardType: TextInputType.number,
                  maxLength: 6,
                  decoration: InputDecoration(
                    labelText: '______',
                    counterText: '',
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
              if (_errorKey != null) ...[
                const SizedBox(height: 12),
                Text(
                  switch (_errorKey) {
                    'phone' => l.obRequiredFields,
                    'code' => l.obOtpInvalid,
                    'rate' => l.obRateLimited,
                    'suspended' => l.obSuspendedBody,
                    'notRegistered' => l.obFormTitle,
                    _ => l.obNetworkError,
                  },
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : (_codeSent ? _verify : _sendCode),
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Text(_codeSent ? l.obVerifyCode : l.obSendCode),
                ),
              ),
              if (_codeSent) ...[
                const SizedBox(height: 8),
                TextButton(
                  onPressed: _busy
                      ? null
                      : () => setState(() {
                            _codeSent = false;
                            _devCode = null;
                            _codeCtrl.clear();
                          }),
                  child: Text(l.obResendCode),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
