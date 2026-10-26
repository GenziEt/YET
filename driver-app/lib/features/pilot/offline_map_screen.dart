import 'dart:io' show Directory, File;

import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../l10n/app_localizations.dart';
import 'pilot_service.dart';

/// Offline tile read path (§Phase 4: "the map widget reads from the downloaded
/// cache directory when offline"). [OfflineTileImage] resolves a Web-Mercator
/// tile coordinate to the exact file layout written by [PilotService
/// .prefetchTiles] (`<app-support>/offline_tiles/{z}/{x}/{y}.png`) and decodes
/// it as an in-memory image — no network involved. Attribution is rendered
/// next to the map so self-hosted OSM-basis tiles keep their required credit
/// even fully offline.
class OfflineTileImage extends StatefulWidget {
  const OfflineTileImage({
    super.key,
    required this.directory,
    required this.z,
    required this.x,
    required this.y,
    this.errorBuilder,
  });

  final String directory;
  final int z;
  final int x;
  final int y;
  final Widget Function(BuildContext)? errorBuilder;

  /// Canonical on-disk location of one tile inside a prefetch cache root.
  static String filePathFor(String root, int z, int x, int y) =>
      '$root${z.toString()}/${x.toString()}/${y.toString()}.png';

  @override
  State<OfflineTileImage> createState() => _OfflineTileImageState();
}

class _OfflineTileImageState extends State<OfflineTileImage> {
  ImageProvider? _provider;
  bool _resolved = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _resolve();
  }

  @override
  void didUpdateWidget(covariant OfflineTileImage old) {
    super.didUpdateWidget(old);
    if (old.directory != widget.directory ||
        old.z != widget.z ||
        old.x != widget.x ||
        old.y != widget.y) {
      _provider = null;
      _resolved = false;
      _resolve();
    }
  }

  Future<void> _resolve() async {
    final path = OfflineTileImage.filePathFor(
        widget.directory, widget.z, widget.x, widget.y);
    ImageProvider? p;
    try {
      final f = File(path);
      if (await f.exists()) {
        p = MemoryImage(await f.readAsBytes());
      }
    } catch (_) {
      // Unreadable storage → treated exactly like a missing tile.
      p = null;
    }
    if (!mounted) return;
    setState(() {
      _provider = p;
      _resolved = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (!_resolved) return const SizedBox.shrink();
    final p = _provider;
    if (p == null) {
      final eb = widget.errorBuilder;
      if (eb != null) return eb(context);
      return const ColoredBox(color: Color(0xFFE5E7EB));
    }
    return Image(image: p, gaplessPlayback: true);
  }
}

/// Bottom attribution strip for the pilot map view (§1.9.3: self-hosted
/// tiles built on OpenStreetMap data — the credit must be visible online AND
/// offline). Uses only localized l10n strings (no hard-coded English).
class TileAttribution extends StatelessWidget {
  const TileAttribution({super.key});

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      child: Text(
        l.offlineMapAttribution,
        style: const TextStyle(fontSize: 11, color: Colors.black87),
      ),
    );
  }
}

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
  /// Absolute path of the prefetch cache root, filled by [_loadCacheRoot] at
  /// screen open — the read side of the offline tile contract.
  String? _cacheRoot;

  @override
  void initState() {
    super.initState();
    _loadCacheRoot();
  }

  Future<void> _loadCacheRoot() async {
    final runtime = widget.runtime;
    if (runtime == null) return;
    try {
      final dir = await runtime.pilot.tileCacheRoot();
      if (!mounted) return;
      setState(() => _cacheRoot = dir.path);
    } catch (_) {
      // Storage unavailable: preview honestly shows "no tiles cached".
    }
  }

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
      // Refresh the root so the preview picks up freshly written files even
      // if it had not resolved before the download started.
      _cacheRoot = (await Directory(result.cacheRoot).exists())
          ? result.cacheRoot
          : _cacheRoot;
    });
  }

  /// Offline map preview (§Phase 4 completion item "the map widget reads from
  /// the downloaded cache directory when offline"): renders the corridor
  /// centre tile at max zoom straight from the prefetch cache — no network —
  /// with the required attribution strip underneath.
  Widget _mapPreview(AppLocalizations l, String root) {
    final z = _bounds.maxZoom;
    final cx = ((_bounds.xRange(z)[0] + _bounds.xRange(z)[1]) / 2).floor();
    final cy = ((_bounds.yRange(z)[0] + _bounds.yRange(z)[1]) / 2).floor();
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SizedBox(
          height: 180,
          child: OfflineTileImage(
            directory: root,
            z: z,
            x: cx,
            y: cy,
            errorBuilder: (_) => ColoredBox(
              color: const Color(0xFFE5E7EB),
              child: Center(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: Text(l.offlineMapNoTiles,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 14)),
                ),
              ),
            ),
          ),
        ),
        const TileAttribution(),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final l = AppLocalizations.of(context);
    final p = _progress;
    final finished = p != null && p.finished && !_running;
    final root = _cacheRoot;
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
              if (root != null) ...[
                _mapPreview(l, root),
                const SizedBox(height: 16),
              ],
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
