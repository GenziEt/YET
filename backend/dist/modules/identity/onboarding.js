import multipart from '@fastify/multipart';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../../db/pool.js';
import { signAccessToken } from '../../lib/jwt.js';
import { audit } from '../../lib/audit.js';
import { env, isProd } from '../../config/env.js';
import { cacheGetJson, cacheSetJson, cacheDel } from '../../lib/redis.js';
/**
 * Module 1 — Driver onboarding WITHOUT a traditional login.
 *
 * Contract (docs/DRIVER-ONBOARDING.md, migration 0016):
 *   - A driver registers ONCE: phone OTP → personal + vehicle + trailer info →
 *     documents (license mandatory) → device pairing. There is no password and
 *     no recurring credential entry; the paired device IS the session, renewed
 *     silently via POST /auth/session/refresh while the backend says the
 *     pairing is valid (device not revoked, account active, fleet ACTIVE).
 *   - Identity = verified phone number (+ license number as corroboration),
 *     NEVER the truck plate. Trucks/trailers are ASSETS attached through
 *     time-bound assignments; changing equipment = new assignment, same account.
 *   - Registration lands in PENDING_REVIEW inside the 'Unassigned Fleet'
 *     tenant; an ADMIN/FLEET_MANAGER verifies documents and moves the driver
 *     to a real fleet (activation). Until then scoped reads stay fail-closed.
 */
// ---- validation schemas -------------------------------------------------------
const PhoneSchema = z.object({
    // Ethiopian mobile numbers, normalized to +2519XXXXXXXX / +2517XXXXXXXX.
    phone: z.string().regex(/^\+?251?9\d{8}$/).or(z.string().regex(/^\+?251?7\d{8}$/)),
});
const OtpVerifySchema = z.object({
    phone: PhoneSchema.shape.phone,
    code: z.string().regex(/^\d{6}$/),
    device_id: z.string().min(8).max(128), // stable per-install UUID from the app
});
/** Ticket re-check schema (POST /auth/register may also carry otp_code directly). */
const TicketCheckSchema = z.object({
    registration_ticket: z.string().min(16),
    phone: PhoneSchema.shape.phone,
    device_id: z.string().min(8).max(128),
});
const VehicleInput = z.object({
    plate_number: z.string().min(3).max(32),
    truck_type: z.enum(['TRUCK', 'TRAILER_HEAD', 'VAN', 'OTHER']).default('TRUCK'),
    make_model: z.string().max(120).optional(),
    capacity_tons: z.coerce.number().positive().max(200).optional(),
    body_type: z.enum(['HIGH_BED', 'LOW_BED', 'BOX', 'TANKER', 'FLATBED', 'CONTAINER', 'REFRIGERATED', 'OTHER']).optional(),
    ownership_status: z.enum(['OWNER', 'EMPLOYEE_DRIVER', 'LEASED', 'ASSOCIATION', 'OTHER']).optional(),
});
const TrailerInput = z.object({
    plate_number: z.string().min(3).max(32),
    trailer_type: z.string().max(60).optional(), // low bed, high bed, container…
    capacity_tons: z.coerce.number().positive().max(200).optional(),
    equipment_details: z.string().max(500).optional(),
});
const RegisterSchema = z.object({
    phone: PhoneSchema.shape.phone,
    otp_code: z.string().regex(/^\d{6}$/).optional(),
    registration_ticket: z.string().min(16).optional(),
    device_id: z.string().min(8).max(128),
    full_name: z.string().min(2).max(200),
    license_number: z.string().min(3).max(64),
    license_class: z.string().max(32).optional(),
    license_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    association_name: z.string().max(200).optional(), // optional Ethiopian truck association
    home_base: z.string().max(120).optional(),
    locale: z.enum(['en', 'am']).default('am'),
    app_version: z.string().max(40).optional(),
    platform: z.string().max(40).optional(),
    vehicle: VehicleInput.optional(), // self-declared truck (assignment pending admin confirmation)
    trailers: z.array(TrailerInput).max(10).optional(), // multiple trailers allowed
}).refine((d) => !!d.vehicle || d.trailers?.length === undefined || true, { message: 'ok' });
const UpdateProfileSchema = z.object({
    full_name: z.string().min(2).max(200).optional(),
    license_number: z.string().min(3).max(64).optional(),
    license_class: z.string().max(32).optional(),
    license_expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    association_name: z.string().max(200).nullable().optional(),
    ownership_status: z.enum(['OWNER', 'EMPLOYEE_DRIVER', 'LEASED', 'ASSOCIATION', 'OTHER']).nullable().optional(),
    home_base: z.string().max(120).nullable().optional(),
    locale: z.enum(['en', 'am']).optional(),
});
const AddVehicleSchema = VehicleInput.extend({ set_active: z.boolean().default(true) });
const AddTrailerSchema = TrailerInput.extend({ set_active: z.boolean().default(true) });
const DocumentType = z.enum(['DRIVING_LICENSE', 'NATIONAL_ID', 'INSURANCE', 'OWNERSHIP', 'ASSOCIATION_CARD', 'OTHER']);
const ReviewDocSchema = z.object({
    status: z.enum(['VERIFIED', 'REJECTED']),
    review_note: z.string().max(500).optional(),
});
const MoveDriverSchema = z.object({ fleet_id: z.string().uuid() });
const AssignVehicleSchema = z.object({ vehicle_id: z.string().uuid() });
const AssignTrailerSchema = z.object({ trailer_id: z.string().uuid() });
const PairDeviceSchema = z.object({
    phone: PhoneSchema.shape.phone,
    otp_code: z.string().regex(/^\d{6}$/),
    device_id: z.string().min(8).max(128),
    platform: z.string().max(40).optional(),
    app_version: z.string().max(40).optional(),
});
const RefreshSchema = z.object({ device_id: z.string().min(8).max(128) });
// ---- helpers ------------------------------------------------------------------
function normalizePhone(raw) {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits.startsWith('251'))
        return `+${digits}`;
    if (digits.length === 9 && (digits.startsWith('9') || digits.startsWith('7')))
        return `+251${digits}`;
    throw Object.assign(new Error('invalid_phone_format'), { statusCode: 400 });
}
function hashOtp(code, phone) {
    return crypto.createHash('sha256').update(`${phone}.${code}.yet-otp-v1`).digest('hex');
}
function opaqueToken() {
    return crypto.randomBytes(32).toString('base64url');
}
async function fleetStatus(fleetId) {
    if (!fleetId)
        return null;
    const { rows } = await pool.query(`SELECT status FROM fleets WHERE id = $1`, [fleetId]);
    return rows[0]?.status ?? null;
}
/** Machine-readable denial codes thrown as Errors (authGuard etc.) must keep
 *  their message in the response `error` field — Fastify's default error
 *  serializer would otherwise render `{statusCode:403}` + `{error:'Forbidden'}`,
 *  and the driver app branches on `account_inactive`. Applied per-route via
 *  onRequest so it cannot clash with setErrorHandler ordering. */
const KNOWN_DENIALS = new Set(['consent_required', 'fleet_suspended', 'cross_fleet_denied',
    'forbidden_role', 'target_not_found',
    'account_inactive', 'account_suspended', 'device_not_paired',
    'unauthorized']);
/** Shared guard: Bearer token → live principal. Re-validates the DB state on
 *  every call so revocation/suspension takes effect immediately regardless of
 *  the JWT's remaining TTL (fail-closed, PDPP §1.7). Denials are written
 *  DIRECTLY to the reply ({error:<code>}) instead of being thrown — a thrown
 *  error's serialization depends on plugin-scoped setErrorHandler precedence,
 *  which @fastify/sensible hijacks into {error:'Forbidden'} (observed in gates). */
async function authGuard(req, reply) {
    const deny = (code, status) => {
        void reply.code(status).send({ error: code }); // deterministic shape, order-proof
        return null;
    };
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer '))
        return deny('unauthorized', 401);
    let claims;
    try {
        const { verifyAccessToken } = await import('../../lib/jwt.js');
        claims = verifyAccessToken(header.slice(7));
    }
    catch {
        return deny('unauthorized', 401);
    }
    const { rows } = await pool.query(`SELECT id, role, fleet_id, is_active FROM users WHERE id = $1 LIMIT 1`, [claims.sub]);
    const user = rows[0];
    if (!user || !user.is_active)
        return deny('account_inactive', 403);
    if (user.fleet_id) {
        const st = await fleetStatus(user.fleet_id);
        if (st !== 'ACTIVE')
            return deny('fleet_suspended', 403);
    }
    return { id: user.id, role: user.role, fleetId: user.fleet_id ?? null };
}
const DOC_EXTENSIONS = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf',
};
/* ---------------------------------------------------------------------------
 * SMS delivery for OTP codes. Reuses the SAME local Ethiopian gateway knob as
 * the Phase 5 notification dispatcher (env.SMS_GATEWAY_URL / SMS_GATEWAY_SENDER).
 * No-op-safe: without a gateway (dev/test) the flow still works via the hashed
 * code cached in Redis; production boots must configure the gateway.
 * ------------------------------------------------------------------------- */
async function sendOtpSms(phone, code) {
    if (!env.SMS_GATEWAY_URL)
        return false;
    try {
        const res = await fetch(env.SMS_GATEWAY_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                to: phone, from: env.SMS_GATEWAY_SENDER,
                message: `YET verification code: ${code}. Valid for ${Math.round(env.OTP_TTL_S / 60)} minutes. Do not share this code.`,
            }),
        });
        return res.ok;
    }
    catch {
        return false;
    }
}
export default async function onboardingRoutes(app) {
    // Multipart is only consumed by the document-upload route; registering it here
    // (rather than globally) keeps the big-body parser off every other endpoint.
    await app.register(multipart, {
        limits: { fileSize: env.DOC_MAX_SIZE_BYTES, files: 1 },
    });
    /** POST /auth/register/otp/request — start registration (or re-pairing).
     *  Rate-limited hard: OTP abuse against a real SMS gateway is a cost + spam
     *  vector; the ceiling ALSO counts requests within the window at the HTTP
     *  layer, mirroring OTP_MAX_PER_PHONE_15MIN. */
    app.post('/auth/register/otp/request', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (req, reply) => {
        const parsed = PhoneSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const phone = normalizePhone(parsed.data.phone);
        // Abuse ceiling from the DB audit trail (otp_requests), independent of Redis.
        const { rows: recent } = await pool.query(`SELECT COUNT(*)::int AS n FROM otp_requests
        WHERE phone_e164 = $1 AND requested_at > now() - interval '15 minutes'`, [phone]);
        if (recent[0].n >= env.OTP_MAX_PER_PHONE_15MIN) {
            await audit({ action: 'otp_rate_limited', ip: req.ip, detail: { phone } });
            return reply.code(429).send({ error: 'otp_limit_exceeded', retry_after_s: 900 });
        }
        const code = String(crypto.randomInt(100000, 1000000));
        // Codes live ONLY in Redis, hashed at rest, short TTL (never persisted).
        await cacheSetJson(`otp:${phone}`, hashOtp(code, phone), env.OTP_TTL_S);
        await pool.query(`INSERT INTO otp_requests (phone_e164, purpose, ip) VALUES ($1, 'REGISTER', $2)`, [phone, /\d/.test(req.ip ?? '') ? req.ip : null]);
        const sent = await sendOtpSms(phone, code);
        await audit({ action: 'otp_requested', ip: req.ip, detail: { phone, delivered: sent } });
        const body = { sent, ttl_s: env.OTP_TTL_S };
        // Dev/test convenience only; validateComplianceBoot forbids it in prod.
        if (!isProd && env.OTP_DEV_ECHO && !sent)
            body.dev_code = code;
        return reply.code(200).send(body);
    });
    /** POST /auth/register/otp/verify — prove possession of the phone EARLY so the
     *  driver can fill the long form without the code expiring mid-way. Grants a
     *  single-use 15-minute registration ticket bound to (phone, device). */
    app.post('/auth/register/otp/verify', async (req, reply) => {
        const parsed = OtpVerifySchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const phone = normalizePhone(parsed.data.phone);
        const key = `otp:${phone}`;
        const expected = await cacheGetJson(key);
        if (!expected || !timingSafeEq(expected, hashOtp(parsed.data.code, phone))) {
            return reply.code(400).send({ error: 'otp_expired_or_invalid' });
        }
        await cacheDel(key); // one-shot: a verified code cannot be replayed
        const ticket = opaqueToken();
        await cacheSetJson(`otp_ticket:${ticket}`, { phone, device_id: parsed.data.device_id }, 900);
        await audit({ action: 'otp_verified', ip: req.ip, detail: { phone } });
        return { registration_ticket: ticket, expires_in_s: 900 };
    });
    /** GET/POST /auth/register/ticket/check — the driver app probes a stored
     *  ticket before rendering the form (valid ⇒ skip straight to the form;
     *  invalid ⇒ show the OTP step again). Non-consuming: only checks existence. */
    const checkTicket = async (req, reply) => {
        const src = req.method === 'GET' ? req.query : req.body;
        const parsed = TicketCheckSchema.safeParse(src);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const tVal = await cacheGetJson(`otp_ticket:${parsed.data.registration_ticket}`);
        const ok = !!tVal && tVal.phone === normalizePhone(parsed.data.phone) && tVal.device_id === parsed.data.device_id;
        return { valid: ok };
    };
    app.get('/auth/register/ticket/check', checkTicket);
    app.post('/auth/register/ticket/check', checkTicket);
    /** POST /auth/register — the ONE-TIME form. Requires a valid OTP ticket (from
     *  /otp/verify or carried by otp_code re-check). Creates: driver user (no
     *  password — DB trigger enforces), driver_profile, self-declared vehicle +
     *  trailers as ASSET rows, PENDING assignments (admin confirms the fleet),
     *  pairs the device and returns the first token. From here on the driver
     *  never logs in again. */
    app.post('/auth/register', {
        config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    }, async (req, reply) => {
        const parsed = RegisterSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const b = parsed.data;
        const phone = normalizePhone(b.phone);
        // --- OTP gate: a pre-verified registration ticket (from /otp/verify) OR a
        //     direct code re-check. Both are one-shot.
        if (b.registration_ticket) {
            const tKey = `otp_ticket:${b.registration_ticket}`;
            const tVal = await cacheGetJson(tKey);
            if (!tVal || tVal.phone !== phone || tVal.device_id !== b.device_id) {
                return reply.code(400).send({ error: 'registration_ticket_invalid' });
            }
            await cacheDel(tKey);
        }
        else if (b.otp_code) {
            const key = `otp:${phone}`;
            const expected = await cacheGetJson(key);
            if (!expected || !timingSafeEq(expected, hashOtp(b.otp_code, phone))) {
                return reply.code(400).send({ error: 'otp_expired_or_invalid' });
            }
            await cacheDel(key);
        }
        else {
            return reply.code(400).send({ error: 'otp_required', hint: 'POST /auth/register/otp/verify first' });
        }
        // --- Idempotent re-registration: same phone = same PERSON. Never create a
        //     second account; re-pair the device and top up profile/assets instead.
        const { rows: existingRows } = await pool.query(`SELECT id, role, fleet_id, is_active FROM users WHERE phone_e164 = $1`, [phone]);
        let driverId;
        let reRegistered = false;
        const client = await pool.connect();
        try {
            if (existingRows[0]) {
                const u = existingRows[0];
                if (u.role !== 'DRIVER')
                    return reply.code(409).send({ error: 'phone_belongs_to_staff_account' });
                if (!u.is_active)
                    return reply.code(403).send({ error: 'account_suspended' });
                driverId = u.id;
                reRegistered = true;
                await client.query('BEGIN');
                await client.query(`INSERT INTO driver_profiles (driver_id, license_number, license_class, license_expiry, association_name, home_base)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (driver_id) DO UPDATE SET
             license_number = EXCLUDED.license_number,
             license_class  = COALESCE(EXCLUDED.license_class, driver_profiles.license_class),
             license_expiry = COALESCE(EXCLUDED.license_expiry, driver_profiles.license_expiry),
             association_name = COALESCE(EXCLUDED.association_name, driver_profiles.association_name),
             home_base = COALESCE(EXCLUDED.home_base, driver_profiles.home_base),
             updated_at = now()`, [driverId, b.license_number, b.license_class ?? null, b.license_expiry ?? null,
                    b.association_name ?? null, b.home_base ?? null]);
                await client.query(`UPDATE users SET full_name = $2, locale = $3 WHERE id = $1`, [driverId, b.full_name, b.locale]);
                await client.query('COMMIT');
            }
            else {
                await client.query('BEGIN');
                const { rows: fr } = await client.query(`SELECT id FROM fleets WHERE name = 'Unassigned Fleet'`);
                if (fr.length === 0)
                    throw new Error('unassigned_fleet_missing');
                const { rows: ur } = await client.query(`INSERT INTO users (role, full_name, phone_e164, locale, fleet_id, is_active)
           VALUES ('DRIVER', $1, $2, $3, $4, true) RETURNING id`, [b.full_name, phone, b.locale, fr[0].id]);
                driverId = ur[0].id;
                await client.query(`INSERT INTO driver_profiles (driver_id, license_number, license_class, license_expiry, association_name, ownership_status, home_base)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [driverId, b.license_number, b.license_class ?? null, b.license_expiry ?? null,
                    b.association_name ?? null, b.vehicle?.ownership_status ?? null, b.home_base ?? null]);
                await client.query('COMMIT');
            }
            // --- Assets: truck(s) & trailers declared by the driver. Plate numbers are
            //     asset identity, NOT account identity. Existing plate ⇒ reuse row
            //     (and move it into Unassigned Fleet only if it is orphaned there).
            if (b.vehicle) {
                const v = b.vehicle;
                const { rows: vr } = await client.query(`INSERT INTO vehicles (plate_number, fleet_id, vehicle_type, fleet_name, make_model, capacity_tons, body_type, ownership_status, created_by_driver_id)
           VALUES ($1, (SELECT id FROM fleets WHERE name = 'Unassigned Fleet'), $2, NULL, $3, $4, $5, $6, $7)
           ON CONFLICT (plate_number) DO UPDATE
             SET make_model = COALESCE(EXCLUDED.make_model, vehicles.make_model),
                 capacity_tons = COALESCE(EXCLUDED.capacity_tons, vehicles.capacity_tons),
                 body_type = COALESCE(EXCLUDED.body_type, vehicles.body_type),
                 ownership_status = COALESCE(EXCLUDED.ownership_status, vehicles.ownership_status)
           RETURNING id, fleet_id`, [v.plate_number.toUpperCase(), v.truck_type, v.make_model ?? null, v.capacity_tons ?? null,
                    v.body_type ?? null, v.ownership_status ?? null, driverId]);
                // Time-bound assignment: close any current one, open the new (the
                // dva_no_overlap exclusion guarantees a single active vehicle).
                await client.query(`UPDATE driver_vehicle_assignments SET unassigned_at = now()
                             WHERE driver_id = $1 AND unassigned_at IS NULL`, [driverId]);
                await client.query(`INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id, created_by_admin)
           VALUES ($1, $2, false)`, [driverId, vr[0].id]);
            }
            for (const t of b.trailers ?? []) {
                const { rows: tr } = await client.query(`INSERT INTO trailers (plate_number, trailer_type, capacity_tons, equipment_details, fleet_id, created_by_driver_id)
           VALUES ($1,$2,$3,$4, (SELECT id FROM fleets WHERE name = 'Unassigned Fleet'), $5)
           ON CONFLICT (plate_number) DO UPDATE SET
             trailer_type = COALESCE(EXCLUDED.trailer_type, trailers.trailer_type),
             capacity_tons = COALESCE(EXCLUDED.capacity_tons, trailers.capacity_tons),
             equipment_details = COALESCE(EXCLUDED.equipment_details, trailers.equipment_details)
           RETURNING id`, [t.plate_number.toUpperCase(), t.trailer_type ?? null, t.capacity_tons ?? null,
                    t.equipment_details ?? null, driverId]);
                await client.query(`UPDATE driver_trailer_assignments SET unassigned_at = now()
                             WHERE driver_id = $1 AND unassigned_at IS NULL`, [driverId]);
                await client.query(`INSERT INTO driver_trailer_assignments (driver_id, trailer_id, created_by_admin)
           VALUES ($1, $2, false)`, [driverId, tr[0].id]);
            }
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        }
        finally {
            client.release();
        }
        // --- Device pairing: this install becomes the driver's session credential.
        const token = await pairDevice(driverId, b.device_id, b.platform, b.app_version, req.ip, 'register');
        await audit({ actorId: driverId, action: reRegistered ? 'reregistration_repairs' : 'driver_registered',
            targetUser: driverId, ip: req.ip,
            detail: { phone, vehicle_declared: !!b.vehicle, trailers: b.trailers?.length ?? 0 } });
        const { rows: me } = await pool.query(`SELECT u.id, u.role, u.full_name, u.locale, u.fleet_id, f.name AS fleet_name,
              (EXISTS (SELECT 1 FROM driver_documents d WHERE d.driver_id = u.id AND d.doc_type = 'DRIVING_LICENSE'
                                   AND d.status IN ('PENDING_REVIEW','VERIFIED'))) AS license_uploaded
         FROM users u JOIN fleets f ON f.id = u.fleet_id WHERE u.id = $1`, [driverId]);
        return reply.code(reRegistered ? 200 : 201).send({
            access_token: token,
            driver: me[0],
            status: 'PENDING_REVIEW',
            next_steps: me[0].license_uploaded
                ? ['Wait for admin verification of your documents.']
                : ['Upload your driving license (required): POST /me/documents (doc_type=DRIVING_LICENSE).'],
        });
    });
    /** POST /auth/session/refresh — THE LOGIN REPLACEMENT. Called on every app
     *  launch when the stored JWT is expired/absent. Presented with the paired
     *  device_id + a still-valid bearer (or during grace), the backend re-checks
     *  the pairing registry and account state and mints a fresh token. If the
     *  driver has no usable token yet (expired long ago), the same endpoint works
     *  with phone + OTP instead: see /auth/pair-device. The driver NEVER types a
     *  password. */
    app.post('/auth/session/refresh', async (req, reply) => {
        const parsed = RefreshSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        let claims;
        try {
            const { verifyAccessToken } = await import('../../lib/jwt.js');
            claims = verifyAccessToken((req.headers.authorization ?? '').replace(/^Bearer /, ''));
        }
        catch {
            return reply.code(401).send({ error: 'unauthorized', hint: 'pair device via POST /auth/pair-device' });
        }
        const { rows } = await pool.query(`SELECT u.id, u.role, u.locale, u.fleet_id, u.is_active, f.status AS fleet_status
         FROM users u LEFT JOIN fleets f ON f.id = u.fleet_id WHERE u.id = $1`, [claims.sub]);
        const u = rows[0];
        if (!u || !u.is_active)
            return reply.code(403).send({ error: 'account_inactive' });
        if (u.fleet_status && u.fleet_status !== 'ACTIVE')
            return reply.code(403).send({ error: 'fleet_suspended' });
        const { rows: paired } = await pool.query(`SELECT 1 FROM device_identities
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [u.id, parsed.data.device_id]);
        if (paired.length === 0)
            return reply.code(403).send({ error: 'device_not_paired', hint: 're-pair via POST /auth/pair-device (OTP)' });
        await pool.query(`UPDATE device_identities SET last_seen_at = now() WHERE user_id = $1 AND device_id = $2`, [u.id, parsed.data.device_id]);
        const token = signAccessToken({ sub: u.id, role: u.role, locale: u.locale, fleetId: u.fleet_id ?? undefined });
        return { access_token: token };
    });
    /** POST /auth/pair-device — lost/expired session recovery WITHOUT a password:
     *  prove the phone via OTP, pair this install, get a token. Also used when an
     *  admin revokes a device and the driver gets a new phone. */
    app.post('/auth/pair-device', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    }, async (req, reply) => {
        const parsed = PairDeviceSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const b = parsed.data;
        const phone = normalizePhone(b.phone);
        const key = `otp:${phone}`;
        const expected = await cacheGetJson(key);
        if (!expected || !timingSafeEq(expected, hashOtp(b.otp_code, phone))) {
            return reply.code(400).send({ error: 'otp_expired_or_invalid' });
        }
        await cacheDel(key);
        const { rows } = await pool.query(`SELECT id, role, is_active, fleet_id FROM users WHERE phone_e164 = $1`, [phone]);
        const u = rows[0];
        if (!u)
            return reply.code(404).send({ error: 'driver_not_registered', hint: 'complete registration first' });
        if (u.role !== 'DRIVER')
            return reply.code(403).send({ error: 'staff_use_password_login' });
        if (!u.is_active)
            return reply.code(403).send({ error: 'account_suspended' });
        if (u.fleet_id) {
            const st = await fleetStatus(u.fleet_id);
            if (st !== 'ACTIVE')
                return reply.code(403).send({ error: 'fleet_suspended' });
        }
        const token = await pairDevice(u.id, b.device_id, b.platform, b.app_version, req.ip, 'pair');
        await audit({ actorId: u.id, action: 'device_paired', targetUser: u.id, ip: req.ip });
        return { access_token: token, role: u.role, user_id: u.id, fleet_id: u.fleet_id ?? null };
    });
    /* ------------------------- Driver self-service (/me) ------------------------ */
    /** GET /me/profile — everything the profile screen shows: person, license,
     *  association, current equipment (time-bound), documents w/ status + expiry. */
    app.get('/me/profile', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const { rows } = await pool.query(`SELECT u.id, u.full_name, u.phone_e164, u.locale, u.created_at, u.fleet_id, f.name AS fleet_name,
              p.license_number, p.license_class, p.license_expiry, p.association_name,
              p.ownership_status, p.home_base, p.updated_at AS profile_updated_at
         FROM users u
         JOIN fleets f ON f.id = u.fleet_id
         LEFT JOIN driver_profiles p ON p.driver_id = u.id
        WHERE u.id = $1`, [auth.id]);
        if (rows.length === 0)
            return reply.code(404).send({ error: 'not_found' });
        const { rows: vehicles } = await pool.query(`SELECT va.vehicle_id, v.plate_number, v.vehicle_type::text AS truck_type, v.make_model,
              v.capacity_tons, v.body_type, v.ownership_status::text AS ownership_status,
              va.assigned_at, va.unassigned_at, va.created_by_admin
         FROM driver_vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id
        WHERE va.driver_id = $1 ORDER BY va.assigned_at DESC LIMIT 10`, [auth.id]);
        const { rows: trailers } = await pool.query(`SELECT ta.trailer_id, t.plate_number, t.trailer_type, t.capacity_tons, t.equipment_details,
              ta.assigned_at, ta.unassigned_at, ta.created_by_admin
         FROM driver_trailer_assignments ta JOIN trailers t ON t.id = ta.trailer_id
        WHERE ta.driver_id = $1 ORDER BY ta.assigned_at DESC LIMIT 20`, [auth.id]);
        const { rows: docs } = await pool.query(`SELECT id, doc_type::text AS doc_type, mime_type, size_bytes, expires_on, status::text AS status,
              review_note, uploaded_at
         FROM driver_documents WHERE driver_id = $1 ORDER BY uploaded_at DESC`, [auth.id]);
        const activeVehicle = vehicles.find((v) => !v.unassigned_at) ?? null;
        return {
            ...rows[0],
            registration_status: docs.some((d) => d.status === 'PENDING_REVIEW') ? 'PENDING_REVIEW'
                : docs.some((d) => d.status === 'VERIFIED') ? 'ACTIVE' : 'INCOMPLETE',
            vehicle: activeVehicle,
            vehicles,
            trailers,
            documents: docs,
        };
    });
    /** PATCH /me/profile — update personal + license details (drivers change
     *  trucks/companies, never accounts). Does NOT touch equipment: use the
     *  vehicle/trailer endpoints below for that. */
    app.patch('/me/profile', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const parsed = UpdateProfileSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const b = parsed.data;
        const { rows } = await pool.query(`INSERT INTO driver_profiles (driver_id, license_number, license_class, license_expiry, association_name, ownership_status, home_base)
       VALUES ($1, COALESCE($2,''), $3, $4, $5, $6, $7)
       ON CONFLICT (driver_id) DO UPDATE SET
         license_number = COALESCE(NULLIF(EXCLUDED.license_number,''), driver_profiles.license_number),
         license_class  = COALESCE(EXCLUDED.license_class, driver_profiles.license_class),
         license_expiry = CASE WHEN $4::text IS NULL THEN driver_profiles.license_expiry ELSE EXCLUDED.license_expiry END,
         association_name = CASE WHEN $5::text IS NULL THEN driver_profiles.association_name ELSE EXCLUDED.association_name END,
         ownership_status = CASE WHEN $6::text IS NULL THEN driver_profiles.ownership_status ELSE EXCLUDED.ownership_status::ownership_status END,
         home_base = CASE WHEN $7::text IS NULL THEN driver_profiles.home_base ELSE EXCLUDED.home_base END,
         updated_at = now()
       RETURNING license_number, license_class, license_expiry, association_name, ownership_status, home_base, updated_at`, [auth.id, b.license_number, b.license_class ?? null, b.license_expiry ?? null,
            b.association_name ?? null, b.ownership_status ?? null, b.home_base ?? null]);
        if (b.full_name || b.locale) {
            await pool.query(`UPDATE users SET full_name = COALESCE($2, full_name), locale = COALESCE($3, locale) WHERE id = $1`, [auth.id, b.full_name ?? null, b.locale ?? null]);
        }
        await audit({ actorId: auth.id, action: 'profile_updated', targetUser: auth.id, ip: req.ip });
        return { updated: true, profile: rows[0] };
    });
    /** POST /me/vehicles — "I changed truck": declare a new vehicle; closes the old
     *  assignment (time-bound history preserved) and opens the new one. Stays
     *  provisional (created_by_admin=false) until an admin confirms. */
    app.post('/me/vehicles', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const parsed = AddVehicleSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const v = parsed.data;
        const { rows } = await pool.query(`INSERT INTO vehicles (plate_number, fleet_id, vehicle_type, make_model, capacity_tons, body_type, ownership_status, created_by_driver_id)
       VALUES ($1, (SELECT id FROM fleets WHERE name = 'Unassigned Fleet'), $2, $3, $4, $5, $6, $7)
       ON CONFLICT (plate_number) DO UPDATE SET
         make_model = COALESCE(EXCLUDED.make_model, vehicles.make_model),
         capacity_tons = COALESCE(EXCLUDED.capacity_tons, vehicles.capacity_tons),
         body_type = COALESCE(EXCLUDED.body_type, vehicles.body_type),
         ownership_status = COALESCE(EXCLUDED.ownership_status, vehicles.ownership_status)
       RETURNING id, plate_number, fleet_id`, [v.plate_number.toUpperCase(), v.truck_type, v.make_model ?? null, v.capacity_tons ?? null,
            v.body_type ?? null, v.ownership_status ?? null, auth.id]);
        const vehicleId = rows[0].id;
        if (v.set_active) {
            await pool.query(`UPDATE driver_vehicle_assignments SET unassigned_at = now()
                         WHERE driver_id = $1 AND unassigned_at IS NULL`, [auth.id]);
            await pool.query(`INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id, created_by_admin)
                        VALUES ($1, $2, false)`, [auth.id, vehicleId]);
        }
        await audit({ actorId: auth.id, action: 'vehicle_declared', targetUser: auth.id, ip: req.ip,
            detail: { vehicle_id: vehicleId, plate: rows[0].plate_number } });
        return reply.code(201).send({ vehicle_id: vehicleId, plate_number: rows[0].plate_number,
            active: v.set_active, pending_admin_confirmation: true });
    });
    /** POST /me/trailers — same pattern for trailers (multiple allowed). */
    app.post('/me/trailers', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const parsed = AddTrailerSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed', detail: parsed.error.flatten() });
        const t = parsed.data;
        const { rows } = await pool.query(`INSERT INTO trailers (plate_number, trailer_type, capacity_tons, equipment_details, created_by_driver_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (plate_number) DO UPDATE SET
         trailer_type = COALESCE(EXCLUDED.trailer_type, trailers.trailer_type),
         capacity_tons = COALESCE(EXCLUDED.capacity_tons, trailers.capacity_tons),
         equipment_details = COALESCE(EXCLUDED.equipment_details, trailers.equipment_details)
       RETURNING id, plate_number`, [t.plate_number.toUpperCase(), t.trailer_type ?? null, t.capacity_tons ?? null,
            t.equipment_details ?? null, auth.id]);
        const trailerId = rows[0].id;
        if (t.set_active) {
            await pool.query(`UPDATE driver_trailer_assignments SET unassigned_at = now()
                         WHERE driver_id = $1 AND unassigned_at IS NULL`, [auth.id]);
            await pool.query(`INSERT INTO driver_trailer_assignments (driver_id, trailer_id, created_by_admin)
                        VALUES ($1, $2, false)`, [auth.id, trailerId]);
        }
        await audit({ actorId: auth.id, action: 'trailer_declared', targetUser: auth.id, ip: req.ip,
            detail: { trailer_id: trailerId, plate: rows[0].plate_number } });
        return reply.code(201).send({ trailer_id: trailerId, plate_number: rows[0].plate_number,
            active: t.set_active, pending_admin_confirmation: true });
    });
    /** POST /me/documents — multipart upload. Driving license is MANDATORY for
     *  activation; national ID / insurance / ownership are conditional (role and
     *  ownership status decide what an admin asks for during review). Re-upload
     *  replaces the previous active row (partial unique index). Files land on the
     *  Ethiopian-resident volume; Postgres stores only the reference (§1.7). */
    app.post('/me/documents', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (!req.isMultipart?.()) {
            return reply.code(400).send({ error: 'multipart_required', hint: 'form-data: file + doc_type (+ expires_on)' });
        }
        const data = await req.file();
        if (!data)
            return reply.code(400).send({ error: 'file_missing' });
        const fields = data.fields ?? {};
        const docTypeRaw = typeof fields.doc_type?.value === 'string' ? fields.doc_type.value : undefined;
        const parsedType = DocumentType.safeParse(docTypeRaw);
        if (!parsedType.success) {
            await data.toBuffer().catch(() => { });
            return reply.code(400).send({ error: 'invalid_doc_type', allowed: DocumentType.options });
        }
        const mimetype = data.mimetype ?? '';
        if (!(mimetype in DOC_EXTENSIONS)) {
            await data.toBuffer().catch(() => { });
            return reply.code(415).send({ error: 'unsupported_media_type', allowed: Object.keys(DOC_EXTENSIONS) });
        }
        const buf = await data.toBuffer(); // size capped by @fastify/multipart limits
        const dir = path.resolve(env.DOC_UPLOAD_DIR);
        await fs.mkdir(dir, { recursive: true });
        const fileId = crypto.randomUUID();
        const filePath = path.join(dir, `${auth.id}.${parsedType.data.toLowerCase()}${DOC_EXTENSIONS[mimetype]}`);
        // Atomic replace: write temp then rename over the previous active document.
        const tmp = `${filePath}.${fileId}.tmp`;
        await fs.writeFile(tmp, buf);
        await fs.rename(tmp, filePath);
        const expiresOn = typeof fields.expires_on?.value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fields.expires_on.value)
            ? fields.expires_on.value : null;
        const { rows } = await pool.query(`WITH retire AS (
         UPDATE driver_documents SET status = 'REJECTED', review_note = 'Superseded by re-upload'
          WHERE driver_id = $1 AND doc_type = $2::document_type
            AND status IN ('PENDING_REVIEW','VERIFIED')
       )
       INSERT INTO driver_documents (driver_id, doc_type, file_path, mime_type, size_bytes, expires_on)
       VALUES ($1, $2::document_type, $3, $4, $5, $6)
       RETURNING id, doc_type::text AS doc_type, status::text AS status, expires_on, uploaded_at`, [auth.id, parsedType.data, filePath.replace(/\\/g, '/'), mimetype, buf.length, expiresOn]);
        // License expiry mirrored onto the profile keeps tracking consistent.
        if (parsedType.data === 'DRIVING_LICENSE' && expiresOn) {
            await pool.query(`UPDATE driver_profiles SET license_expiry = $2, updated_at = now() WHERE driver_id = $1`, [auth.id, expiresOn]);
        }
        await audit({ actorId: auth.id, action: 'document_uploaded', targetUser: auth.id, ip: req.ip,
            detail: { doc_type: parsedType.data, size_bytes: buf.length } });
        return reply.code(201).send({ ...rows[0], mandatory: parsedType.data === 'DRIVING_LICENSE' });
    });
    /** GET /me/devices — the driver sees which installs are paired (transparency). */
    app.get('/me/devices', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const { rows } = await pool.query(`SELECT id, device_id, platform, app_version, paired_at, last_seen_at, revoked_at
         FROM device_identities WHERE user_id = $1 ORDER BY paired_at DESC`, [auth.id]);
        return { devices: rows };
    });
    /** POST /me/devices/revoke — sign out THIS device (lost phone / sold phone).
     *  After revocation, refresh fails and re-pairing needs a fresh OTP. */
    app.post('/me/devices/revoke', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        const parsed = RefreshSchema.safeParse(req.body);
        if (!parsed.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rowCount } = await pool.query(`UPDATE device_identities SET revoked_at = now(), revoke_reason = 'driver_request'
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [auth.id, parsed.data.device_id]);
        if (rowCount === 0)
            return reply.code(404).send({ error: 'pairing_not_found' });
        await pool.query(`UPDATE users SET device_id = NULL WHERE id = $1 AND device_id = $2`, [auth.id, parsed.data.device_id]);
        await audit({ actorId: auth.id, action: 'device_revoked_self', targetUser: auth.id, ip: req.ip });
        return { revoked: true };
    });
    /* ---------------- Admin side: review queue + ASSIGNMENT (B2B) ---------------- */
    /** GET /admin/drivers — registration/review queue. ADMIN or FLEET_MANAGER
     *  (own fleet only). Filters: status=PENDING|ACTIVE|SUSPENDED|ALL, q search. */
    app.get('/admin/drivers', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const q = z.object({ status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED', 'ALL']).default('ALL'),
            q: z.string().max(100).optional() }).safeParse(req.query);
        if (!q.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const fleetFilter = auth.role === 'FLEET_MANAGER' ? 'AND u.fleet_id = $3' : '';
        const like = `%${q.data.q ?? ''}%`;
        const params = [q.data.status, like];
        if (fleetFilter)
            params.push(auth.fleetId);
        const { rows } = await pool.query(`SELECT u.id, u.full_name, u.phone_e164, u.is_active, u.created_at,
              u.fleet_id, f.name AS fleet_name,
              p.license_number, p.license_class, p.license_expiry, p.association_name, p.home_base,
              COALESCE((SELECT json_agg(json_build_object('doc_type', d.doc_type::text, 'status', d.status::text, 'expires_on', d.expires_on, 'uploaded_at', d.uploaded_at))
                 FROM driver_documents d WHERE d.driver_id = u.id), '[]') AS documents,
              (SELECT json_build_object('vehicle_id', v.id, 'plate_number', v.plate_number, 'body_type', v.body_type,
                                        'made_by_admin', va.created_by_admin)
                 FROM driver_vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id
                WHERE va.driver_id = u.id AND va.unassigned_at IS NULL LIMIT 1) AS active_vehicle,
              (SELECT COUNT(*)::int FROM driver_trailer_assignments ta
                WHERE ta.driver_id = u.id AND ta.unassigned_at IS NULL) AS active_trailers
         FROM users u
         JOIN fleets f ON f.id = u.fleet_id
         LEFT JOIN driver_profiles p ON p.driver_id = u.id
        WHERE u.role = 'DRIVER'
          AND ($1 = 'ALL'
               OR ($1 = 'PENDING' AND EXISTS (SELECT 1 FROM driver_documents d
                       WHERE d.driver_id = u.id AND d.status = 'PENDING_REVIEW'))
               OR ($1 = 'ACTIVE' AND u.is_active AND EXISTS (SELECT 1 FROM driver_documents d
                       WHERE d.driver_id = u.id AND d.status = 'VERIFIED'))
               OR ($1 = 'SUSPENDED' AND NOT u.is_active))
          AND (u.full_name ILIKE $2 OR u.phone_e164 LIKE $2 OR p.license_number ILIKE $2
               OR EXISTS (SELECT 1 FROM driver_vehicle_assignments av
                            JOIN vehicles av_v ON av_v.id = av.vehicle_id
                          WHERE av.driver_id = u.id AND av.unassigned_at IS NULL AND av_v.plate_number ILIKE $2))
          ${fleetFilter}
        ORDER BY u.created_at DESC LIMIT 200`, params);
        return { count: rows.length, drivers: rows };
    });
    /** GET /admin/drivers/:driver_id — full dossier incl. assignment history. */
    app.get('/admin/drivers/:driver_id', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid() }).safeParse(req.params);
        if (!params.success)
            return reply.code(400).send({ error: 'invalid_id' });
        const { rows } = await pool.query(`SELECT u.id, u.full_name, u.phone_e164, u.locale, u.is_active, u.created_at, u.fleet_id, f.name AS fleet_name,
              p.license_number, p.license_class, p.license_expiry, p.association_name, p.ownership_status::text AS ownership_status, p.home_base
         FROM users u JOIN fleets f ON f.id = u.fleet_id
         LEFT JOIN driver_profiles p ON p.driver_id = u.id
        WHERE u.id = $1 AND u.role = 'DRIVER'`, [params.data.driver_id]);
        const driver = rows[0];
        if (!driver)
            return reply.code(404).send({ error: 'target_not_found' });
        if (auth.role === 'FLEET_MANAGER' && driver.fleet_id !== auth.fleetId) {
            return reply.code(403).send({ error: 'cross_fleet_denied' });
        }
        const { rows: docs } = await pool.query(`SELECT id, doc_type::text AS doc_type, mime_type, size_bytes, expires_on, status::text AS status,
              review_note, reviewed_at, uploaded_at
         FROM driver_documents WHERE driver_id = $1 ORDER BY uploaded_at DESC`, [driver.id]);
        const { rows: vehHist } = await pool.query(`SELECT va.vehicle_id, v.plate_number, va.assigned_at, va.unassigned_at, va.created_by_admin
         FROM driver_vehicle_assignments va JOIN vehicles v ON v.id = va.vehicle_id
        WHERE va.driver_id = $1 ORDER BY va.assigned_at DESC`, [driver.id]);
        const { rows: trlHist } = await pool.query(`SELECT ta.trailer_id, t.plate_number, t.trailer_type, ta.assigned_at, ta.unassigned_at, ta.created_by_admin
         FROM driver_trailer_assignments ta JOIN trailers t ON t.id = ta.trailer_id
        WHERE ta.driver_id = $1 ORDER BY ta.assigned_at DESC`, [driver.id]);
        const { rows: devices } = await pool.query(`SELECT id, device_id, platform, app_version, paired_at, last_seen_at, revoked_at
         FROM device_identities WHERE user_id = $1 ORDER BY paired_at DESC`, [driver.id]);
        return { ...driver, documents: docs, vehicle_history: vehHist, trailer_history: trlHist, devices };
    });
    /** PATCH /admin/documents/:doc_id/status — verify/reject an uploaded document.
     *  Verifying the DRIVING_LICENSE is the activation gate: an admin should also
     *  move the driver out of 'Unassigned Fleet' (below) once the B2B agreement
     *  with the service taker is confirmed. */
    app.patch('/admin/documents/:doc_id/status', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ doc_id: z.string().uuid() }).safeParse(req.params);
        const body = ReviewDocSchema.safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows } = await pool.query(`UPDATE driver_documents d
          SET status = $2::document_status, review_note = $3, reviewed_by = $4, reviewed_at = now()
        WHERE d.id = $1
          AND d.status IN ('PENDING_REVIEW','VERIFIED','REJECTED')
          AND ($5 = 'ADMIN'
               OR EXISTS (SELECT 1 FROM users u WHERE u.id = d.driver_id AND u.fleet_id = $6))
        RETURNING id, driver_id, doc_type::text AS doc_type, status::text AS status`, [params.data.doc_id, body.data.status, body.data.review_note ?? null, auth.id,
            auth.role, auth.fleetId]);
        if (rows.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        await audit({ actorId: auth.id, action: `document_${body.data.status.toLowerCase()}`,
            targetUser: rows[0].driver_id, ip: req.ip, detail: { doc_id: rows[0].id, doc_type: rows[0].doc_type } });
        return rows[0];
    });
    /** POST /admin/drivers/:driver_id/move — assign the driver to a REAL fleet
     *  (activation). This is the moment a self-registered driver becomes usable
     *  by a transport company; documents should already be VERIFIED. */
    app.post('/admin/drivers/:driver_id/move', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid() }).safeParse(req.params);
        const body = MoveDriverSchema.safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows: fl } = await pool.query(`SELECT id, status FROM fleets WHERE id = $1`, [body.data.fleet_id]);
        if (fl.length === 0)
            return reply.code(404).send({ error: 'fleet_not_found' });
        if (fl[0].status !== 'ACTIVE')
            return reply.code(409).send({ error: 'fleet_suspended' });
        const { rows } = await pool.query(`UPDATE users SET fleet_id = $2 WHERE id = $1 AND role = 'DRIVER'
       RETURNING id, full_name, fleet_id`, [params.data.driver_id, body.data.fleet_id]);
        if (rows.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        await audit({ actorId: auth.id, action: 'driver_moved_fleet', targetUser: rows[0].id, ip: req.ip,
            detail: { fleet_id: body.data.fleet_id } });
        return rows[0];
    });
    /** POST /admin/drivers/:driver_id/assign-vehicle — MANDATORY B2B assignment:
     *  once driver and service taker agreed, the admin assigns the truck. Closes
     *  the previous assignment (history kept) and stamps created_by_admin=true.
     *  The vehicle must belong to the admin's fleet scope. */
    app.post('/admin/drivers/:driver_id/assign-vehicle', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid() }).safeParse(req.params);
        const body = AssignVehicleSchema.safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows: drv } = await pool.query(`SELECT id, fleet_id, is_active FROM users WHERE id = $1 AND role = 'DRIVER'`, [params.data.driver_id]);
        if (drv.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        if (auth.role === 'FLEET_MANAGER' && drv[0].fleet_id !== auth.fleetId) {
            return reply.code(403).send({ error: 'cross_fleet_denied' });
        }
        const { rows: veh } = await pool.query(`SELECT id, plate_number, fleet_id FROM vehicles WHERE id = $1`, [body.data.vehicle_id]);
        if (veh.length === 0)
            return reply.code(404).send({ error: 'vehicle_not_found' });
        if (auth.role === 'FLEET_MANAGER' && veh[0].fleet_id !== auth.fleetId) {
            return reply.code(403).send({ error: 'cross_fleet_denied' });
        }
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`UPDATE driver_vehicle_assignments SET unassigned_at = now()
                          WHERE driver_id = $1 AND unassigned_at IS NULL`, [drv[0].id]);
            await client.query(`INSERT INTO driver_vehicle_assignments (driver_id, vehicle_id, created_by_admin)
         VALUES ($1, $2, true)`, [drv[0].id, veh[0].id]);
            // Assignment implies tenancy: pull the asset into the driver's fleet when
            // it sat in 'Unassigned Fleet' after self-registration.
            const { rows: uf } = await client.query(`SELECT id FROM fleets WHERE name = 'Unassigned Fleet'`);
            if (uf.length && veh[0].fleet_id === uf[0].id && drv[0].fleet_id && drv[0].fleet_id !== veh[0].fleet_id) {
                await client.query(`UPDATE vehicles SET fleet_id = $2 WHERE id = $1`, [veh[0].id, drv[0].fleet_id]);
            }
            await client.query('COMMIT');
        }
        catch (err) {
            await client.query('ROLLBACK').catch(() => { });
            throw err;
        }
        finally {
            client.release();
        }
        await audit({ actorId: auth.id, action: 'admin_assigned_vehicle', targetUser: drv[0].id, ip: req.ip,
            detail: { vehicle_id: veh[0].id, plate: veh[0].plate_number } });
        return reply.code(201).send({ driver_id: drv[0].id, vehicle_id: veh[0].id, plate_number: veh[0].plate_number,
            assigned: true, created_by_admin: true });
    });
    /** POST /admin/drivers/:driver_id/assign-trailer — same contract for trailers. */
    app.post('/admin/drivers/:driver_id/assign-trailer', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid() }).safeParse(req.params);
        const body = AssignTrailerSchema.safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows: drv } = await pool.query(`SELECT id, fleet_id FROM users WHERE id = $1 AND role = 'DRIVER'`, [params.data.driver_id]);
        if (drv.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        if (auth.role === 'FLEET_MANAGER' && drv[0].fleet_id !== auth.fleetId) {
            return reply.code(403).send({ error: 'cross_fleet_denied' });
        }
        const { rows: trl } = await pool.query(`SELECT id, plate_number FROM trailers WHERE id = $1`, [body.data.trailer_id]);
        if (trl.length === 0)
            return reply.code(404).send({ error: 'trailer_not_found' });
        await pool.query(`UPDATE driver_trailer_assignments SET unassigned_at = now()
                      WHERE driver_id = $1 AND unassigned_at IS NULL`, [drv[0].id]);
        await pool.query(`INSERT INTO driver_trailer_assignments (driver_id, trailer_id, created_by_admin)
       VALUES ($1, $2, true)`, [drv[0].id, trl[0].id]);
        await audit({ actorId: auth.id, action: 'admin_assigned_trailer', targetUser: drv[0].id, ip: req.ip,
            detail: { trailer_id: trl[0].id, plate: trl[0].plate_number } });
        return reply.code(201).send({ driver_id: drv[0].id, trailer_id: trl[0].id, plate_number: trl[0].plate_number,
            assigned: true, created_by_admin: true });
    });
    /** POST /admin/drivers/:driver_id/suspend — stop a driver everywhere at once:
     *  is_active=false ⇒ authGuard/refresh deny, ingest denies (users lookup). */
    app.post('/admin/drivers/:driver_id/suspend', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid(), active: z.boolean().default(false) })
            .safeParse({ driver_id: req.params.driver_id, ...(req.body ?? {}) });
        if (!params.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows } = await pool.query(`UPDATE users SET is_active = $2 WHERE id = $1 AND role = 'DRIVER' RETURNING id, full_name, is_active`, [params.data.driver_id, params.data.active]);
        if (rows.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        if (!params.data.active) {
            await pool.query(`UPDATE device_identities SET revoked_at = now(), revoke_reason = 'admin_suspend'
                        WHERE user_id = $1 AND revoked_at IS NULL`, [rows[0].id]);
        }
        else {
            // Reactivation restores the CURRENT pairing only (the driver keeps using
            // the app without re-pairing). Devices revoked for other reasons — e.g.
            // admin_revoke / lost phone — stay dead and require a fresh OTP pairing.
            await pool.query(`UPDATE device_identities di SET revoked_at = NULL, revoke_reason = NULL
          WHERE di.user_id = $1 AND di.revoked_at IS NOT NULL AND di.revoke_reason = 'admin_suspend'
            AND di.device_id = (SELECT device_id FROM users WHERE id = $1 AND device_id IS NOT NULL)`, [rows[0].id]);
        }
        await audit({ actorId: auth.id, action: params.data.active ? 'driver_reactivated' : 'driver_suspended',
            targetUser: rows[0].id, ip: req.ip });
        return rows[0];
    });
    /** POST /admin/drivers/:driver_id/revoke-device — force logout of an install
     *  (lost/stolen phone). Driver re-pairs later with OTP. */
    app.post('/admin/drivers/:driver_id/revoke-device', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const params = z.object({ driver_id: z.string().uuid() }).safeParse(req.params);
        const body = z.object({ device_id: z.string().min(8).max(128), reason: z.string().max(200).optional() })
            .safeParse(req.body);
        if (!params.success || !body.success)
            return reply.code(400).send({ error: 'validation_failed' });
        const { rows: drv } = await pool.query(`SELECT id, fleet_id FROM users WHERE id = $1 AND role = 'DRIVER'`, [params.data.driver_id]);
        if (drv.length === 0)
            return reply.code(404).send({ error: 'target_not_found' });
        if (auth.role === 'FLEET_MANAGER' && drv[0].fleet_id !== auth.fleetId)
            return reply.code(403).send({ error: 'cross_fleet_denied' });
        // Idempotent: already-revoked pairings still return 200 (the desired end
        // state holds), but a device never paired to this driver is a genuine 404.
        const { rowCount } = await pool.query(`UPDATE device_identities SET revoked_at = now(), revoke_reason = COALESCE($3, 'admin_revoke')
        WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`, [drv[0].id, body.data.device_id, body.data.reason ?? null]);
        if (rowCount === 0) {
            const { rows: existed } = await pool.query(`SELECT 1 FROM device_identities WHERE user_id = $1 AND device_id = $2 LIMIT 1`, [drv[0].id, body.data.device_id]);
            if (existed.length === 0)
                return reply.code(404).send({ error: 'pairing_not_found' });
        }
        await pool.query(`UPDATE users SET device_id = NULL WHERE id = $1 AND device_id = $2`, [drv[0].id, body.data.device_id]);
        await audit({ actorId: auth.id, action: 'device_revoked_admin', targetUser: drv[0].id, ip: req.ip,
            detail: { device_id: body.data.device_id } });
        return { revoked: true };
    });
    /** GET /admin/vehicles — asset directory for the assignment UI. FLEET_MANAGER
     *  sees own fleet (+ Unassigned Fleet for confirming self-registered assets). */
    app.get('/admin/vehicles', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const { rows } = await pool.query(`SELECT v.id, v.plate_number, v.vehicle_type::text AS vehicle_type, v.make_model, v.capacity_tons,
              v.body_type, v.ownership_status::text AS ownership_status, v.fleet_id, f.name AS fleet_name,
              (SELECT json_build_object('driver_id', u.id, 'full_name', u.full_name, 'assigned_at', va.assigned_at,
                                        'by_admin', va.created_by_admin)
                 FROM driver_vehicle_assignments va JOIN users u ON u.id = va.driver_id
                WHERE va.vehicle_id = v.id AND va.unassigned_at IS NULL LIMIT 1) AS current_driver
         FROM vehicles v JOIN fleets f ON f.id = v.fleet_id
        WHERE ($1 = 'ADMIN' OR v.fleet_id = $2 OR f.name = 'Unassigned Fleet')
        ORDER BY f.name, v.plate_number LIMIT 500`, [auth.role, auth.fleetId]);
        return { count: rows.length, vehicles: rows };
    });
    /** GET /admin/trailers — trailer directory, same scoping rule. */
    app.get('/admin/trailers', async (req, reply) => {
        const auth = await authGuard(req, reply);
        if (!auth)
            return reply; // denial already sent by the guard
        if (auth.role !== 'ADMIN' && auth.role !== 'FLEET_MANAGER')
            return reply.code(403).send({ error: 'forbidden_role' });
        const { rows } = await pool.query(`SELECT t.id, t.plate_number, t.trailer_type, t.capacity_tons, t.equipment_details, t.fleet_id,
              (SELECT json_build_object('driver_id', u.id, 'full_name', u.full_name, 'assigned_at', ta.assigned_at)
                 FROM driver_trailer_assignments ta JOIN users u ON u.id = ta.driver_id
                WHERE ta.trailer_id = t.id AND ta.unassigned_at IS NULL LIMIT 1) AS current_driver
         FROM trailers t
        WHERE ($1 = 'ADMIN' OR t.fleet_id = $2 OR t.fleet_id IS NULL OR
               t.fleet_id = (SELECT id FROM fleets WHERE name = 'Unassigned Fleet'))
        ORDER BY t.plate_number LIMIT 500`, [auth.role, auth.fleetId]);
        return { count: rows.length, trailers: rows };
    });
}
/** constant-time compare for hex digests */
function timingSafeEq(aHex, bHex) {
    const a = Buffer.from(aHex, 'hex');
    const b = Buffer.from(bHex, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** Pair (or re-pair) a device: upsert device_identities, stamp users.device_id
 *  (unique index ⇒ evict the previous holder of this install), return a token. */
async function pairDevice(userId, deviceId, platform, appVersion, ip, _via) {
    // A device install may move between drivers (hand-me-down phones): evict any
    // OTHER user's pointer to this device_id before claiming it.
    await pool.query(`UPDATE users SET device_id = NULL WHERE device_id = $1 AND id <> $2`, [deviceId, userId]);
    await pool.query(`INSERT INTO device_identities (user_id, device_id, platform, app_version)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, device_id) DO UPDATE
       SET platform = COALESCE(EXCLUDED.platform, device_identities.platform),
           app_version = COALESCE(EXCLUDED.app_version, device_identities.app_version),
           last_seen_at = now()`, [userId, deviceId, platform ?? null, appVersion ?? null]);
    await pool.query(`UPDATE users SET device_id = $2 WHERE id = $1`, [userId, deviceId]);
    const { rows } = await pool.query(`SELECT role, locale, fleet_id FROM users WHERE id = $1`, [userId]);
    return signAccessToken({ sub: userId, role: rows[0].role, locale: rows[0].locale, fleetId: rows[0].fleet_id ?? undefined });
}
//# sourceMappingURL=onboarding.js.map