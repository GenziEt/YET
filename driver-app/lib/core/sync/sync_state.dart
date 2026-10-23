/// Offline Contract §1.8.1 — client sync state machine, implemented in Phase 1 but
/// the enum + transition rules are frozen here so every engineer codes against them:
///
///   PENDING ──(uploader claims batch)──▶ UPLOADING ──(server 200 ACK)──▶ ACKED ──(7d or >50MB)──▶ PRUNED
///      ▲                                     │
///      └────────(HTTP failure, backoff ≤5min)┘
///
/// Hard rules (do not violate):
///  * A record is NEVER deleted before it reaches ACKED (no data loss).
///  * GPS fixes are never discarded even at storage cap; sensor events may be
///    downsampled (§1.8.6).
///  * UPLOADING rows that were never ACKed return to PENDING on process restart.
enum SyncState { pending, uploading, acked, pruned }

class SyncTransitions {
  static const allowed = {
    SyncState.pending: {SyncState.uploading},
    SyncState.uploading: {SyncState.acked, SyncState.pending}, // pending on failure/backoff
    SyncState.acked: {SyncState.pruned},
    SyncState.pruned: <SyncState>{},
  };

  static bool can(SyncState from, SyncState to) => allowed[from]!.contains(to);
}
