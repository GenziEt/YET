import 'package:flutter/material.dart';

import '../../l10n/app_localizations.dart';
import 'onboarding_repository.dart';

/// Self-service profile: the screen that REPLACES "log in again". The driver's
/// identity (phone) is fixed; everything else is editable because drivers
/// change trucks, companies and licenses — never accounts.
///
/// Data source: GET /me/profile → { full_name, license_*, association_name,
/// ownership_status, home_base, registration_status, vehicle, trailers,
/// documents[] }. Writes go through PATCH /me/profile, POST /me/vehicles,
/// POST /me/trailers and POST /me/documents (re-upload replaces the previous
/// active row server-side).
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({
    super.key,
    required this.repo,
    this.onSignOut,
  });

  final OnboardingRepository repo;
  /// Invoked after the device pairing was revoked locally+remotely so the app
  /// shell can drop back to onboarding.
  final VoidCallback? onSignOut;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  Map<String, dynamic>? _profile;
  bool _loading = true;
  String? _errorKey;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _errorKey = null;
    });
    try {
      final p = await widget.repo.fetchProfile();
      if (!mounted) return;
      setState(() => _profile = p);
    } on OnboardingException catch (e) {
      if (!mounted) return;
      setState(() => _errorKey = e.isDeviceNotPaired ? 'pair' : 'network');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _editField(String key, String label, {bool numeric = false}) async {
    final controller = TextEditingController(text: '${_profile?[key] ?? ''}');
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(label),
        content: TextField(
          controller: controller,
          keyboardType: numeric ? const TextInputType.numberWithOptions(decimal: true) : TextInputType.text,
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, controller.text.trim()), child: const Text('OK')),
        ],
      ),
    );
    if (value == null || !mounted) return;
    setState(() => _loading = true);
    try {
      await widget.repo.updateProfile({key: value.isEmpty ? null : value});
      await _load();
    } on OnboardingException {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'network';
      });
    }
  }

  Future<void> _changeTruck() async {
    final l = AppLocalizations.of(context);
    final plate = await showDialog<String>(
      context: context,
      builder: (ctx) {
        final c = TextEditingController();
        return AlertDialog(
          title: Text(l.obChangeTruck),
          content: TextField(controller: c, decoration: InputDecoration(labelText: l.obPlateNumber)),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(ctx, c.text.trim().toUpperCase()), child: Text(l.obSaveChanges)),
          ],
        );
      },
    );
    if (plate == null || plate.length < 3 || !mounted) return;
    setState(() => _loading = true);
    try {
      // set_active=true closes the old assignment server-side (history kept).
      await widget.repo.addVehicle({'plate_number': plate, 'set_active': true});
      await _load();
    } on OnboardingException {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _errorKey = 'network';
      });
    }
  }

  Future<void> _signOut() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(AppLocalizations.of(ctx).obSignOutDevice),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('OK')),
        ],
      ),
    );
    if (ok != true || !mounted) return;
    try {
      await widget.repo.revokeThisDevice();
      widget.onSignOut?.call();
    } on OnboardingException {
      if (!mounted) return;
      setState(() => _errorKey = 'network');
    }
  }

  Widget _row(String label, String value) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Row(
          children: [
            Expanded(flex: 2, child: Text(label, style: Theme.of(context).textTheme.bodyMedium)),
            Expanded(flex: 3, child: Text(value, textAlign: TextAlign.end)),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = _profile;
    final vehicle = (p?['vehicle'] as Map?)?.cast<String, dynamic>();
    final docs = (p?['documents'] as List?) ?? const [];
    return Scaffold(
      appBar: AppBar(
        title: Text(l.obProfileTitle),
        actions: [IconButton(icon: const Icon(Icons.refresh), onPressed: _load)],
      ),
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            if (_loading && p == null) const LinearProgressIndicator(),
            if (_errorKey != null)
              Text(_errorKey == 'pair' ? l.obRepairsBody : l.obNetworkError,
                  style: TextStyle(color: Theme.of(context).colorScheme.error)),
            if (p != null) ...[
              _row(l.obFullName, '${p['full_name'] ?? ''}'),
              _row(l.obLicenseNumber, '${p['license_number'] ?? ''}'),
              _row(l.obLicenseClass, '${p['license_class'] ?? ''}'),
              _row(l.obLicenseExpiry, '${p['license_expiry'] ?? ''}'),
              _row(l.obAssociation, '${p['association_name'] ?? ''}'),
              _row(l.obHomeBase, '${p['home_base'] ?? ''}'),
              _row(l.obPlateNumber, '${vehicle?['plate_number'] ?? '—'}'),
              _row(l.obOwnership, '${vehicle?['ownership_status'] ?? '—'}'),
              _row(l.obPendingTitle, '${p['registration_status'] ?? ''}'),
              const SizedBox(height: 8),
              OutlinedButton.icon(
                icon: const Icon(Icons.swap_horiz),
                label: Text(l.obChangeTruck),
                onPressed: _changeTruck,
              ),
              OutlinedButton.icon(
                icon: const Icon(Icons.edit_outlined),
                label: Text(l.obSaveChanges),
                onPressed: () => _editField('full_name', l.obFullName),
              ),
              const Divider(height: 32),
              Text(l.obDocsTitle, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 8),
              if (docs.isEmpty) Text(l.obUploaded),
              ...docs.map((d) {
                final m = (d as Map).cast<String, dynamic>();
                return _row('${m['doc_type']}', '${m['status']}');
              }),
              const Divider(height: 32),
              TextButton.icon(
                style: TextButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                icon: const Icon(Icons.logout),
                label: Text(l.obSignOutDevice),
                onPressed: _signOut,
              ),
            ],
          ],
        ),
      ),
    );
  }
}
