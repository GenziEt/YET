import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../l10n/app_localizations.dart';
import 'pilot_service.dart';

/// Phase 4 offline-map pre-download screen (§Phase 4 deliverable: "Offline map
/// tile cache for pilot region (bounding box downloaded before departure using
/// self-hosted tile server)"). The driver taps ONE button; [PilotService
/// .prefetchTiles] walks the Addis-corridor bounding box zoom by zoom against
/// AppConfig.tileUrlTemplate (self-hosted tiles only — §1.9.3 forbids public
/// OSM servers in production) and reports progress here as a linear bar.
///
/// Resumable by design: already-downloaded tiles are skipped, so a mid-route
/// re-run after a signal drop costs nothing but the missing tiles.
class OfflineMapScreen extends StatefulWidget {
  const OfflineMapScreen({super.key, this.runtime});

  final AppRuntime? runtime;

  @override
  State<OfflineMapScreen> createState() => _OfflineMapScreenState();
}

class _OfflineMapScreenState extends State<OfflineMapScreen> {
  static const _bounds = TileBounds.addisCorridor;

  bool _running = false;
  TileProgress? _progress;

  Future<void> _start() async {
    final runtime = widget.runtime;
    if (runtime == null || _running) return;
    setState(() {
      _running = true;
      _progress = TileProgress(
          done: 0, total: _bounds.countTiles(), failed: 0, finished: false);
    });
    TileProgress result;
    try {
      result = await runtime.pilot.prefetchTiles(
        _bounds,
        onProgress: (p) {
          if (!mounted) return;
          setState(() => _progress = p);
        },
      );
    } catch (_) {
      // Tile server unreachable (driver is already off-grid): show zero
      // progress honestly instead of pretending the download ran.
      if (!mounted) return;
      setState(() {
        _running = false;
        _progress = null;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(AppLocalizations.of(context).feedbackFailed)),
      );
      return;
    }
    if (!mounted) return;
    setState(() {
      _running = false;
      _progress = result;
    });
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = _progress;
    final finished = p != null && p.finished && !_running;
    return Scaffold(
      appBar: AppBar(title: Text(l.offlineMapTitle)),
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.download_for_offline_outlined,
                  size: 64, color: Colors.green),
              const SizedBox(height: 12),
              Text(l.offlineMapBody,
                  style: const TextStyle(fontSize: 18, height: 1.4)),
              const SizedBox(height: 24),
              if (p != null) ...[
                LinearProgressIndicator(value: p.fraction),
                const SizedBox(height: 8),
                Text(finished
                    ? l.offlineMapDone(p.done - p.failed, p.failed)
                    : l.offlineMapProgress(p.done, p.total),
                    style: const TextStyle(fontSize: 16)),
              ],
              const Spacer(),
              FilledButton(
                onPressed: (_running || widget.runtime == null) ? null : _start,
                style: FilledButton.styleFrom(
                    minimumSize: const Size.fromHeight(64)),
                child: _running
                    ? const SizedBox(
                        width: 24,
                        height: 24,
                        child: CircularProgressIndicator(strokeWidth: 3))
                    : Text(l.offlineMapStart),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
