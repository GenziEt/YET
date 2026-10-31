import 'dart:io' show File;

import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../l10n/app_localizations.dart';
import 'onboarding_repository.dart';

/// Step 3 (immediately after registration): upload the driving-license photo —
/// the ONLY mandatory document for activation. Other documents (national ID,
/// insurance, ownership, association card) are conditional and can be skipped;
/// an admin names what is missing during review.
///
/// Files go to POST /me/documents as multipart (field `file`, `doc_type`,
/// optional `expires_on`). The backend caps size via DOC_MAX_SIZE_BYTES (8 MB)
/// and stores bytes on the Ethiopian-resident volume — the app keeps nothing.
class DocumentUploadScreen extends StatefulWidget {
  const DocumentUploadScreen({
    super.key,
    required this.repo,
    required this.onDone,
  });

  final OnboardingRepository repo;
  final VoidCallback onDone;

  @override
  State<DocumentUploadScreen> createState() => _DocumentUploadScreenState();
}

class _DocumentUploadScreenState extends State<DocumentUploadScreen> {
  static const _optionalTypes = <String, String>{
    'NATIONAL_ID': 'National ID',
    'INSURANCE': 'Insurance',
    'OWNERSHIP': 'Ownership',
    'ASSOCIATION_CARD': 'Association card',
  };

  final _picker = ImagePicker();
  String? _errorKey;
  bool _busy = false;
  /// doc_type -> picked file (uploaded ones move into [_uploaded]).
  final Map<String, File> _staged = {};
  final Set<String> _uploaded = {};

  Future<void> _pick(String docType) async {
    final x = await _picker.pickImage(source: ImageSource.gallery, maxWidth: 2048, imageQuality: 80);
    if (x == null) return;
    setState(() {
      _staged[docType] = File(x.path);
      _errorKey = null;
    });
  }

  Future<void> _uploadAll() async {
    setState(() {
      _busy = true;
      _errorKey = null;
    });
    try {
      for (final entry in _staged.entries.toList()) {
        await widget.repo.uploadDocument(docType: entry.key, file: entry.value);
        _uploaded.add(entry.key);
        _staged.remove(entry.key);
      }
      if (!mounted) return;
      widget.onDone();
    } on OnboardingException {
      if (!mounted) return;
      setState(() => _errorKey = 'upload');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Widget _docTile(BuildContext context, String docType, String label, {bool mandatory = false}) {
    final l = AppLocalizations.of(context);
    final done = _uploaded.contains(docType);
    final staged = _staged[docType];
    return Card(
      child: ListTile(
        leading: Icon(done ? Icons.check_circle : Icons.description_outlined,
            color: done ? Colors.green : null),
        title: Text(mandatory ? l.obLicenseDocMandatory : label),
        subtitle: done
            ? Text(l.obUploaded)
            : staged != null
                ? Text(staged.path.split('/').last)
                : null,
        trailing: done
            ? null
            : FilledButton.tonal(
                onPressed: _busy ? null : () => _pick(docType),
                child: Text(l.obTakePhoto),
              ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final hasLicense = _uploaded.contains('DRIVING_LICENSE') || _staged.containsKey('DRIVING_LICENSE');
    return Scaffold(
      appBar: AppBar(title: Text(l.obDocsTitle)),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              _docTile(context, 'DRIVING_LICENSE', '', mandatory: true),
              const SizedBox(height: 8),
              ..._optionalTypes.entries.map((e) => _docTile(context, e.key, e.value)),
              if (_errorKey != null) ...[
                const SizedBox(height: 8),
                Text(l.obUploadFailed, style: TextStyle(color: Theme.of(context).colorScheme.error)),
              ],
              const SizedBox(height: 24),
              FilledButton(
                // License first: the button stays disabled until one license
                // photo is taken or uploaded (activation gate server-side too).
                onPressed: _busy || !hasLicense ? null : _uploadAll,
                child: Padding(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  child: Text(l.obSubmitRegister),
                ),
              ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: _busy ? null : widget.onDone,
                child: Text(l.obSkipOptionalDocs),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
