/**
 * Module 3 — Trip Engine: PILOT BATTERY KERNEL (Phase 4 field-pilot gate).
 *
 * Pure functions, zero I/O, zero Date.now() — same discipline as state_machine.ts:
 * every drain estimate derives from EVENT timestamps and event-time-anchored
 * samples carried by the data itself (§1.8.3), so a late/offline-replayed battery
 * sample produces the identical estimate as an in-order one. That determinism is
 * what makes the pilot's median-drain number trustworthy when audited after the
 * two-week field run.
 *
 * Gate arithmetic (blueprint Part 4 + Phase 4):
 *   Battery: median driver-phone drain ≤ 20% per 8-hour shift (target);
 *   if measured MEDIAN exceeds 25%/8h → return to Phase 2 and re-tune sensor
 *   gating thresholds before proceeding. Both bounds are constants here so the
 *   integration script, unit tests, and docs cannot drift apart.
 */
export const SHIFT_HOURS = 8; // normalization window for /8h figures
export const BATTERY_TARGET_PCT_PER_SHIFT = 20; // §Part 4 success metric
export const BATTERY_GATE_MAX_PCT_PER_SHIFT = 25; // Phase 4 gate: exceed ⇒ back to P2
/**
 * Estimate one trip's battery drain from its (start, end) samples.
 * Rules:
 *  - both phases required; charging on either side makes the trip unusable
 *    (driver plugged in at a depot — extremely common in Ethiopian fleets);
 *  - negative drain (clock skew / OS rounding) is reported, not silently
 *    clamped into the median — the caller filters `drain_pct_per_8h === null`;
 *  - durations under MIN_VALID_TRIP_S are dropped: a 2-minute trip's 1% delta
 *    extrapolates to absurd /8h numbers.
 */
export const MIN_VALID_TRIP_S = 15 * 60; // quarter-hour floor for extrapolation
export function estimateTripDrain(tripStartedAtMs, start, end) {
    const iso = new Date(tripStartedAtMs).toISOString();
    if (!start || !end) {
        return { trip_started_at: iso, duration_s: 0, raw_drain_pct: null, drain_pct_per_8h: null, reason: 'insufficient_samples' };
    }
    const durationS = Math.max(0, (end.takenAtMs - start.takenAtMs) / 1000);
    const base = { trip_started_at: iso, duration_s: Math.round(durationS) };
    if (start.charging || end.charging) {
        return { ...base, raw_drain_pct: null, drain_pct_per_8h: null, reason: 'charging' };
    }
    const raw = start.pct - end.pct;
    if (raw < 0) {
        return { ...base, raw_drain_pct: raw, drain_pct_per_8h: null, reason: 'negative_drain' };
    }
    if (durationS < MIN_VALID_TRIP_S) {
        return { ...base, raw_drain_pct: raw, drain_pct_per_8h: null, reason: 'insufficient_samples' };
    }
    const perShift = (raw / durationS) * (SHIFT_HOURS * 3600);
    return { ...base, raw_drain_pct: raw, drain_pct_per_8h: Math.round(perShift * 10) / 10 };
}
/** Median of a numeric array (empty ⇒ null). Deterministic, no deps. */
export function median(values) {
    if (values.length === 0)
        return null;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
/**
 * The Phase 4 gate decision, computed ONLY from usable estimates
 * (drain_pct_per_8h non-null). With fewer than MIN_TRIPS_FOR_VERDICT samples the
 * verdict is INSUFFICIENT_DATA — the pilot must not "pass" on three trips.
 */
export const MIN_TRIPS_FOR_VERDICT = 10;
export function judgePilotBattery(estimates) {
    const usable = estimates
        .map((e) => e.drain_pct_per_8h)
        .filter((v) => v !== null);
    const med = median(usable);
    const sorted = [...usable].sort((a, b) => a - b);
    const p90 = sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)] : null;
    if (med === null || usable.length < MIN_TRIPS_FOR_VERDICT) {
        return { trips_measured: usable.length, median_pct_per_8h: med, p90_pct_per_8h: p90,
            target_met: false, gate_failed: false, verdict: 'INSUFFICIENT_DATA' };
    }
    if (med > BATTERY_GATE_MAX_PCT_PER_SHIFT) {
        return { trips_measured: usable.length, median_pct_per_8h: med, p90_pct_per_8h: p90,
            target_met: false, gate_failed: true, verdict: 'GATE_FAIL' };
    }
    if (med <= BATTERY_TARGET_PCT_PER_SHIFT) {
        return { trips_measured: usable.length, median_pct_per_8h: med, p90_pct_per_8h: p90,
            target_met: true, gate_failed: false, verdict: 'PASS' };
    }
    return { trips_measured: usable.length, median_pct_per_8h: med, p90_pct_per_8h: p90,
        target_met: false, gate_failed: false, verdict: 'BETWEEN_TARGET_AND_GATE' };
}
export const RECONSTRUCTION_MIN_ACCURACY = 0.95; // ≥95% gate (Phase 4 deliverable)
/** Accuracy of offline replay: stored/sent over the audited window. */
export function reconstructionAccuracy(a) {
    if (a.offline_sent <= 0)
        return 1; // nothing offline collected ⇒ vacuously perfect
    return a.offline_stored / a.offline_sent;
}
export function reconstructionGatePasses(a) {
    return reconstructionAccuracy(a) >= RECONSTRUCTION_MIN_ACCURACY;
}
//# sourceMappingURL=pilot_battery.js.map