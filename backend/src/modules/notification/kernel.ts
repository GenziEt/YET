/**
 * Module 5 — Notification: pure delivery kernel (Phase 5).
 *
 * Zero I/O, zero clock reads — same discipline as trip_engine/state_machine.ts
 * and pilot_battery.ts. Everything time-dependent arrives as a parameter, so
 * the §1.4 separation-timer decision is reproducible in unit tests AND stable
 * across late/offline replays (§1.8.3): a batch that arrives 6 hours late must
 * produce the SAME notify/no-notify verdict for the same logical moment.
 */

/** Blueprint §1.4 default; overridable via TRIP_SEPARATION_NOTIFY_MIN. */
export const SEPARATION_NOTIFY_MIN_DEFAULT = 45;

export type SeparationTimerInput = {
  /** Event time (epoch ms) the driver separated from the vehicle. */
  separatedAtMs: number;
  /** Wall-clock "now" (epoch ms) at scan time — passed in, never read here. */
  nowMs: number;
  /** Fleet-manager threshold, minutes. */
  thresholdMin: number;
  /** Durable already-notified marker (driver_separation_log.notified_fleet_manager). */
  alreadyNotified: boolean;
};

export type SeparationTimerDecision = {
  fire: boolean;
  reason: 'FIRED' | 'ALREADY_NOTIFIED' | 'BELOW_THRESHOLD';
  minutes_since: number;
};

/**
 * Decide whether the 45-minute separation alert should fire NOW.
 * Rules:
 *  - elapsed minutes are measured against EVENT time of separation vs the scan
 *    instant (device clock carried by the data), never received_at;
 *  - an incident already flagged notified NEVER re-fires — this is what makes
 *    repeated window recomputes (every batch, every replay) idempotent together
 *    with the notification_log uq_notif_dedupe constraint;
 *  - exactly-at-threshold fires (>= semantics; the timer is a floor, not a gate).
 */
export function decideSeparationTimer(input: SeparationTimerInput): SeparationTimerDecision {
  const minutesSince = Math.floor((input.nowMs - input.separatedAtMs) / 60_000);
  if (input.alreadyNotified) {
    return { fire: false, reason: 'ALREADY_NOTIFIED', minutes_since: minutesSince };
  }
  if (minutesSince >= input.thresholdMin) {
    return { fire: true, reason: 'FIRED', minutes_since: minutesSince };
  }
  return { fire: false, reason: 'BELOW_THRESHOLD', minutes_since: minutesSince };
}

/** Stable logical-event identity for dedupe (§1.8.2/§1.8.3 pattern applied to notifications). */
export function separationDedupeKey(separationId: string): string {
  return `sep:${separationId}`;
}
export function tripEventDedupeKey(tripId: string, eventType: string, eventTimestampMs: number): string {
  return `trip:${tripId}:${eventType}:${eventTimestampMs}`;
}

export type TemplateVars = Record<string, string | number>;

/** Render {{placeholder}} variables into template text. Unknown keys → empty string
 *  (a missing variable must never leak raw braces into a driver's notification). */
export function renderTemplate(text: string, vars: TemplateVars): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(vars[k] ?? ''));
}

/** Pick recipient language: user locale wins; unknown/absent falls back to English. */
export function pickLocale(locale: string | null | undefined): 'en' | 'am' {
  return locale === 'am' ? 'am' : 'en';
}

export type RenderedMessage = { title: string; body: string; locale: 'en' | 'am' };

export function renderMessage(
  t: { title_en: string; body_en: string; title_am: string; body_am: string },
  locale: 'en' | 'am',
  vars: TemplateVars,
): RenderedMessage {
  return locale === 'am'
    ? { locale, title: renderTemplate(t.title_am, vars), body: renderTemplate(t.body_am, vars) }
    : { locale, title: renderTemplate(t.title_en, vars), body: renderTemplate(t.body_en, vars) };
}
