import 'dart:collection';
import 'dart:typed_data';

/// Bounded LRU store for decoded tile snapshots (§STARTUP-OPTIMIZATION.md §5.1,
/// P5 "map tile snapshot LRU + cross-fade").
///
/// Why this exists: [OfflineTileImage] used to read each tile file from disk
/// and hand a fresh `MemoryImage(bytes)` to the image pipeline every time the
/// map rebuilt — meaning repeated PNG *decodes* of the same tile during pan/
/// zoom on 2 GB-RAM pilot handsets (§1.2). This cache stores the raw encoded
/// bytes keyed by (root,z,x,y) with strict LRU eviction so:
///  * a tile that scrolls back into view is served with ZERO file I/O;
///  * memory stays bounded by construction ([maxEntries] tiles, ~36 × ≤50 KB
///    ≈ <2 MB worst case — safe next to the SQLite write-through pool);
///  * negative results (missing tile) are cached too, so a hole in the
///    prefetch set doesn't re-stat the filesystem on every rebuild.
///
/// Design notes (production-grade constraints):
///  * Pure Dart, no Flutter imports → unit-testable headless and free to use
///    from services as well as widgets.
///  * Single-threaded by contract (Dart UI isolate): no locks needed; all
///    operations are O(1) via [LinkedHashMap] insertion-order semantics.
///  * Process-wide singleton via [shared]; tests construct their own instance
///    through the constructor and never mutate [shared].
class TileSnapshotCache {
  /// Max number of entries (hit OR miss) retained. Sized for a full 2×3
  /// viewport at high zoom plus ~4× lookahead margin for panning.
  static const int defaultMaxEntries = 36;

  final int maxEntries;
  final LinkedHashMap<String, _TileEntry> _entries = LinkedHashMap();
  int _hits = 0;
  int _misses = 0;

  TileSnapshotCache({this.maxEntries = defaultMaxEntries})
      : assert(maxEntries > 0, 'cache must retain at least one entry');

  /// Process-wide instance used by the production widget path. Kept separate
  /// from test instances so a test can never observe or skew real counters.
  static final TileSnapshotCache shared = TileSnapshotCache();

  /// Canonical key for one tile inside one cache root. Normalises trailing
  /// slashes so callers passing `dir.path` vs `dir.path + '/'` collide.
  static String keyFor(String root, int z, int x, int y) {
    var r = root;
    while (r.length > 1 && r.endsWith('/')) {
      r = r.substring(0, r.length - 1);
    }
    return '$r/$z/$x/$y';
  }

  /// Diagnostics surfaced to debug tooling / CI probes (never per-frame).
  int get length => _entries.length;
  int get hits => _hits;
  int get misses => _misses;

  /// Returns the cached record for [key]. `null` means "not in cache"
  /// (unknown); a record with `bytes == null` is a cached MISS (the file was
  /// absent/unreadable when last probed) — callers may trust it for the
  /// current session but should re-probe after a prefetch completes
  /// (see [invalidateRoot]).
  TileSnapshot? lookup(String key) {
    final e = _entries.remove(key); // detach → re-insert marks most-recent
    if (e == null) {
      _misses++;
      return null;
    }
    _hits++;
    _entries[key] = e;
    return e.snapshot;
  }

  /// Stores a hit (decoded-ready PNG bytes) or a miss (`bytes == null`).
  /// Evicts the least-recently-used entry when over capacity.
  void put(String key, Uint8List? bytes) {
    _entries.remove(key);
    _entries[key] = _TileEntry(TileSnapshot(bytes));
    while (_entries.length > maxEntries) {
      _entries.remove(_entries.keys.first); // O(1) LRU evict
    }
  }

  /// Drop every entry belonging to a cache root — called after a tile
  /// prefetch run so freshly downloaded files replace cached misses without
  /// waiting for natural eviction.
  void invalidateRoot(String root) {
    var r = root;
    while (r.length > 1 && r.endsWith('/')) {
      r = r.substring(0, r.length - 1);
    }
    final prefix = '$r/';
    _entries.removeWhere((k, _) => k.startsWith(prefix));
  }

  /// Full reset (logout / storage-warning trim / tests).
  void clear() {
    _entries.clear();
    _hits = 0;
    _misses = 0;
  }
}

/// Immutable value stored per tile key. [bytes] is the encoded PNG exactly as
/// read from the prefetch cache; `null` records a confirmed missing tile.
class TileSnapshot {
  const TileSnapshot(this.bytes);
  final Uint8List? bytes;
  bool get isHit => bytes != null;
}

class _TileEntry {
  _TileEntry(this.snapshot);
  final TileSnapshot snapshot;
}
