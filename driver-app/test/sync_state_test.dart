import 'package:flutter_test/flutter_test.dart';
import 'package:yet_driver/core/cache/sync_state.dart';

/// Offline Contract unit gates runnable WITHOUT a device (flutter test).
void main() {
  group('sync state machine (§1.8.1)', () {
    test('happy path transitions are legal', () {
      expect(SyncTransitions.can(SyncState.pending, SyncState.uploading), isTrue);
      expect(SyncTransitions.can(SyncState.uploading, SyncState.acked), isTrue);
      expect(SyncTransitions.can(SyncState.acked, SyncState.pruned), isTrue);
    });
    test('failure returns UPLOADING to PENDING with backoff', () {
      expect(SyncTransitions.can(SyncState.uploading, SyncState.pending), isTrue);
    });
    test('no data loss: PENDING/UPLOADING can never go straight to PRUNED', () {
      expect(SyncTransitions.can(SyncState.pending, SyncState.pruned), isFalse);
      expect(SyncTransitions.can(SyncState.uploading, SyncState.pruned), isFalse);
    });
    test('PRUNED is terminal', () {
      for (final s in SyncState.values) {
        expect(SyncTransitions.can(SyncState.pruned, s), isFalse);
      }
    });
  });
}
