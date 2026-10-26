import { describe, it, expect } from 'vitest';

// Same env bootstrap as tests/health.test.ts: importing the ingest module
// transitively loads config/env validation (DATABASE_URL/JWT_SECRET required).
process.env.DATABASE_URL ??= 'postgres://x:y@localhost:5432/z';
process.env.JWT_SECRET ??= 'test-secret-0123456789abcdef';

/**
 * Phase 2 completion-gate test (implementation instruction §Phase 2):
 * "sensor batch idempotency".
 *
 * The replay half of §1.8.2 is enforced by the ingest_batches.batch_id primary
 * key (`INSERT … ON CONFLICT (batch_id) DO NOTHING RETURNING` → empty row set
 * ⇒ already_received:true with zero duplicate records — see
 * src/modules/ingest/service.ts ingestSensorBatch; exercised end-to-end by
 * scripts/smoke.sh and the DB-gated phase0_gates suite when YET_TEST_DB is set).
 *
 * What THIS unit locks down without a database:
 *  * the exact wire contract the driver app produces
 *    (lib/core/cache/sensor_dao.dart encodeSensorBatchBody) validates against
 *    SensorBatchSchema/SensorEventSchema — kinds frozen to the post-Phase-2
 *    enum (audio_engine removed), batch_id must be a UUID (the idempotency key
 *    itself), event_timestamp must be absolute ISO-8601 (event-time ordering
 *    contract §1.8.3);
 *  * deterministic validation outcome for a REPLAYED payload: parse(encode(x))
 *    ≡ parse(x) — the schema is pure, so a duplicate submission can never
 *    produce a different accepted-record shape than the original.
 */

const BATCH_ID = '3f2a7b6c-1111-4222-8333-aabbccddeeff';

/** Byte-for-byte the JSON shape encodeSensorBatchBody() emits on device. */
function deviceEncodedSensorBatch() {
  return {
    batch_id: BATCH_ID,
    client_sent_at: '2026-10-20T08:03:12Z',
    events: [
      { event_timestamp: '2026-10-20T08:00:01Z', kind: 'accelerometer', payload: { values: [0.1, 0.0, 9.81] } },
      { event_timestamp: '2026-10-20T08:00:02Z', kind: 'gyroscope', payload: { values: [0, 0, 0.9] } },
      { event_timestamp: '2026-10-20T08:00:03Z', kind: 'harsh_brake', payload: { magnitude_mps2: 5.0, source: 'device' } },
      { event_timestamp: '2026-10-20T08:00:04Z', kind: 'harsh_accel', payload: { magnitude_mps2: 3.1, source: 'device' } },
      { event_timestamp: '2026-10-20T08:00:05Z', kind: 'turn', payload: { direction: 'right', peak_rate_dps: 60 } },
      { event_timestamp: '2026-10-20T08:00:06Z', kind: 'vibration_gate', payload: { state: 1 } },
    ],
  };
}

describe('sensor batch wire contract + replay determinism (§1.8.2, Phase 2)', () => {
  it('accepts the exact payload the driver app encodes, incl. every Phase 2 discrete kind', async () => {
    const { validateSensorBatchPayload } = await import('../src/modules/ingest/service.js');
    const parsed = validateSensorBatchPayload(deviceEncodedSensorBatch());
    expect(parsed.batch_id).toBe(BATCH_ID);
    expect(parsed.events.map((e) => e.kind)).toEqual([
      'accelerometer', 'gyroscope', 'harsh_brake', 'harsh_accel', 'turn', 'vibration_gate',
    ]);
  });

  it('replaying the identical encoded batch parses to an identical structure (pure-contract leg of idempotency)', async () => {
    const { validateSensorBatchPayload } = await import('../src/modules/ingest/service.js');
    const body = deviceEncodedSensorBatch();
    // A duplicate upload carries byte-identical JSON; validation is a pure
    // function ⇒ same result ⇒ the DB-level ON CONFLICT replay path sees the
    // same batch_id and returns already_received without inserting records.
    expect(validateSensorBatchPayload(JSON.parse(JSON.stringify(body))))
      .toEqual(validateSensorBatchPayload(body));
  });

  it('rejects a non-UUID batch_id — the idempotency key cannot be forged or lost', async () => {
    const { SensorBatchSchema } = await import('../src/modules/ingest/service.js');
    expect(SensorBatchSchema.safeParse({ ...deviceEncodedSensorBatch(), batch_id: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects audio_engine (Phase 2 option-b removal) and unknown kinds at the boundary', async () => {
    const { SensorEventSchema, SensorBatchSchema } = await import('../src/modules/ingest/service.js');
    expect(SensorEventSchema.safeParse({
      event_timestamp: '2026-10-20T08:00:00Z', kind: 'audio_engine', payload: {},
    }).success).toBe(false);
    const oneAudio = { ...deviceEncodedSensorBatch(), events: [{ event_timestamp: '2026-10-20T08:00:00Z', kind: 'audio_engine', payload: {} }] };
    expect(SensorBatchSchema.safeParse(oneAudio).success).toBe(false);
  });

  it('rejects empty batches and relative/non-ISO timestamps (event-time contract §1.8.3)', async () => {
    const { SensorBatchSchema } = await import('../src/modules/ingest/service.js');
    expect(SensorBatchSchema.safeParse({ ...deviceEncodedSensorBatch(), events: [] }).success).toBe(false);
    expect(SensorBatchSchema.safeParse({
      ...deviceEncodedSensorBatch(),
      events: [{ event_timestamp: '1729411200000', kind: 'turn', payload: {} }],
    }).success).toBe(false);
  });
});
