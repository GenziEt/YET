import 'dart:io' show Directory, File;
import 'dart:typed_data' show Uint8List;

import 'package:flutter/material.dart';

import '../../core/app_runtime.dart';
import '../../core/cache/tile_snapshot_cache.dart';
import '../../core/theme/yet_theme.dart';
import '../../core/widgets/status_chip.dart';
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
    this.cache,
    this.fadeDuration = const Duration(milliseconds: 180),
  });

  final String directory;
  final int z;
  final int x;
  final int y;
  final Widget Function(BuildContext)? errorBuilder;

  /// §5.1/P5 seam: bounded LRU in front of the disk read path. Defaults to
  /// the process-wide [TileSnapshotCache.shared]; tests inject a private
  /// instance so shared counters/entries never leak between cases.
  final TileSnapshotCache? cache;

  /// AnimatedCrossFade duration for the snapshot → live-tile transition
  /// (§5.1 "cross-fade from last-known snapshot"). Zero/negative disables
  /// the animation (widget degrades to an instant swap).
  final Duration fadeDuration;

  /// Canonical on-disk location of one tile inside a prefetch cache root.
  static String filePathFor(String root, int z, int x, int y) =>
      '$root${z.toString()}/${x.toString()}/${y.toString()}.png';

  @override
  State<OfflineTileImage> createState() => _OfflineTileImageState();
}

class _OfflineTileImageState extends State<OfflineTileImage>
    with WidgetsBindingObserver {
  ImageProvider? _provider;
  bool _resolved = false;
  // Cross-fade pair (§5.1): the previous provider stays painted underneath
  // while the new one fades in — panning/zooming never flashes grey boxes.
  ImageProvider? _previous;
  int _fadeGeneration = 0;
  bool _paused = false;

  TileSnapshotCache get _cache => widget.cache ?? TileSnapshotCache.shared;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _resolve();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Backgrounded mid-map-view: drop pending work; re-resolve on resume so
    // tiles written by a prefetch that finished while backgrounded appear.
    _paused = state != AppLifecycleState.resumed;
    if (!_paused && _resolved) {
      _resolved = false;
      setState(() {});
      _resolve();
    }
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
    } else if (old.cache != widget.cache) {
      // Cache swapped (e.g. test hot-reload seam): force a fresh probe.
      _resolved = false;
      _resolve();
    }
  }

  Future<void> _resolve() async {
    final key =
        TileSnapshotCache.keyFor(widget.directory, widget.z, widget.x, widget.y);
    ImageProvider? p;
    final cached = _cache.lookup(key);
    if (cached != null) {
      // Hit OR cached miss — zero filesystem syscalls on this rebuild.
      final bytes = cached.bytes;
      p = bytes == null ? null : MemoryImage(bytes);
    } else {
      Uint8List? bytes;
      try {
        final f = File(OfflineTileImage.filePathFor(
            widget.directory, widget.z, widget.x, widget.y));
        if (await f.exists()) {
          bytes = await f.readAsBytes();
        }
      } catch (_) {
        // Unreadable storage → treated exactly like a missing tile (and the
        // miss is cached so we do not re-probe every frame).
        bytes = null;
      }
      _cache.put(key, bytes);
      p = bytes == null ? null : MemoryImage(bytes);
    }
    if (!mounted || _paused) return;
    setState(() {
      // Snapshot → live / live → new-live transitions animate via
      // AnimatedCrossFade below; remember what was on screen.
      if (_provider != null && !identical(_provider, p)) {
        _previous = _provider;
      }
      _provider = p;
      _resolved = true;
      _fadeGeneration++;
    });
  }

  Widget _tile(ImageProvider p) => Image(image: p, gaplessPlayback: true);

  Widget _placeholder(BuildContext context) {
    final eb = widget.errorBuilder;
    if (eb != null) return eb(context);
    return const ColoredBox(color: Color(0xFFE5E7EB));
  }

  @override
  Widget build(BuildContext context) {
    if (!_resolved) return const SizedBox.shrink();
    final p = _provider;
    final prev = _previous;
    final dur = widget.fadeDuration;
    // Cross-fade (§5.1): outgoing snapshot fades out over the incoming tile.
    // The generation key restarts the animation whenever content changes.
    if (prev != null && p != null && dur > Duration.zero) {
      return AnimatedCrossFade(
        key: ValueKey<int>(_fadeGeneration),
        firstChild: _tile(prev),
        secondChild: _tile(p),
        firstCurve: Curves.easeOut,
        secondCurve: Curves.easeIn,
        sizeCurve: Curves.easeOut,
        crossFadeState: CrossFadeState.showSecond,
        duration: dur,
      );
    }
    if (p == null) {
      // Missing tile: if a snapshot was previously visible (e.g. file pruned
      // mid-session), keep painting it instead of flashing the placeholder.
      return prev != null ? _tile(prev) : _placeholder(context);
    }
    return _tile(p);
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
        style: const TextStyle(
          fontSize: 11, fontWeight: FontWeight.w500, color: Color(0xDE000000)),
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
    // Refresh the root so the preview picks up freshly written files even
    // if it had not resolved before the download started. The existence
    // check must complete before setState (setState callbacks are sync).
    final rootExists = await Directory(result.cacheRoot).exists();
    // P5 snapshot-LRU coherence: tiles written by this prefetch replace
    // entries that were cached as MISSes while the download was in flight.
    // Dropping the whole root is O(cache size) and cheaper than tracking
    // per-tile generation numbers; the LRU refills lazily on next paint.
    TileSnapshotCache.shared.invalidateRoot(result.cacheRoot);
    setState(() {
      _running = false;
      _progress = result;
      if (rootExists) _cacheRoot = result.cacheRoot;
    });
  }

  /// Offline map preview (§Phase 4 completion item "the map widget reads from
  /// the downloaded cache directory when offline"): renders the corridor
  /// centre tile at max zoom straight from the prefetch cache — no network —
  /// with the required attribution strip underneath. Framed like a real map
  /// card: rounded clip, hairline border, credit line on a tinted footer.
  Widget _mapPreview(AppLocalizations l, String root) {
    final z = _bounds.maxZoom;
    final cx = ((_bounds.xRange(z)[0] + _bounds.xRange(z)[1]) / 2).floor();
    final cy = ((_bounds.yRange(z)[0] + _bounds.yRange(z)[1]) / 2).floor();
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: const Color(0x1A000000)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            height: 180,
            child: OfflineTileImage(
              directory: root,
              z: z,
              x: cx,
              y: cy,
              errorBuilder: (_) => Container(
                color: YetTheme.canvas,
                child: Center(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.map_outlined,
                            size: 32, color: YetTheme.inkSoft.withAlpha(0xB2)),
                        const SizedBox(height: 8),
                        Text(l.offlineMapNoTiles,
                            textAlign: TextAlign.center,
                            style: const TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w600,
                                color: YetTheme.inkSoft)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          // Attribution stays visible online AND offline (§1.9.3) — now on a
          // quiet tinted footer strip instead of floating text.
          Container(
            color: YetTheme.canvas,
            padding: const EdgeInsets.only(top: 2),
            child: const TileAttribution(),
          ),
        ],
      ),
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
        child: LayoutBuilder(
          builder: (context, constraints) {
            // Responsive contract shared with home/feedback screens: content
            // centers at 640 px on tablets rather than stretching.
            final wide = constraints.maxWidth > 720;
            return Align(
              alignment: Alignment.topCenter,
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: wide ? 640 : double.infinity),
                child: ListView(
                  padding: EdgeInsets.symmetric(
                      horizontal: wide ? 32 : 20, vertical: 20),
                  children: [
                    // ── Intro card: icon badge + heading + explainer copy.
                    SoftCard(
                      padding: const EdgeInsets.all(18),
                      child: Row(
                        children: [
                          Container(
                            width: 48,
                            height: 48,
                            decoration: BoxDecoration(
                              color: StatusTokens.okBg,
                              borderRadius: BorderRadius.circular(15),
                            ),
                            child: const Icon(Icons.download_for_offline_rounded,
                                color: StatusTokens.okFg, size: 26),
                          ),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  l.offlineMapHeading,
                                  style: const TextStyle(
                                    fontSize: 18,
                                    fontWeight: FontWeight.w800,
                                    color: YetTheme.ink,
                                    height: 1.2,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  l.offlineMapBody,
                                  style: const TextStyle(
                                      fontSize: 15,
                                      height: 1.4,
                                      color: YetTheme.inkSoft),
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    if (root != null) ...[
                      const SizedBox(height: 16),
                      _mapPreview(l, root),
                    ],
                    if (p != null) ...[
                      const SizedBox(height: 16),
                      SoftCard(
                        padding: const EdgeInsets.all(18),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                Text(
                                  l.offlineMapProgressHeading,
                                  style: const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w700,
                                    color: YetTheme.ink,
                                  ),
                                ),
                                const Spacer(),
                                StatusChip(
                                  icon: finished
                                      ? (p.failed > 0
                                          ? Icons.warning_amber_rounded
                                          : Icons.done_all_rounded)
                                      : Icons.downloading_rounded,
                                  label: finished
                                      ? l.offlineMapDone(p.done - p.failed, p.failed)
                                      : l.offlineMapProgress(p.done, p.total),
                                  tone: finished
                                      ? (p.failed > 0
                                          ? StatusTone.warn
                                          : StatusTone.ok)
                                      : StatusTone.neutral,
                                  dense: true,
                                ),
                              ],
                            ),
                            const SizedBox(height: 12),
                            ClipRRect(
                              borderRadius: BorderRadius.circular(999),
                              child: LinearProgressIndicator(
                                value: p.fraction,
                                minHeight: 10,
                                backgroundColor: YetTheme.canvas,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                    const SizedBox(height: 20),
                    FilledButton.icon(
                      onPressed: (_running || widget.runtime == null) ? null : _start,
                      icon: _running
                          ? const SizedBox(
                              width: 22,
                              height: 22,
                              child: CircularProgressIndicator(
                                  strokeWidth: 2.6, color: Colors.white))
                          : const Icon(Icons.map_rounded, size: 22),
                      label: Text(l.offlineMapStart),
                      style: FilledButton.styleFrom(
                          minimumSize: const Size.fromHeight(64),
                          shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(20))),
                    ),
                  ],
                ),
              ),
            );
          },
        ),
      ),
    );
  }
}
