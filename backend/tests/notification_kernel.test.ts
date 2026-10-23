import { describe, it, expect } from 'vitest';
import {
  decideSeparationTimer, separationDedupeKey, tripEventDedupeKey,
  renderTemplate, pickLocale, renderMessage, SEPARATION_NOTIFY_MIN_DEFAULT,
} from '../src/modules/notification/kernel.js';

/**
 * Phase 5 (F) — PURE notification kernel units. No DB, no clock reads: every
 * input is passed in explicitly (§1.8.3 determinism discipline).
 */

const T0 = Date.parse('2026-10-22T10:00:00Z');
const MIN = 60_000;

describe('decideSeparationTimer', () => {
  it('BELOW_THRESHOLD at threshold-1 minute', () => {
    const d = decideSeparationTimer({
      separatedAtMs: T0, nowMs: T0 + 44 * MIN + 59_999, thresholdMin: 45, alreadyNotified: false,
    });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('BELOW_THRESHOLD');
    expect(d.minutes_since).toBe(44); // floor(), not round()
  });

  it('FIRED exactly at the threshold (>= semantics)', () => {
    const d = decideSeparationTimer({
      separatedAtMs: T0, nowMs: T0 + 45 * MIN, thresholdMin: 45, alreadyNotified: false,
    });
    expect(d.fire).toBe(true);
    expect(d.reason).toBe('FIRED');
    expect(d.minutes_since).toBe(45);
  });

  it('ALREADY_NOTIFIED takes precedence over an overdue timer', () => {
    const d = decideSeparationTimer({
      separatedAtMs: T0, nowMs: T0 + 120 * MIN, thresholdMin: 45, alreadyNotified: true,
    });
    expect(d.fire).toBe(false);
    expect(d.reason).toBe('ALREADY_NOTIFIED');
    expect(d.minutes_since).toBe(120); // still reported honestly
  });

  it('floor() minutes math never rounds up a 44m59.999s gap to 45', () => {
    const d = decideSeparationTimer({
      separatedAtMs: T0, nowMs: T0 + 45 * MIN - 1, thresholdMin: 45, alreadyNotified: false,
    });
    expect(d.fire).toBe(false);
    expect(d.minutes_since).toBe(44);
  });

  it('default threshold matches blueprint §1.4 (45 min)', () => {
    expect(SEPARATION_NOTIFY_MIN_DEFAULT).toBe(45);
  });
});

describe('dedupe key shapes', () => {
  it('separation keys are sep:<id> (per-recipient suffix added by the queue shell)', () => {
    expect(separationDedupeKey('aaaa1111-2222-3333-4444-555566667777')).toBe('sep:aaaa1111-2222-3333-4444-555566667777');
  });
  it('trip event keys carry trip, type and EVENT timestamp ms (replay-stable)', () => {
    expect(tripEventDedupeKey('t1', 'TRIP_STARTED', T0)).toBe(`trip:t1:TRIP_STARTED:${T0}`);
    // same logical event re-derived later -> identical key -> ON CONFLICT no-op
    expect(tripEventDedupeKey('t1', 'TRIP_STARTED', T0)).toBe(tripEventDedupeKey('t1', 'TRIP_STARTED', T0));
  });
});

describe('renderTemplate', () => {
  it('substitutes known vars', () => {
    expect(renderTemplate('{{plate}} entered {{zone}}.', { plate: 'AA-1234', zone: 'Bole depot' }))
      .toBe('AA-1234 entered Bole depot.');
  });
  it('blanks UNKNOWN keys — raw braces must never leak to a driver', () => {
    expect(renderTemplate('Distance {{distance_km}} km', {})).toBe('Distance  km');
  });
  it('numbers stringify; repeated keys all replace', () => {
    expect(renderTemplate('{{n}}/{{n}}', { n: 7 })).toBe('7/7');
  });
});

describe('pickLocale', () => {
  it('am wins only for exact am', () => {
    expect(pickLocale('am')).toBe('am');
    expect(pickLocale('en')).toBe('en');
    expect(pickLocale(null)).toBe('en');
    expect(pickLocale(undefined)).toBe('en');
    expect(pickLocale('fr')).toBe('en'); // unknown falls back to English
  });
});

describe('renderMessage', () => {
  const tpl = {
    title_en: 'Trip started', body_en: '{{plate}} started a trip.',
    title_am: 'ጉዞው ጀምሯል', body_am: '{{plate}} ጉዞ ጀምሯል።',
  };
  it('english branch', () => {
    const m = renderMessage(tpl, 'en', { plate: 'AA-90001' });
    expect(m.title).toBe('Trip started');
    expect(m.body).toBe('AA-90001 started a trip.');
  });
  it('amharic branch renders the am strings', () => {
    const m = renderMessage(tpl, 'am', { plate: 'AA-90001' });
    expect(m.title).toBe('ጉዞው ጀምሯል');
    expect(m.body).toContain('AA-90001');
  });
});
