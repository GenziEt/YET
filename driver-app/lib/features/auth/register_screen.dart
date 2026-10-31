import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'onboarding_repository.dart';

/// Step 2: the ONE-TIME registration form (personal + license + association +
/// vehicle + trailers). Reached only after OTP verification (a stored ticket),
/// because submitting consumes the ticket server-side. After success the
/// driver never sees this screen again — identity changes are PATCH /me/profile,
/// truck changes are POST /me/vehicles, both from the profile screen.
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({
    super.key,
    required this.repo,
    required this.phone,
    required this.localeCode,
    required this.onRegistered,
  });

  final OnboardingRepository repo;
  /// E.164 phone proven by the OTP step (shown read-only: it IS the account).
  final String phone;
  final String localeCode; // 'am' | 'en' — forwarded to the backend profile
  final void Function(RegisterResult result) onRegistered;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _fullName = TextEditingController();
  final _licenseNumber = TextEditingController();
  final _licenseClass = TextEditingController();
  final _licenseExpiry = TextEditingController();
  final _association = TextEditingController();
  final _homeBase = TextEditingController();
  final _plate = TextEditingController();
  final _makeModel = TextEditingController();
  final _capacity = TextEditingController();
  final List<_TrailerRow> _trailers = [_TrailerRow()];

  String _truckType = 'TRUCK';
  String? _bodyType;
  String? _ownership;
  bool _busy = false;
  String? _errorKey;

  static const _truckTypes = <String, String>{
    'TRUCK': 'Truck',
    'TRAILER_HEAD': 'Trailer head (ታሪራ)',
    'VAN': 'Van',
    'OTHER': 'Other',
  };
  static const _bodyTypes = <String, String>{
    'HIGH_BED': 'High bed',
    'LOW_BED': 'Low bed',
    'BOX': 'Box',
    'TANKER': 'Tanker',
    'FLATBED': 'Flatbed',
    'CONTAINER': 'Container',
    'REFRIGERATED': 'Refrigerated',
    'OTHER': 'Other',
  };
  static const _ownerships = <String, String>{
    'OWNER': 'I own it',
    'EMPLOYEE_DRIVER': 'Company truck',
    'LEASED': 'Leased',
    'ASSOCIATION': 'Association',
    'OTHER': 'Other',
  };

  @override
  void dispose() {
    for (final c in [
      _fullName, _licenseNumber, _licenseClass, _licenseExpiry,
      _association, _homeBase, _plate, _makeModel, _capacity,
    ]) {
      c.dispose();
    }
    for (final t in _trailers) {
      t.dispose();
    }
    super.dispose();
  }

  Future<void> _submit() async {
    final l = AppLocalizations.of(context);
    // Backend-required fields only: full_name(≥2), license_number(≥3),
    // vehicle plate optional but strongly expected at first registration.
    if (_fullName.text.trim().length < 2 ||
        _licenseNumber.text.trim().length < 3 ||
        _plate.text.trim().length < 3) {
      setState(() => _errorKey = 'required');
      return;
    }
    final expiry = _licenseExpiry.text.trim();
    if (expiry.isNotEmpty && !RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(expiry)) {
      setState(() => _errorKey = 'expiry');
      return;
    }
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      final result = await widget.repo.register(RegisterForm(
        phone: widget.phone,
        fullName: _fullName.text.trim(),
        licenseNumber: _licenseNumber.text.trim(),
        licenseClass: _nullIfEmpty(_licenseClass.text),
        licenseExpiry: expiry.isEmpty ? null : expiry,
        associationName: _nullIfEmpty(_association.text),
        homeBase: _nullIfEmpty(_homeBase.text),
        locale: widget.localeCode,
        vehicle: VehicleForm(
          plateNumber: _plate.text.trim().toUpperCase(),
          truckType: _truckType,
          makeModel: _nullIfEmpty(_makeModel.text),
          capacityTons: double.tryParse(_capacity.text.replaceAll(',', '.')),
          bodyType: _bodyType,
          ownershipStatus: _ownership,
        ),
        trailers: _trailers
            .where((t) => t.plateCtrl.text.trim().length >= 3)
            .map((t) => TrailerForm(
                  plateNumber: t.plateCtrl.text.trim().toUpperCase(),
                  trailerType: _nullIfEmpty(t.typeCtrl.text),
                ))
            .toList(),
      ));
      if (!mounted) return;
      widget.onRegistered(result);
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() => _errorKey = switch (e.code) {
        'registration_ticket_invalid' || 'otp_required' => 'ticket',
        'phone_belongs_to_staff_account' => 'staffPhone',
        'account_suspended' => 'suspended',
        'validation_failed' => 'required',
        _ => 'network',
      });
      if (_errorKey == 'ticket') {
        // Ticket expired mid-form (15 min): go back to the OTP step.
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(l.obOtpInvalid)));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  static String? _nullIfEmpty(TextEditingController c) {
    final t = c.text.trim();
    return t.isEmpty ? null : t;
  }

  InputDecoration _dec(BuildContext context, String label) => InputDecoration(
        labelText: label,
        border: const OutlineInputBorder(),
        isDense: true,
      );

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l.obFormTitle)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              // Phone is the identity — displayed, not editable.
              Chip(label: Text(widget.phone), avatar: const Icon(Icons.phone_rounded, size: 18)),
              const SizedBox(height: 16),
              Text(l.obPersonalHeading, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              TextField(controller: _fullName, decoration: _dec(context, l.obFullName), textCapitalization: TextCapitalization.words),
              const SizedBox(height: 10),
              TextField(controller: _licenseNumber, decoration: _dec(context, l.obLicenseNumber)),
              const SizedBox(height: 10),
              TextField(controller: _licenseClass, decoration: _dec(context, l.obLicenseClass)),
              const SizedBox(height: 10),
              TextField(controller: _licenseExpiry, decoration: _dec(context, l.obLicenseExpiry), keyboardType: TextInputType.datetime),
              const SizedBox(height: 10),
              TextField(controller: _association, decoration: _dec(context, l.obAssociation), textCapitalization: TextCapitalization.words),
              const SizedBox(height: 10),
              TextField(controller: _homeBase, decoration: _dec(context, l.obHomeBase), textCapitalization: TextCapitalization.words),
              const SizedBox(height: 20),
              Text(l.obVehicleHeading, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              TextField(controller: _plate, decoration: _dec(context, l.obPlateNumber), textCapitalization: TextCapitalization.characters),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                initialValue: _truckType,
                decoration: _dec(context, l.obTruckType),
                items: _truckTypes.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))).toList(),
                onChanged: (v) => setState(() => _truckType = v ?? 'TRUCK'),
              ),
              const SizedBox(height: 10),
              TextField(controller: _makeModel, decoration: _dec(context, l.obMakeModel)),
              const SizedBox(height: 10),
              TextField(controller: _capacity, decoration: _dec(context, l.obCapacityTons), keyboardType: const TextInputType.numberWithOptions(decimal: true)),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                decoration: _dec(context, l.obBodyType),
                items: _bodyTypes.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))).toList(),
                onChanged: (v) => setState(() => _bodyType = v),
              ),
              const SizedBox(height: 10),
              DropdownButtonFormField<String>(
                decoration: _dec(context, l.obOwnership),
                items: _ownerships.entries.map((e) => DropdownMenuItem(value: e.key, child: Text(e.value))).toList(),
                onChanged: (v) => setState(() => _ownership = v),
              ),
              const SizedBox(height: 20),
              Text(l.obTrailerHeading, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              ..._trailers.asMap().entries.map((entry) => Padding(
                    padding: const EdgeInsets.only(bottom: 10),
                    child: Row(
                      children: [
                        Expanded(
                          flex: 3,
                          child: TextField(
                            controller: entry.value.plateCtrl,
                            decoration: _dec(context, l.obTrailerPlate),
                            textCapitalization: TextCapitalization.characters,
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          flex: 2,
                          child: TextField(
                            controller: entry.value.typeCtrl,
                            decoration: _dec(context, 'Bed / type'),
                          ),
                        ),
                        if (_trailers.length > 1)
                          IconButton(
                            icon: const Icon(Icons.remove_circle_outline),
                            onPressed: () => setState(() => _trailers.removeAt(entry.key).dispose()),
                          ),
                      ],
                    ),
                  )),
              Align(
                alignment: Alignment.centerLeft,
                child: TextButton.icon(
                  icon: const Icon(Icons.add),
                  label: Text(l.obAddTrailer),
                  onPressed: () => setState(() => _trailers.add(_TrailerRow())),
                ),
              ),
              if (_errorKey != null) ...[
                const SizedBox(height: 8),
                Text(
                  switch (_errorKey) {
                    'required' => l.obRequiredFields,
                    'expiry' => l.obLicenseExpiry,
                    'ticket' => l.obOtpInvalid,
                    'staffPhone' => l.obSuspendedBody,
                    'suspended' => l.obSuspendedBody,
                    _ => l.obNetworkError,
                  },
                  style: TextStyle(color: Theme.of(context).colorScheme.error),
                ),
              ],
              const SizedBox(height: 24),
              FilledButton(
                onPressed: _busy ? null : _submit,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Text(l.obSubmitRegister),
                ),
              ),
              const SizedBox(height: 12),
            ],
          ),
        ),
      ),
    );
  }
}

class _TrailerRow {
  final plateCtrl = TextEditingController();
  final typeCtrl = TextEditingController();
  void dispose() {
    plateCtrl.dispose();
    typeCtrl.dispose();
  }
}
