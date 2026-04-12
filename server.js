/**
 * REVIEWER APP - MAIN SERVER
 * Full-featured reviewer web application with Node.js, Bootstrap, and Supabase
 */

import 'dotenv/config';
import express from 'express';
import { puter } from '@heyputer/puter.js';
import PDFDocument from 'pdfkit';
import session from 'express-session';
import helmet from 'helmet';
import connectPgSimple from 'connect-pg-simple';
import { Pool } from 'pg';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import { createClient as createRedisClient } from 'redis';
import bcryptLib from 'bcryptjs';

// Promise-based wrapper around bcryptjs to keep async/await usage
const bcrypt = {
    hash: (password, rounds) => new Promise((resolve, reject) => {
        bcryptLib.hash(password, rounds, (err, hash) => err ? reject(err) : resolve(hash));
    }),
    compare: (password, hash) => new Promise((resolve, reject) => {
        bcryptLib.compare(password, hash, (err, res) => err ? reject(err) : resolve(res));
    })
};
import multer from 'multer';
import http from 'http';
import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import crypto from 'crypto';
import { promises as dns } from 'dns';
import nodemailer from 'nodemailer';
import compression from 'compression';
import webPush from 'web-push';

// If a Puter API token is provided in the environment, configure the SDK.
if (process.env.PUTER_API_TOKEN) {
    try {
        puter.setAuthToken(process.env.PUTER_API_TOKEN);
        console.info('Puter: auth token loaded from environment');
    } catch (err) {
        console.warn('Puter: failed to apply auth token from environment', err?.message || err);
    }
} else {
    console.info('Puter: no PUTER_API_TOKEN in environment; Puter.ai calls may fail');
}

// ─── Discord error reporter (rate-limited) ────────────────────────────────────
// notifyDiscord() is declared later as a hoisted function declaration — it is
// safe to reference here because function declarations are hoisted in JS.
// Rate-limit: same label can only fire once every 2 minutes to prevent spam.
const _discordRateMap = new Map();
const _DISCORD_RATE_MS = 2 * 60 * 1000;
function _discord(title, fields) {
    const url = process.env.DISCORD_ERROR_WEBHOOK;
    if (!url) return;
    const now = Date.now();
    const last = _discordRateMap.get(title) || 0;
    if (now - last < _DISCORD_RATE_MS) return;
    _discordRateMap.set(title, now);
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title,
                color: 0xe74c3c,
                timestamp: new Date().toISOString(),
                fields: fields.map(([name, value]) => ({ name, value: String(value).slice(0, 1024), inline: false }))
            }]
        })
    }).catch(() => {});
}

// Wrap console.error so every existing catch block auto-reports to Discord.
// Ignores noise: Supabase PGRST116 (row not found), Socket hang-ups, etc.
const _origConsoleError = console.error.bind(console);
console.error = function (...args) {
    _origConsoleError(...args);
    try {
        const msgStr = args.map(a => {
            if (a instanceof Error) return a.stack || a.message;
            if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch { return String(a); } }
            return String(a);
        }).join(' ');
        // Skip noisy / expected non-errors
        if (
            msgStr.includes('PGRST116') ||
            msgStr.includes('socket hang up') ||
            msgStr.includes('ECONNRESET') ||
            msgStr.includes('EPIPE') ||
            msgStr.includes('write EPIPE') ||
            msgStr.includes('aborted') ||
            msgStr.includes('ERR_HTTP2_STREAM_CANCEL') ||
            msgStr.includes('Startup migration warning')
        ) return;
        const label = (typeof args[0] === 'string' ? args[0] : 'Server Error').slice(0, 60);
        const errObj = args.find(a => a instanceof Error);
        const fields = [['Message', msgStr.slice(0, 1000)]];
        if (errObj?.stack) fields.push(['Stack', errObj.stack.slice(0, 1000)]);
        fields.push(['Time (UTC)', new Date().toISOString()]);
        _discord(`🔴 ${label}`, fields);
    } catch (_) { /* never let Discord reporting crash anything */ }
};

// ─── Activity logger (DISCORD_ACTIVITY_WEBHOOK) ─────────────────────────────
// Separate webhook for user activity events (green embeds).
// Rate-limited per key so the same user doesn't spam on every click.
const _activityRateMap = new Map();
const _ACTIVITY_RATE_MS = 60 * 60 * 1000; // 1 hour per key
function _activityDiscord(title, fields) {
    const url = process.env.DISCORD_ACTIVITY_WEBHOOK;
    if (!url) return;
    fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            embeds: [{
                title,
                color: 0x2ecc71,
                timestamp: new Date().toISOString(),
                fields: fields.map(([name, value]) => ({ name, value: String(value).slice(0, 1024), inline: false }))
            }]
        })
    }).catch(() => {});
}
// Helper: format a user link for Discord/activity logs
function _userLink(req) {
    try {
        const base = (process.env.BASE_URL || process.env.PRODUCTION_URL || '').replace(/\/$/, '');
        const username = req && req.session && req.session.username ? String(req.session.username) : null;
        const userId = req && req.session && req.session.userId ? String(req.session.userId) : null;
        if (base && username && userId) {
            return `[${username}](${base}/user?id=${encodeURIComponent(userId)})`;
        }
        if (username) return username;
        if (userId) return `user:${userId}`;
        return 'n/a';
    } catch (_) {
        return 'n/a';
    }
}
    

function _extractAndroidModelFromUA(uaRaw) {
    const ua = normalizeUserAgent(uaRaw);
    const paren = ua.match(/\(([^)]+)\)/);
    if (!paren || !paren[1]) return '';

    const parts = paren[1].split(';').map((p) => p.trim()).filter(Boolean);
    const androidIdx = parts.findIndex((p) => /android/i.test(p));
    if (androidIdx === -1) return '';

    for (let i = androidIdx + 1; i < parts.length; i += 1) {
        let token = String(parts[i] || '').replace(/\s+build\/.*/i, '').trim();
        if (!token) continue;

        const low = token.toLowerCase();
        if (low === 'wv' || low === 'u' || low === 'mobile' || low === 'tablet') continue;
        if (/^[a-z]{2}[-_][a-z]{2}$/i.test(token)) continue; // locale like en-US
        if (/^(linux|android)$/i.test(token)) continue;
        if (token.length < 2) continue;

        // Keep tokens that look like product identifiers or model names.
        if (/[a-z]/i.test(token) || /\d/.test(token)) return token;
    }

    return '';
}

function getExactDeviceModel(req, uaRaw) {
    const hinted = _stripQuotedHeaderValue(_readHeader(req, 'sec-ch-ua-model'));
    if (hinted && hinted !== '?0') return hinted;

    const ua = normalizeUserAgent(uaRaw);
    if (/android/i.test(ua)) {
        const model = _extractAndroidModelFromUA(ua);
        if (model) return model;
        return 'Android Device';
    }
    if (/iphone/i.test(ua)) return 'iPhone';
    if (/ipad/i.test(ua)) return 'iPad';
    return '';
}

function getIpLocationFromHeaders(req, ipRaw) {
    const ip = _normalizeIpForDisplay(ipRaw);

    const country = _stripQuotedHeaderValue(_readHeader(req, 'x-vercel-ip-country') || _readHeader(req, 'cf-ipcountry'));
    const region = _stripQuotedHeaderValue(_readHeader(req, 'x-vercel-ip-country-region'));
    const city = _stripQuotedHeaderValue(_readHeader(req, 'x-vercel-ip-city'));

    const parts = [city, region, country].filter(Boolean);
    if (parts.length > 0) {
        return {
            countryCode: country || null,
            locationText: parts.join(', ')
        };
    }

    // Fallback labels for local/private addresses during development.
    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
        return { countryCode: null, locationText: 'Localhost' };
    }
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(ip)) {
        return { countryCode: null, locationText: 'Private network' };
    }

    return {
        countryCode: null,
        locationText: ip && ip !== 'n/a' ? `IP: ${ip}` : 'Unknown location'
    };
}

function getDeviceLabelFromUA(uaRaw) {
    const ua = normalizeUserAgent(uaRaw);
    const low = ua.toLowerCase();

    let os = 'Unknown OS';
    if (low.includes('windows')) os = 'Windows';
    else if (low.includes('android')) os = 'Android';
    else if (low.includes('iphone') || low.includes('ipad') || low.includes('ios')) os = 'iOS';
    else if (low.includes('mac os') || low.includes('macintosh')) os = 'macOS';
    else if (low.includes('linux')) os = 'Linux';

    let browser = 'Unknown Browser';
    if (low.includes('edg/')) browser = 'Edge';
    else if (low.includes('opr/') || low.includes('opera')) browser = 'Opera';
    else if (low.includes('chrome/') && !low.includes('edg/')) browser = 'Chrome';
    else if (low.includes('firefox/')) browser = 'Firefox';
    else if (low.includes('safari/') && !low.includes('chrome/')) browser = 'Safari';

    const deviceType = /(mobile|iphone|android)/i.test(ua) ? 'Mobile' : 'Desktop';
    return `${deviceType} • ${os} • ${browser}`;
}

function getDeviceFingerprint(uaRaw) {
    const normalized = normalizeUserAgent(uaRaw).toLowerCase();
    return crypto.createHash('sha256').update(normalized).digest('hex');
}

const LOGIN_ACTIVITY_VERIFY_WINDOW_MS = 10 * 60 * 1000;

function isLoginActivityVerified(req) {
    const raw = req && req.session ? req.session.loginActivityVerifiedUntil : null;
    const until = Number(raw || 0);
    return Number.isFinite(until) && until > Date.now();
}

function markLoginActivityVerified(req) {
    if (!req || !req.session) return;
    req.session.loginActivityVerifiedUntil = Date.now() + LOGIN_ACTIVITY_VERIFY_WINDOW_MS;
}

function clearLoginActivityVerified(req) {
    if (!req || !req.session) return;
    delete req.session.loginActivityVerifiedUntil;
}

async function destroySessionBySid(sid) {
    if (!sid) return;

    // Try the configured session store first (works for pg store and memory store).
    if (sessionStore && typeof sessionStore.destroy === 'function') {
        await new Promise((resolve) => {
            try {
                sessionStore.destroy(String(sid), () => resolve());
            } catch (_) {
                resolve();
            }
        });
    }

    // Best-effort direct delete from Postgres session table.
    try {
        const pool = createSessionPool();
        if (pool) await pool.query('DELETE FROM session WHERE sid = $1', [String(sid)]);
    } catch (_) {
        // Non-fatal; not all environments use Postgres session storage.
    }
}

async function trackLoginActivityAndNotify(req, user) {
    try {
        if (!req || !req.sessionID || !user || !user.id) return;

        const sid = String(req.sessionID);
        const userAgent = normalizeUserAgent(req.headers && req.headers['user-agent']);
        const ip = _normalizeIpForDisplay(getClientIp(req));
        const deviceModel = getExactDeviceModel(req, userAgent);
        const geo = getIpLocationFromHeaders(req, ip);
        const deviceHash = getDeviceFingerprint(userAgent);
        const baseLabel = getDeviceLabelFromUA(userAgent);
        const deviceLabel = deviceModel ? `${baseLabel} • ${deviceModel}` : baseLabel;

        const { data: knownDeviceRows } = await supabaseAdmin
            .from('user_login_activity')
            .select('id')
            .eq('user_id', user.id)
            .eq('device_hash', deviceHash)
            .limit(1);

        const isUnfamiliar = !knownDeviceRows || knownDeviceRows.length === 0;

        await supabaseAdmin
            .from('user_login_activity')
            .upsert([{
                user_id: user.id,
                session_sid: sid,
                device_hash: deviceHash,
                device_label: deviceLabel,
                device_model: deviceModel || null,
                ip_address: ip,
                country_code: geo.countryCode,
                location_text: geo.locationText,
                user_agent: userAgent,
                is_unfamiliar: isUnfamiliar,
                last_seen_at: new Date().toISOString(),
                revoked_at: null
            }], { onConflict: 'session_sid' });

        if (isUnfamiliar && user.email) {
            const mailResult = await sendTemplatedEmail({
                to: user.email,
                subject: 'New login detected on your Thinky account',
                template: 'new_device_login_alert',
                skipDomainValidation: true,
                variables: {
                    username: user.username || 'there',
                    device: deviceLabel,
                    model: deviceModel || 'Unknown',
                    ip,
                    location: geo.locationText || 'Unknown location',
                    time: new Date().toLocaleString('en-US', { timeZone: 'UTC', hour12: true }) + ' UTC'
                }
            });

            if (!mailResult || !mailResult.ok) {
                console.warn('Unfamiliar-login alert email failed:', {
                    userId: user.id,
                    email: user.email,
                    reason: mailResult && (mailResult.info || mailResult.error) ? (mailResult.info || String(mailResult.error)) : 'unknown'
                });
            } else {
                console.info('Unfamiliar-login alert email sent:', { userId: user.id, email: user.email });
            }
        }
    } catch (err) {
        console.warn('trackLoginActivityAndNotify warning:', err && err.message ? err.message : err);
    }
}

// =====================================================
// INPUT VALIDATION & SANITIZATION UTILITIES
// =====================================================

// UUID validation regex (compile once)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,50}$/;

function isValidUUID(str) {
    return typeof str === 'string' && UUID_REGEX.test(str);
}

function isValidEmail(str) {
    return typeof str === 'string' && str.length <= 255 && EMAIL_REGEX.test(str);
}

function isValidUsername(str) {
    return typeof str === 'string' && USERNAME_REGEX.test(str);
}

// Sanitize string input - remove null bytes and limit length
function sanitizeString(str, maxLength = 1000) {
    if (typeof str !== 'string') return '';
    return str.replace(/\x00/g, '').slice(0, maxLength).trim();
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Express app
const app = express();
// Determine a safe `trust proxy` setting. Setting this to `true` is permissive
// and may allow clients to spoof IP addresses; prefer trusting a single proxy
// in production (typical for Vercel) or allow explicit configuration via
// `TRUST_PROXY`. Supported values:
//  - numeric string (e.g. "1") — trust that number of proxies
//  - "true" — treated as "1"
//  - explicit value (CIDR/list) — passed through
// Default: trust 1 proxy when NODE_ENV=production, otherwise false.
let trustProxySetting = false;
if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY.trim();
    if (/^\d+$/.test(v)) {
        trustProxySetting = parseInt(v, 10);
    } else if (v === 'true') {
        trustProxySetting = 1;
    } else if (v === 'false') {
        trustProxySetting = false;
    } else {
        trustProxySetting = v; // allow advanced values
    }
} else if (process.env.NODE_ENV === 'production') {
    trustProxySetting = 1;
}
app.set('trust proxy', trustProxySetting);
// Normalize any accidental boolean `true` (too permissive) into a numeric 1
// which trusts a single proxy. This prevents express-rate-limit from throwing
// ERR_ERL_PERMISSIVE_TRUST_PROXY while still allowing typical proxy setups.
if (app.get('trust proxy') === true) {
    console.warn('Express trust proxy was boolean true; normalizing to 1 to avoid permissive trust errors.');
    app.set('trust proxy', 1);
}
console.info('Express trust proxy:', app.get('trust proxy'));
const PORT = process.env.PORT || 3000;

// Initialize Supabase client
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
);

// Admin client with service role key for admin operations
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Redis cache + optional distributed rate limiting ─────────────────────────
const REDIS_URL = process.env.REDIS_URL || process.env.UPSTASH_REDIS_URL || '';
const CACHE_PREFIX = process.env.REDIS_CACHE_PREFIX || 'thinky';
const DEFAULT_CACHE_TTL_SECONDS = Math.max(5, parseInt(process.env.CACHE_DEFAULT_TTL_SECONDS || '120', 10));
let redisClient = null;
let redisReady = false;

if (REDIS_URL) {
    try {
        redisClient = createRedisClient({ url: REDIS_URL });
        redisClient.on('error', (err) => {
            redisReady = false;
            console.warn('[cache] Redis error, fallback to DB:', err && err.message ? err.message : err);
        });
        redisClient.on('ready', () => {
            redisReady = true;
            console.info('[cache] Redis ready');
        });
        redisClient.connect().catch((err) => {
            redisReady = false;
            console.warn('[cache] Redis connect failed, fallback to DB:', err && err.message ? err.message : err);
        });
    } catch (err) {
        redisReady = false;
        console.warn('[cache] Redis init failed, fallback to DB:', err && err.message ? err.message : err);
    }
} else {
    console.info('[cache] REDIS_URL not set, caching disabled');
}

function stableStringifyForCache(input) {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return '[' + input.map(stableStringifyForCache).join(',') + ']';
    const keys = Object.keys(input).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringifyForCache(input[k])).join(',') + '}';
}

function hashForCache(raw) {
    return crypto.createHash('sha1').update(String(raw || '')).digest('hex');
}

function normalizeQueryForCache(queryObj) {
    if (!queryObj || typeof queryObj !== 'object') return '';
    return Object.keys(queryObj)
        .sort()
        .map((key) => {
            const value = queryObj[key];
            if (Array.isArray(value)) {
                return `${encodeURIComponent(key)}=${encodeURIComponent(value.map((v) => String(v)).sort().join(','))}`;
            }
            return `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`;
        })
        .join('&');
}

function buildApiCacheKey(req, options = {}) {
    const {
        namespace = 'api',
        includeUser = false,
        extraParts = []
    } = options;

    const userScope = includeUser ? String((req.session && req.session.userId) || 'anon') : 'public';
    const routePart = String(req.path || req.originalUrl || 'unknown');
    const queryPart = normalizeQueryForCache(req.query);
    const extraPart = stableStringifyForCache(extraParts);
    const fingerprint = hashForCache(`${routePart}|${queryPart}|${extraPart}`);
    return `${CACHE_PREFIX}:cache:${namespace}:user:${userScope}:key:${fingerprint}`;
}

async function safeRedisGetJson(key) {
    if (!redisClient || !redisReady) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        console.warn('[cache] read failed, fallback to DB:', err && err.message ? err.message : err);
        return null;
    }
}

async function safeRedisSetJson(key, value, ttlSeconds = DEFAULT_CACHE_TTL_SECONDS) {
    if (!redisClient || !redisReady) return;
    try {
        const ttl = Math.max(1, parseInt(ttlSeconds || DEFAULT_CACHE_TTL_SECONDS, 10));
        await redisClient.setEx(key, ttl, JSON.stringify(value));
    } catch (err) {
        console.warn('[cache] write failed:', err && err.message ? err.message : err);
    }
}

function cacheResponse(options = {}) {
    const {
        namespace = 'api',
        ttlSeconds = DEFAULT_CACHE_TTL_SECONDS,
        includeUser = false,
        extraParts = []
    } = options;

    return async (req, res, next) => {
        if (req.method !== 'GET') return next();

        const resolvedExtraParts = typeof extraParts === 'function' ? extraParts(req) : extraParts;
        const cacheKey = buildApiCacheKey(req, {
            namespace,
            includeUser,
            extraParts: resolvedExtraParts || []
        });

        const cached = await safeRedisGetJson(cacheKey);
        if (cached !== null) {
            console.info('[cache] HIT', namespace, cacheKey);
            res.set('X-Cache', 'HIT');
            return res.json(cached);
        }

        console.info('[cache] MISS', namespace, cacheKey);
        res.set('X-Cache', 'MISS');

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode >= 200 && res.statusCode < 400) {
                safeRedisSetJson(cacheKey, body, ttlSeconds).catch(() => {});
            }
            return originalJson(body);
        };

        next();
    };
}

async function invalidateCacheNamespace(namespace) {
    if (!redisClient || !redisReady) return;
    const matchPattern = `${CACHE_PREFIX}:cache:${namespace}:*`;
    const keys = [];
    try {
        for await (const key of redisClient.scanIterator({ MATCH: matchPattern, COUNT: 100 })) {
            keys.push(key);
            if (keys.length >= 200) {
                await redisClient.del(keys);
                keys.length = 0;
            }
        }
        if (keys.length > 0) await redisClient.del(keys);
        console.info('[cache] INVALIDATE namespace=', namespace);
    } catch (err) {
        console.warn('[cache] invalidate failed for namespace', namespace, err && err.message ? err.message : err);
    }
}

async function invalidateCacheNamespaces(namespaces = []) {
    const unique = [...new Set((namespaces || []).filter(Boolean))];
    await Promise.allSettled(unique.map((ns) => invalidateCacheNamespace(ns)));
}

function createRedisRateLimitMiddleware(options = {}) {
    const {
        windowSeconds = 60,
        maxRequests = 120,
        keyPrefix = `${CACHE_PREFIX}:ratelimit`
    } = options;

    return async (req, res, next) => {
        if (!redisClient || !redisReady) return next();
        try {
            const userOrIp = (req.session && req.session.userId) || req.ip || 'anonymous';
            const key = `${keyPrefix}:${userOrIp}`;
            const count = await redisClient.incr(key);
            if (count === 1) {
                await redisClient.expire(key, Math.max(1, parseInt(windowSeconds, 10)));
            }
            if (count > maxRequests) {
                return res.status(429).json({ error: 'Too many requests (distributed limiter)' });
            }
            next();
        } catch (err) {
            console.warn('[rate-limit] Redis limiter failed, allowing request:', err && err.message ? err.message : err);
            next();
        }
    };
}

// ── Web Push (VAPID) setup ────────────────────────────────────────────────────
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(
        process.env.VAPID_MAILTO || 'mailto:admin@thinky.com',
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
}

/**
 * Send a push notification to all subscriptions for a given user.
 * Silently removes expired/invalid subscriptions.
 */
async function sendPushToUser(userId, payload) {
    if (!process.env.VAPID_PUBLIC_KEY) return; // push not configured
    try {
        const { data: subs } = await supabaseAdmin
            .from('push_subscriptions')
            .select('id, endpoint, p256dh, auth')
            .eq('user_id', userId);

        if (!subs || subs.length === 0) return;

        const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const staleIds = [];

        await Promise.allSettled(
            subs.map(async (sub) => {
                try {
                    await webPush.sendNotification(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        payloadStr
                    );
                } catch (err) {
                    // 410 Gone or 404 = subscription expired → remove
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        staleIds.push(sub.id);
                    } else {
                        console.warn('[push] send error for sub', sub.id, err.statusCode || err.message);
                    }
                }
            })
        );

        if (staleIds.length > 0) {
            await supabaseAdmin.from('push_subscriptions').delete().in('id', staleIds);
        }
    } catch (err) {
        console.warn('[push] sendPushToUser error:', err.message);
    }
}

// Helper to add an upstream timeout to any promise (e.g., Supabase requests)
async function withTimeout(promise, ms = 8000) {
    let timer;
    return await Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('upstream_timeout')), ms);
        })
    ]).finally(() => clearTimeout(timer));
}

// Determine whether critical environment variables are present.
let serverReady = true;
const missingEnv = [];
if (!process.env.SUPABASE_URL) missingEnv.push('SUPABASE_URL');
if (!process.env.SUPABASE_ANON_KEY) missingEnv.push('SUPABASE_ANON_KEY');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
if (!process.env.SESSION_SECRET) missingEnv.push('SESSION_SECRET');
if (missingEnv.length) {
    console.error('Missing critical environment variables:', missingEnv.join(', '));
    serverReady = false;
}

// Lightweight startup diagnostics (no secrets logged)
console.info('Startup check:', {
    serverReady,
    NODE_ENV: process.env.NODE_ENV || 'development',
    PRODUCTION_URL_present: !!process.env.PRODUCTION_URL,
    SUPABASE_URL_present: !!process.env.SUPABASE_URL,
});

// If not ready, return a simple JSON 500 for API routes to avoid crashing.
app.use('/api', (req, res, next) => {
    // Add request ID for debugging/tracing
    req.requestId = crypto.randomUUID();
    res.set('X-Request-ID', req.requestId);
    
    // Allow the status endpoint to be reachable even when the server is misconfigured
    if (!serverReady) {
        if (req.path === '/_status') return next();
        return res.status(500).json({ error: 'Server misconfigured', missing: missingEnv });
    }
    // Prevent caching of API responses to avoid 304/Not Modified responses
    try { res.set('Cache-Control', 'no-store'); } catch (e) { /* ignore */ }
    next();
});

// Lightweight status endpoint (non-secret) to help debug missing env vars in production
app.get('/api/_status', (req, res) => {
    res.json({
        serverReady,
        missing: missingEnv,
        nodeEnv: process.env.NODE_ENV || 'development',
        productionUrlPresent: !!process.env.PRODUCTION_URL
    });
});

// Debug: return the last inserted message (requires auth)
// (debug route moved to after auth middleware to avoid initialization order issues)

// Environment check (safe): do not return secret values, only presence and lengths
app.get('/api/_env_check', (req, res) => {
    const check = {
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_URL_length: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.length : 0,
        SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
        SUPABASE_ANON_KEY_length: process.env.SUPABASE_ANON_KEY ? process.env.SUPABASE_ANON_KEY.length : 0,
        SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
        SUPABASE_SERVICE_ROLE_KEY_length: process.env.SUPABASE_SERVICE_ROLE_KEY ? process.env.SUPABASE_SERVICE_ROLE_KEY.length : 0,
        SESSION_SECRET: !!process.env.SESSION_SECRET,
        NODE_ENV: process.env.NODE_ENV || 'development'
    };
    res.json(check);
});

// Debug Supabase reachability: runs a quick query with a 5s timeout
app.get('/api/_debug_supabase', async (req, res) => {
    try {
        const fetchPromise = (async () => {
            const { data, error } = await supabaseAdmin.from('users').select('id').limit(1);
            return { data, error };
        })();

        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('supabase_timeout')), 5000));

        const result = await Promise.race([fetchPromise, timeout]);

        if (result.error) {
            return res.status(500).json({ ok: false, error: String(result.error) });
        }

        return res.json({ ok: true, data: result.data });
    } catch (err) {
        return res.status(504).json({ ok: false, error: err && err.message ? err.message : String(err) });
    }
});
// =====================================================
// MIDDLEWARE CONFIGURATION
// =====================================================

// Security middleware
// In development we allow 'unsafe-eval' because some third-party UMD bundles
// (e.g., older supabase UMD builds) rely on eval/new Function. Do NOT enable
// this in production for security reasons.
const isProd = process.env.NODE_ENV === 'production';
const scriptSrcArray = [
    "'self'",
    "'unsafe-inline'",
    "https://cdn.jsdelivr.net",
    "https://cdn.quilljs.com",
    "https://js.puter.com",
    // AdSense script host
    "https://pagead2.googlesyndication.com"
];
if (!isProd) scriptSrcArray.push("'unsafe-eval'");

// Enable gzip/brotli compression for all responses
app.use(compression({
    level: 6, // balanced compression level
    threshold: 1024, // only compress responses > 1KB
    filter: (req, res) => {
        // Don't compress if client doesn't accept encoding
        if (req.headers['x-no-compression']) return false;
        return compression.filter(req, res);
    }
}));

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: [
                "'self'",
                "data:",
                "https://cdn.jsdelivr.net",
                "https://js.puter.com",
                "https://api.puter.com",
                "https://auth.puter.com",
                "https://*.puter.com",
                "wss:",
                process.env.SUPABASE_URL,
                // AdSense/Google Ads network calls
                "https://pagead2.googlesyndication.com",
                "https://googleads.g.doubleclick.net",
                "https://www.google.com",
                "https://www.googleadservices.com"
            ].filter(Boolean),
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://cdn.quilljs.com"],
            scriptSrc: scriptSrcArray,
            scriptSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "https:"],
            frameSrc: [
                "'self'",
                // AdSense iframes
                "https://googleads.g.doubleclick.net",
                "https://tpc.googlesyndication.com",
                "https://pagead2.googlesyndication.com"
            ],
            frameAncestors: ["'none'"],
            formAction: ["'self'"],
            baseUri: ["'self'"],
        },
    },
    // Additional security headers
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    noSniff: true,
    hidePoweredBy: true,
}));

// Ask compatible browsers to send UA Client Hints, including device model.
app.use((req, res, next) => {
    try {
        res.setHeader('Accept-CH', 'Sec-CH-UA-Model, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version');
    } catch (_) {
        // Non-fatal header hint.
    }
    next();
});

if (!isProd) console.info('Helmet CSP: development mode - allowing unsafe-eval for third-party UMDs');

// Normalize production origin (strip trailing slash) and configure CORS
const productionOrigin = process.env.PRODUCTION_URL ? process.env.PRODUCTION_URL.replace(/\/$/, '') : null;
// Configure CORS. In production only allow the configured production origin
// and reflect it in the response so `Access-Control-Allow-Origin` exactly
// matches the request origin when credentials are used.
app.use(cors({
    origin: function (incomingOrigin, callback) {
        // Allow non-browser requests (no origin) and localhost in development
        if (!incomingOrigin) return callback(null, true);

        if (process.env.NODE_ENV === 'production' && productionOrigin) {
            if (incomingOrigin === productionOrigin) return callback(null, true);
            // Not allowed
            return callback(new Error('Not allowed by CORS'));
        }

        // Development: allow localhost:3000
        const devOrigin = 'http://localhost:3000';
        if (incomingOrigin === devOrigin) return callback(null, true);

        // Default deny
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
}));

// Rate limiting
if (process.env.REDIS_RATE_LIMIT_ENABLED === 'true') {
    app.use('/api/', createRedisRateLimitMiddleware({
        windowSeconds: parseInt(process.env.REDIS_RATE_LIMIT_WINDOW_SECONDS || '60', 10),
        maxRequests: parseInt(process.env.REDIS_RATE_LIMIT_MAX_REQUESTS || '250', 10),
        keyPrefix: `${CACHE_PREFIX}:ratelimit:api`
    }));
}

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 500, // limit each IP to 500 requests per windowMs
    message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Stricter rate limit for auth routes — return JSON so clients parsing JSON won't fail
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res /*, next */) => {
        res.status(429).json({ error: 'Too many authentication attempts, please try again later.' });
    }
});

// Even stricter limiter for password reset to prevent enumeration
const passwordResetLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 attempts per hour
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({ error: 'Too many password reset attempts. Please try again later.' });
    }
});

// Message sending rate limiter to prevent spam
const messageLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 messages per minute
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
        res.status(429).json({ error: 'You are sending messages too quickly. Please slow down.' });
    }
});

// Per-user login attempt tracking to enforce cooldowns (in-memory).
// Configurable via environment variables. This is an in-memory guard
// and will not be shared across multiple server instances.
const loginAttempts = new Map();
const PER_USER_MAX_ATTEMPTS = parseInt(process.env.PER_USER_MAX_ATTEMPTS || '5', 10);
const PER_USER_LOCK_MS = parseInt(process.env.PER_USER_LOCK_MS || String(15 * 60 * 1000), 10); // default 15 minutes

function recordFailedLoginAttempt(id) {
    try {
        const now = Date.now();
        const rec = loginAttempts.get(id) || { count: 0, first: now, lockUntil: null };
        // reset first if window has passed (optional simple sliding window behaviour)
        if (rec.first && now - rec.first > PER_USER_LOCK_MS) {
            rec.count = 0;
            rec.first = now;
            rec.lockUntil = null;
        }
        rec.count = (rec.count || 0) + 1;
        if (rec.count >= PER_USER_MAX_ATTEMPTS) {
            rec.lockUntil = now + PER_USER_LOCK_MS;
        }
        loginAttempts.set(id, rec);
        return rec;
    } catch (e) {
        return null;
    }
}

function clearLoginAttempts(id) {
    try { loginAttempts.delete(id); } catch (e) { /* ignore */ }
}

// Blacklist (kept for reference but no automatic blocking is performed);
const BLACKLIST = (process.env.MESSAGE_BLACKLIST || 'badword1,badword2,slur').split(',').map(s => s.trim()).filter(Boolean);

function normalizeForMatch(text) {
    if (!text) return '';
    // Normalize unicode, remove diacritics, lowercase
    let s = String(text).normalize('NFKD').replace(/\p{Diacritic}/gu, '');
    s = s.toLowerCase();
    // replace non-alphanumeric with spaces
    s = s.replace(/[^a-z0-9]+/g, ' ');
    s = s.replace(/\s+/g, ' ').trim();
    return s;
}

// =====================================================
// MESSAGE ENRICHMENT UTILITIES
// =====================================================

/**
 * Enrich messages with reply metadata (author info)
 * Batch fetches all reply targets to avoid N+1 queries
 */
async function enrichMessagesWithReplyMeta(messages) {
    if (!messages || !messages.length) return messages;
    
    const replyIds = messages.map(m => m.reply_to).filter(Boolean);
    if (replyIds.length === 0) return messages;
    
    try {
        const { data: replies } = await supabaseAdmin
            .from('messages')
            .select('id, message, user_id, username')
            .in('id', replyIds);
        
        if (!replies || !replies.length) return messages;
        
        const replyMap = replies.reduce((acc, r) => {
            acc[r.id] = r;
            return acc;
        }, {});
        
        messages.forEach(m => {
            if (m.reply_to && replyMap[m.reply_to]) {
                m.reply_to_meta = replyMap[m.reply_to];
            }
        });
    } catch (e) {
        console.warn('Failed to enrich reply metadata:', e.message || e);
    }
    
    return messages;
}

// Improve matching to catch evasions like spacing or simple leet substitutions
function leetNormalize(s) {
    if (!s) return s;
    return s
        .replace(/[@4]/g, 'a')
        .replace(/[3]/g, 'e')
        .replace(/[1!|]/g, 'i')
        .replace(/[0]/g, 'o')
        .replace(/[5$]/g, 's')
        .replace(/[7]/g, 't')
        .replace(/[8]/g, 'b');
}

function hasBlacklistedWord(text) {
    if (!text) return false;
    // Limit input length to prevent ReDoS attacks
    const safeText = typeof text === 'string' ? text.slice(0, 2000) : '';
    const norm = normalizeForMatch(safeText);
    if (!norm) return false;

    // compact form without spaces (catches "g a g o" -> "gago")
    const compact = norm.replace(/\s+/g, '');
    // leet-normalized compact (catches "g4g0" -> "gago")
    const leetCompact = leetNormalize(compact);

    for (const raw of BLACKLIST) {
        if (!raw) continue;
        const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        // word-boundary match against the spaced-normalized text (default behavior)
        const re = new RegExp('\\b' + esc + '\\b', 'i');
        if (re.test(norm)) return true;
        // substring match against compact forms to catch spaced/obfuscated inputs
        if (compact.includes(raw.toLowerCase())) return true;
        if (leetCompact.includes(raw.toLowerCase())) return true;
    }
    return false;
}

// NOTE: Per-user client-side/browser or server-side automatic muting has been
// removed. Moderation is performed by admins via reports. The blacklist is
// retained as reference for moderators but messages are no longer blocked
// or muted automatically.

// Database-backed warning/mute helpers (authoritative). Use supabaseAdmin
// to persist per-user moderation state so it's consistent across instances.
// DB-backed warning/mute helpers removed — moderation is via admin reports now.

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Session configuration
// Session configuration
let sessionStore = null;
// Shared Pool instance for session store to avoid creating multiple Pools
// which can exhaust PgBouncer "session" mode client slots.
let sessionPool = null;

function createSessionPool() {
    if (sessionPool) return sessionPool;
    const sessionPoolMax = parseInt(process.env.SESSION_DB_POOL_MAX || '1', 10);
    sessionPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        // allow self-signed / default in dev; in production ensure proper SSL
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: sessionPoolMax,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    return sessionPool;
}

// Safe session-pool query runner with exponential backoff. This avoids
// immediately failing when PgBouncer in "session" mode denies new clients
// due to upstream pool_size limits. The helper will retry a few times with
// backoff and log if ultimately unsuccessful. Calls are fire-and-forget so
// they don't block request handling.
function runSessionPoolQueryAsync(sql, params = [], attempt = 0) {
    const maxAttempts = 6;
    const baseDelay = 250; // ms

    (async function tryOnce(attemptNum) {
        try {
            if (!sessionPool) throw new Error('no-session-pool');

            const max = (sessionPool && sessionPool.options && sessionPool.options.max) ? sessionPool.options.max : 1;
            const total = typeof sessionPool.totalCount === 'number' ? sessionPool.totalCount : 0;
            const idle = typeof sessionPool.idleCount === 'number' ? sessionPool.idleCount : 0;

            // If all clients are used and none idle, delay and retry rather than
            // calling pool.query immediately which would trigger MaxClientsInSessionMode.
            if (total >= max && idle === 0) {
                if (attemptNum >= maxAttempts) {
                    console.warn('Session pool appears saturated; aborting query after retries');
                    return;
                }
                const delay = Math.min(baseDelay * Math.pow(2, attemptNum), 30000);
                setTimeout(() => tryOnce(attemptNum + 1), delay);
                return;
            }

            await sessionPool.query(sql, params);
            // success
            return;
        } catch (err) {
            // If the error is from MaxClientsInSessionMode, retry with backoff.
            const isPoolErr = err && (String(err.message).includes('MaxClientsInSessionMode') || String(err.code) === 'XX000');
            if (isPoolErr && attempt < maxAttempts) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), 30000);
                setTimeout(() => tryOnce(attempt + 1), delay);
                return;
            }
            // Log and give up
            console.warn('Session pool query failed and will not be retried:', err && err.message ? err.message : err);
            return;
        }
    })(attempt);
}

// Optional diagnostics endpoint to inspect the session pool state. Enable by
// setting ENABLE_POOL_DIAGNOSTICS=true in the environment. This helps debug
// PgBouncer "session" mode client exhaustion by reporting pool counts.
if (process.env.ENABLE_POOL_DIAGNOSTICS === 'true') {
    app.get('/api/_session_pool', (req, res) => {
        try {
            if (!sessionPool) return res.json({ ok: false, message: 'no sessionPool' });
            const info = {
                max: sessionPool.options && sessionPool.options.max,
                totalCount: sessionPool.totalCount || 0,
                idleCount: sessionPool.idleCount || 0,
                waitingCount: sessionPool.waitingCount || 0
            };
            res.json({ ok: true, pool: info });
        } catch (e) {
            res.status(500).json({ ok: false, error: String(e) });
        }
    });
}

// Migrate in-memory fallback sessions to Postgres session table to avoid
// users being logged out when we swap stores at runtime.
async function migrateFallbackSessionsToPg(pool) {
    try {
        if (!pool) return;
        if (!(fallbackStore instanceof LightweightFallbackStore)) return;
        const entries = Array.from(fallbackStore.sessions.entries());
        if (!entries.length) return;

        console.info(`Migrating ${entries.length} in-memory sessions to Postgres session table`);
        for (const [sid, sess] of entries) {
            try {
                const sessJson = JSON.stringify(sess || {});
                const expireDate = (sess && sess.cookie && sess.cookie.expires) ? new Date(sess.cookie.expires) : new Date(Date.now() + (sessionOptions && sessionOptions.cookie && sessionOptions.cookie.maxAge ? sessionOptions.cookie.maxAge : 24 * 60 * 60 * 1000));
                runSessionPoolQueryAsync(
                    `INSERT INTO session (sid, sess, expire) VALUES ($1, $2::json, $3::timestamptz)
                     ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
                    [sid, sessJson, expireDate.toISOString()]
                );
            } catch (err) {
                console.warn('Failed to migrate session', sid, err && err.message ? err.message : err);
            }
        }

        // Clear in-memory store once migrated to avoid double-writes and free memory
        try { fallbackStore.sessions.clear(); } catch (e) { /* ignore */ }
    } catch (err) {
        console.warn('Session migration error:', err && err.message ? err.message : err);
    }
}

if (process.env.DATABASE_URL) {
    try {
        const PgSession = connectPgSimple(session);
        const pool = createSessionPool();

        // Test DB connectivity at startup. If the DB is unreachable (network timeout,
        // credentials wrong, etc.), avoid using the Postgres-backed session store so
        // runtime requests don't fail with PG connection timeouts.
        try {
            // Short timeout for startup check
            await withTimeout(pool.query('SELECT 1'), 3000);
            // Ensure the session table exists. If it doesn't, create it so
            // `connect-pg-simple` can operate without manual migrations.
            try {
                await pool.query(`CREATE TABLE IF NOT EXISTS session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL)`);
                await pool.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);
                // Ensure a unique index on sid so ON CONFLICT (sid) works as expected
                try {
                    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS IDX_session_sid_unique ON session (sid)`);
                } catch (uniqErr) {
                    console.warn('Warning: could not create unique index on session.sid:', uniqErr && uniqErr.message ? uniqErr.message : uniqErr);
                }
            } catch (tableErr) {
                console.warn('Warning: could not ensure session table exists:', tableErr && tableErr.message ? tableErr.message : tableErr);
            }

            sessionStore = new PgSession({ pool, tableName: 'session' });
            console.info(`Using Postgres session store via DATABASE_URL (pool max=${pool.options.max || 'default'})`);
        } catch (connErr) {
            const msg = connErr && connErr.message ? connErr.message : String(connErr);
            // If the failure is due to PgBouncer session-mode exhaustion, don't
            // immediately destroy the pool; keep it so background retries can
            // attempt to obtain a client when slots free up. Log at info level
            // to reduce noise but record the condition.
            if (String(msg).includes('MaxClientsInSessionMode') || String(connErr && connErr.code) === 'XX000') {
                console.info('Postgres session store temporarily unreachable (pool saturation). Using fallback store for now; scheduling retry. Details:', msg);
                sessionStore = null;
                // Keep sessionPool intact so retry logic can reuse it.
            } else {
                console.warn('Postgres session store unreachable at startup, falling back to in-memory store:', msg);
                sessionStore = null;
                // Ensure the shared pool is closed to avoid dangling timers
                try { if (sessionPool) { await sessionPool.end(); sessionPool = null; } } catch (e) { /* ignore */ }
            }
        }
    } catch (e) {
        console.warn('Failed to initialize Postgres session store, falling back to MemoryStore:', e && e.message ? e.message : e);
        sessionStore = null;
    }
} else {
    console.warn('DATABASE_URL not set — using in-memory session store (not suitable for production)');
}

// If Postgres session store couldn't be initialized at startup, avoid letting
// express-session fall back to its built-in MemoryStore which logs a noisy
// warning and is not intended for production. Provide a tiny custom store
// implementation that extends `session.Store` so behaviour remains correct
// but without the warning.
class LightweightFallbackStore extends session.Store {
    constructor() {
        super();
        this.sessions = new Map();
    }
    get(sid, callback) {
        try {
            const sess = this.sessions.get(sid) || null;
            return process.nextTick(() => callback(null, sess));
        } catch (err) {
            return process.nextTick(() => callback(err));
        }
    }
    set(sid, sess, callback) {
        try {
            this.sessions.set(sid, sess);
            return process.nextTick(() => callback && callback(null));
        } catch (err) {
            return process.nextTick(() => callback && callback(err));
        }
    }
    destroy(sid, callback) {
        try {
            this.sessions.delete(sid);
            return process.nextTick(() => callback && callback(null));
        } catch (err) {
            return process.nextTick(() => callback && callback(err));
        }
    }
    touch(sid, sess, callback) {
        // Update expiry-related metadata if used; for our simple Map store
        // we just replace the session object to reflect last access.
        return this.set(sid, sess, callback);
    }
}

const fallbackStore = sessionStore || new LightweightFallbackStore();

// Create the session middleware and keep a reference so we can swap the
// underlying store later if Postgres becomes available after startup.
const sessionOptions = {
    store: fallbackStore,
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        // Only enable cross-site cookie attributes when running in production
        // and a production origin is explicitly configured. This avoids
        // setting a cookie domain that prevents cookies from being stored
        // when running locally for development.
        secure: (process.env.NODE_ENV === 'production' && productionOrigin) ? true : false,
        httpOnly: true,
        sameSite: (process.env.NODE_ENV === 'production' && productionOrigin) ? 'none' : 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
};

// If running in production, allow an explicit COOKIE_DOMAIN to be set to
// control the cookie domain. We avoid deriving the domain from
// PRODUCTION_URL because the frontend host and API host can differ; using
// the backend's response host (no domain set) is safer by default.
try {
    if (process.env.NODE_ENV === 'production') {
        if (process.env.COOKIE_DOMAIN) {
            const cookieDomain = process.env.COOKIE_DOMAIN.replace(/\/$/, '');
            sessionOptions.cookie.domain = cookieDomain;
        }
        try { app.set('trust proxy', 1); } catch (e) { /* ignore */ }
    }
} catch (e) {
    console.warn('Failed to set session cookie domain from COOKIE_DOMAIN:', e && e.message ? e.message : e);
}

const sessionMiddleware = session(sessionOptions);
app.use(sessionMiddleware);

// Keep login activity records fresh without writing on every single request.
const _loginActivityBeat = new Map();
app.use((req, res, next) => {
    try {
        if (!req.session || !req.session.userId || !req.sessionID) return next();
        const sid = String(req.sessionID);
        const now = Date.now();
        const last = _loginActivityBeat.get(sid) || 0;
        if (now - last < 60 * 1000) return next(); // throttle to once per minute
        _loginActivityBeat.set(sid, now);

        const ip = _normalizeIpForDisplay(getClientIp(req));
        const userAgent = normalizeUserAgent(req.headers && req.headers['user-agent']);
        const deviceModel = getExactDeviceModel(req, userAgent);
        const geo = getIpLocationFromHeaders(req, ip);

        supabaseAdmin
            .from('user_login_activity')
            .update({
                last_seen_at: new Date().toISOString(),
                ip_address: ip,
                device_model: deviceModel || null,
                location_text: geo.locationText,
                country_code: geo.countryCode,
                user_agent: userAgent
            })
            .eq('user_id', req.session.userId)
            .eq('session_sid', sid)
            .is('revoked_at', null)
            .then(() => {})
            .catch(() => {});
    } catch (_) {
        // Non-fatal middleware; never block requests.
    }
    next();
});

// If we couldn't initialize the Postgres-backed session store at startup
// (network/DNS flakiness, transient DNS propagation, etc.), attempt to
// enable it in the background with exponential backoff. This allows the
// server to start promptly while still preferring the durable store when
// it becomes available later.
if (process.env.DATABASE_URL && !sessionStore) {
    (function schedulePgStoreRetry() {
        let attempt = 0;
        let delay = 5000; // start at 5s
        const maxDelay = 5 * 60 * 1000; // 5 minutes
        const maxAttempts = 10;

        const tryEnable = async () => {
            attempt += 1;
            try {
                const PgSession = connectPgSimple(session);
                const pool = createSessionPool();

                await withTimeout(pool.query('SELECT 1'), 5000);
                try {
                    await pool.query(`CREATE TABLE IF NOT EXISTS session (sid varchar NOT NULL, sess json NOT NULL, expire timestamp(6) NOT NULL)`);
                    await pool.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session (expire)`);
                    try {
                        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS IDX_session_sid_unique ON session (sid)`);
                    } catch (uniqErr) {
                        console.warn('Retry: could not create unique index on session.sid:', uniqErr && uniqErr.message ? uniqErr.message : uniqErr);
                    }
                } catch (tableErr) {
                    console.warn('Retry: could not ensure session table exists:', tableErr && tableErr.message ? tableErr.message : tableErr);
                }

                const pgStoreInstance = new PgSession({ pool, tableName: 'session' });

                // Migrate any in-memory sessions into Postgres so users don't get
                // unexpectedly logged out when we swap stores.
                try {
                    await migrateFallbackSessionsToPg(pool);
                } catch (e) {
                    console.warn('Session migration before swap failed:', e && e.message ? e.message : e);
                }

                // Swap stores on the session middleware so new requests use Postgres
                sessionMiddleware.store = pgStoreInstance;
                console.info(`Postgres session store enabled after retry (pool max=${(sessionPool && sessionPool.options && sessionPool.options.max) || 'default'})`);
                return;
            } catch (err) {
                console.warn(`Retry ${attempt}: Postgres session store still unreachable: ${err && err.message ? err.message : err}`);
                if (attempt < maxAttempts) {
                    delay = Math.min(delay * 2, maxDelay);
                    setTimeout(tryEnable, delay);
                } else {
                    console.warn('Exceeded max retries for Postgres session store; continuing with fallback store');
                }
            }
        };

        // Initial schedule
        setTimeout(tryEnable, delay);
    })();
}

// Serve a small built-in notification sound at /audio/notify.wav when no file exists.
// This provides a reliable fallback even if a static file isn't present.
// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Ensure ad crawlers can fetch ads.txt directly from site root.
app.get('/ads.txt', (req, res) => {
    res.type('text/plain');
    res.sendFile(path.join(__dirname, 'public', 'ads.txt'));
});

// Return the server-side Puter API token to authenticated users only.
// This is used by the client Puter.js instance to make requests on behalf
// of logged-in users. The token will not be returned to unauthenticated
// requests.
app.get('/puter-token', (req, res) => {
    try {
        if (!process.env.PUTER_API_TOKEN) return res.status(404).json({ error: 'Puter token not configured' });
        if (!req.session || !req.session.userId) return res.status(403).json({ error: 'Authentication required' });
        return res.json({ token: process.env.PUTER_API_TOKEN });
    } catch (err) {
        console.error('Failed to serve /puter-token:', err && err.message ? err.message : err);
        return res.status(500).json({ error: 'internal_error' });
    }
});

// Configure multer to keep file in memory for upload to Supabase storage
const memoryStorage = multer.memoryStorage();
const upload = multer({ storage: memoryStorage, limits: { fileSize: 2 * 1024 * 1024 } });

// =====================================================
// EMAIL / VERIFICATION (persistent)
// =====================================================
// Configure nodemailer transporter using SMTP env vars
let mailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
    // Allow opt-in for self-signed certificates in development via SMTP_ALLOW_SELF_SIGNED=true
    const tlsOptions = {
        minVersion: 'TLSv1.2',
        ciphers: 'HIGH:!aNULL:!MD5',
    };
    
    if (process.env.SMTP_ALLOW_SELF_SIGNED === 'true') {
        tlsOptions.rejectUnauthorized = false;
        console.warn('SMTP_ALLOW_SELF_SIGNED is enabled — the transporter will accept self-signed certificates (INSECURE, for testing only)');
    }

    mailTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
        },
        tls: tlsOptions,
        connectionTimeout: 10000, // 10 seconds
        greetingTimeout: 10000,
        socketTimeout: 10000,
        requireTLS: true,
        logger: false, // Set to true for debugging
        debug: false   // Set to true for detailed debugging
    });
} else {
    console.warn('SMTP not configured. Verification emails will fail until SMTP env vars are set.');
}

// Verify transporter early to provide clearer diagnostics
if (mailTransporter) {
    mailTransporter.verify().then(() => {
        console.info('SMTP transporter verified and ready to send messages');
    }).catch(err => {
        console.warn('SMTP transporter verification failed:', err && err.message ? err.message : err);
        console.debug(err && err.stack ? err.stack : err);
    });
}

// Reusable email sender and templates
function normalizeEmailAddress(value) {
    return String(value || '').trim().toLowerCase();
}

function extractEmailAddress(value) {
    const raw = normalizeEmailAddress(value);
    const match = raw.match(/<([^>]+)>/);
    return normalizeEmailAddress(match ? match[1] : raw);
}

async function hasDeliverableEmailDomain(email) {
    const address = extractEmailAddress(email);
    const atIndex = address.lastIndexOf('@');
    if (atIndex <= 0 || atIndex === address.length - 1) return false;

    const domain = address.slice(atIndex + 1);

    try {
        const mx = await dns.resolveMx(domain);
        if (Array.isArray(mx) && mx.length > 0) return true;
    } catch (_) {
        // Ignore and try A/AAAA fallback.
    }

    try {
        const a = await dns.resolve4(domain);
        if (Array.isArray(a) && a.length > 0) return true;
    } catch (_) {
        // Ignore and try AAAA fallback.
    }

    try {
        const aaaa = await dns.resolve6(domain);
        if (Array.isArray(aaaa) && aaaa.length > 0) return true;
    } catch (_) {
        // No deliverable DNS records found.
    }

    return false;
}

async function sendTemplatedEmail({ to, subject, template = 'default', variables = {}, skipDomainValidation = false }) {
        const from = process.env.SMTP_FROM || `no-reply@${process.env.DOMAIN || 'localhost'}`;
        const html = renderEmailTemplate(template, variables);
        const text = variables.plainText || (typeof variables.message === 'string' ? variables.message : subject || '');
        const normalizedTo = extractEmailAddress(to);

        if (!mailTransporter) {
                console.warn('No mail transporter configured; email not sent.');
                console.log('Email preview — to:', to, 'subject:', subject, 'html:', html);
                return { ok: false, info: 'no-transporter' };
        }

        const deliverableDomain = skipDomainValidation ? true : await hasDeliverableEmailDomain(normalizedTo);
        if (!deliverableDomain) {
                console.warn('Email domain has no deliverable DNS records:', normalizedTo);
                return { ok: false, info: 'invalid-email-domain' };
        }

        try {
                const info = await mailTransporter.sendMail({ from, to, subject, html, text });
                const accepted = Array.isArray(info?.accepted) ? info.accepted.map(extractEmailAddress).filter(Boolean) : [];
                const rejected = Array.isArray(info?.rejected) ? info.rejected.map(extractEmailAddress).filter(Boolean) : [];

                const explicitlyRejected = normalizedTo ? rejected.includes(normalizedTo) : rejected.length > 0;
                const explicitlyAccepted = normalizedTo ? accepted.includes(normalizedTo) : accepted.length > 0;

                if (!explicitlyAccepted || explicitlyRejected) {
                        console.warn('SMTP did not confirm recipient acceptance:', {
                                to: normalizedTo,
                                accepted,
                                rejected,
                                response: info?.response || 'n/a'
                        });
                        return { ok: false, info: 'recipient-not-accepted', smtp: { accepted, rejected, response: info?.response || '' } };
                }

                return { ok: true, info };
        } catch (err) {
                console.error('sendTemplatedEmail failed:', err && err.message ? err.message : err);
                console.debug(err && err.stack ? err.stack : err);
                return { ok: false, error: err };
        }
}

function renderEmailTemplate(name, vars) {
    // Minimal template system — extendable. Keep styling inline for email clients.
        if (name === 'verification') {
                const code = vars.code || '';
                const link = vars.link || '';
                const username = vars.username || '';
                const callToAction = link ? `<div style="margin:18px 0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:linear-gradient(90deg,#ff6b9d,#ff9eb4);color:#fff;font-weight:700;font-size:16px;text-decoration:none;">Verify your email</a></div>` : `<div style="margin:18px 0;text-align:center;"><span style="display:inline-block;padding:14px 22px;border-radius:8px;background:linear-gradient(90deg,#ff6b9d,#ff9eb4);color:#fff;font-weight:700;font-size:20px;letter-spacing:4px;">${escapeHtml(code)}</span></div>`;
                return `<!doctype html>
                <html>
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                </head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f8f6f8; margin:0; padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                        <tr>
                            <td align="center">
                                <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                    <tr>
                                        <td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">Thinky — Account Verification</td>
                                    </tr>
                                    <tr>
                                        <td style="padding:28px 36px;color:#333;text-align:left;">
                                            <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username) || 'there'},</p>
                                            <p style="margin:0 0 18px 0;color:#555;">Thanks for creating an account on Thinky. Click the button below to verify your email address. This link will expire in 24 hours.</p>
                                            ${callToAction}
                                            <p style="color:#888;font-size:13px;margin:18px 0 0 0;">If you didn't request this, you can safely ignore this email.</p>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    </table>
                </body>
                </html>`;
        }
        if (name === 'password_reset') {
                const link = vars.link || '';
                const username = vars.username || '';
                return `<!doctype html>
                <html>
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                </head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f8f6f8; margin:0; padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                        <tr>
                            <td align="center">
                                <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                    <tr>
                                        <td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">Thinky — Password Reset</td>
                                    </tr>
                                    <tr>
                                        <td style="padding:28px 36px;color:#333;text-align:left;">
                                            <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username) || 'there'},</p>
                                            <p style="margin:0 0 18px 0;color:#555;">You requested a password reset. Click the button below to set a new password. This link will expire in 1 hour.</p>
                                            <div style="margin:18px 0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 20px;border-radius:8px;background:linear-gradient(90deg,#ff6b9d,#ff9eb4);color:#fff;font-weight:700;font-size:16px;text-decoration:none;">Reset password</a></div>
                                            <p style="color:#888;font-size:13px;margin:18px 0 0 0;">If you didn't request this, you can safely ignore this email.</p>
                                        </td>
                                    </tr>
                                    <tr>
                                        <td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td>
                                    </tr>
                                </table>
                            </td>
                        </tr>
                    </table>
                </body>
                </html>`;
        }
        if (name === 'login_activity_code') {
                const username = vars.username || '';
                const code = vars.code || '';
                return `<!doctype html>
                <html>
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                </head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f8f6f8; margin:0; padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                        <tr><td align="center">
                            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                <tr><td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">Thinky — Login Activity Verification</td></tr>
                                <tr><td style="padding:28px 36px;color:#333;text-align:left;">
                                    <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username) || 'there'},</p>
                                    <p style="margin:0 0 14px 0;color:#555;">Enter the code below to access your login activity list. This code expires in 10 minutes.</p>
                                    <div style="margin:16px 0;text-align:center;"><span style="display:inline-block;padding:14px 22px;border-radius:8px;background:linear-gradient(90deg,#ff6b9d,#ff9eb4);color:#fff;font-weight:700;font-size:24px;letter-spacing:6px;">${escapeHtml(code)}</span></div>
                                    <p style="color:#888;font-size:13px;margin:18px 0 0 0;">If you didn't request this, you can ignore this email.</p>
                                </td></tr>
                                <tr><td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td></tr>
                            </table>
                        </td></tr>
                    </table>
                </body>
                </html>`;
        }
        if (name === 'new_device_login_alert') {
                const username = vars.username || '';
                const device = vars.device || 'Unknown device';
            const model = vars.model || 'Unknown';
                const ip = vars.ip || 'n/a';
            const location = vars.location || 'Unknown location';
                const time = vars.time || '';
                return `<!doctype html>
                <html>
                <head>
                    <meta charset="utf-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                </head>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background:#f8f6f8; margin:0; padding:0;">
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                        <tr><td align="center">
                            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                <tr><td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">New Login Detected</td></tr>
                                <tr><td style="padding:28px 36px;color:#333;text-align:left;">
                                    <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username) || 'there'},</p>
                                    <p style="margin:0 0 14px 0;color:#555;">We detected a login from a device we don't recognize.</p>
                                    <table style="width:100%;margin:12px 0;background:#fafafa;padding:12px;border-radius:6px;border:1px solid #eee;">
                                        <tr><td style="font-weight:600;width:160px;padding:6px 8px;">Device</td><td style="padding:6px 8px;">${escapeHtml(device)}</td></tr>
                                        <tr><td style="font-weight:600;padding:6px 8px;">Model</td><td style="padding:6px 8px;">${escapeHtml(model)}</td></tr>
                                        <tr><td style="font-weight:600;padding:6px 8px;">IP Address</td><td style="padding:6px 8px;">${escapeHtml(ip)}</td></tr>
                                        <tr><td style="font-weight:600;padding:6px 8px;">Location</td><td style="padding:6px 8px;">${escapeHtml(location)}</td></tr>
                                        <tr><td style="font-weight:600;padding:6px 8px;">Time</td><td style="padding:6px 8px;">${escapeHtml(time)}</td></tr>
                                    </table>
                                    <p style="margin:12px 0 0 0;color:#555;">If this wasn't you, open Settings → Security → Login Activity and sign out unfamiliar devices immediately.</p>
                                </td></tr>
                                <tr><td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td></tr>
                            </table>
                        </td></tr>
                    </table>
                </body>
                </html>`;
        }
                if (name === 'moderation_decision_reported') {
                            const decision = vars.decision || 'No action taken';
                            const reason = vars.reason || '';
                            const reportedUser = vars.reportedUser || '';
                            const reviewerTitle = vars.reviewerTitle || '';
                            const actionTakenAt = vars.actionTakenAt || '';
                        const supportEmail = process.env.SUPPORT_EMAIL || 'support@thinky.example';

                            return `<!doctype html>
                                <html>
                                <head>
                                    <meta charset="utf-8" />
                                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                                </head>
                                <body style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial; background:#f6f6f8; margin:0; padding:24px;">
                                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                        <tr>
                                            <td style="padding:20px 24px;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:18px;">Thinky Moderation Outcome</td>
                                        </tr>
                                        <tr>
                                            <td style="padding:20px 24px;color:#222;">
                                                <p style="margin:0 0 12px 0;">Hello ${escapeHtml(reportedUser) || ''},</p>
                                                <p style="margin:0 0 12px 0;color:#444;">Our moderation team has reviewed a report concerning content associated with your account.</p>
                                                <table style="width:100%;margin:12px 0;background:#fafafa;padding:12px;border-radius:6px;border:1px solid #eee;">
                                                    <tr><td style="font-weight:600;width:160px;padding:6px 8px;">Decision</td><td style="padding:6px 8px;">${escapeHtml(decision)}</td></tr>
                                                    ${reviewerTitle ? `<tr><td style="font-weight:600;padding:6px 8px;">Reviewer</td><td style="padding:6px 8px;">${escapeHtml(reviewerTitle)}</td></tr>` : ''}
                                                    ${reason ? `<tr><td style="font-weight:600;padding:6px 8px;">Reason</td><td style="padding:6px 8px;">${escapeHtml(reason)}</td></tr>` : ''}
                                                    ${actionTakenAt ? `<tr><td style="font-weight:600;padding:6px 8px;">Date</td><td style="padding:6px 8px;">${escapeHtml(actionTakenAt)}</td></tr>` : ''}
                                                </table>
                                                <p style="margin:12px 0 0 0;color:#444;">If action was taken, please review your content and our <a href="/terms">Community Guidelines</a>. If you believe this decision is incorrect, you may reply to this email or contact our moderation team at <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>
                                                <p style="margin:18px 0 0 0;color:#888;font-size:13px;">Regards,<br/>Thinky Moderation Team</p>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding:12px 24px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky</td>
                                        </tr>
                                    </table>
                                </body>
                                </html>`;
                }
                if (name === 'moderation_decision_reporter') {
                        const decision = vars.decision || 'No action taken';
                            const reason = vars.reason || '';
                            const contentType = vars.contentType || 'content';
                            const reviewerTitle = vars.reviewerTitle || '';
                            const actionTakenAt = vars.actionTakenAt || '';
                        const supportEmail = process.env.SUPPORT_EMAIL || 'support@thinky.example';

                        return `<!doctype html>
                                <html>
                                <head>
                                    <meta charset="utf-8" />
                                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                                </head>
                                <body style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial; background:#f6f6f8; margin:0; padding:24px;">
                                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                                        <tr>
                                            <td style="padding:20px 24px;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:18px;">Thank you — Report Reviewed</td>
                                        </tr>
                                        <tr>
                                            <td style="padding:20px 24px;color:#222;">
                                                <p style="margin:0 0 12px 0;">Hello,</p>
                                                <p style="margin:0 0 12px 0;color:#444;">Thank you for reporting ${escapeHtml(contentType)} on Thinky. Our moderation team has reviewed your report and taken appropriate action.</p>
                                                <table style="width:100%;margin:12px 0;background:#fafafa;padding:12px;border-radius:6px;border:1px solid #eee;">
                                                    <tr><td style="font-weight:600;width:160px;padding:6px 8px;">Action Taken</td><td style="padding:6px 8px;">${escapeHtml(decision)}</td></tr>
                                                    ${reviewerTitle ? `<tr><td style="font-weight:600;padding:6px 8px;">Content</td><td style="padding:6px 8px;">${escapeHtml(reviewerTitle)}</td></tr>` : ''}
                                                    ${actionTakenAt ? `<tr><td style="font-weight:600;padding:6px 8px;">Date</td><td style="padding:6px 8px;">${escapeHtml(actionTakenAt)}</td></tr>` : ''}
                                                </table>
                                                <p style="margin:12px 0 0 0;color:#444;">We take all reports seriously and review them according to our Community Guidelines. If you have additional information or concerns, you may reply to this email.</p>
                                                <p style="margin:18px 0 0 0;color:#888;font-size:13px;">Thank you for helping keep Thinky safe.<br/><br/>Regards,<br/>Thinky Moderation Team</p>
                                            </td>
                                        </tr>
                                        <tr>
                                            <td style="padding:12px 24px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky</td>
                                        </tr>
                                    </table>
                                </body>
                                </html>`;
                }
        if (name === 'school_request_approved') {
            const { username = '', schoolName = '', adminNote = '' } = vars;
            return `<!doctype html>
            <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8f6f8;margin:0;padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                    <tr><td align="center">
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                            <tr><td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">School Request Approved</td></tr>
                            <tr><td style="padding:28px 36px;color:#333;">
                                <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username)},</p>
                                <p style="margin:0 0 12px 0;color:#555;">Great news! Your request to add <strong>${escapeHtml(schoolName)}</strong> has been <strong style="color:#28a745;">approved</strong> and is now available in the school list.</p>
                                ${adminNote ? `<p style="margin:12px 0;padding:12px;background:#f0fff4;border-left:4px solid #28a745;border-radius:4px;color:#333;"><strong>Admin note:</strong> ${escapeHtml(adminNote)}</p>` : ''}
                                <p style="margin:12px 0 0 0;color:#555;">You can now select it when creating a new subject.</p>
                            </td></tr>
                            <tr><td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td></tr>
                        </table>
                    </td></tr>
                </table>
            </body></html>`;
        }
        if (name === 'school_request_rejected') {
            const { username = '', schoolName = '', adminNote = '' } = vars;
            return `<!doctype html>
            <html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
            <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;background:#f8f6f8;margin:0;padding:0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f6f8;padding:24px 0;">
                    <tr><td align="center">
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 8px 30px rgba(0,0,0,0.06);">
                            <tr><td style="padding:28px 36px;text-align:center;background:linear-gradient(90deg,#ff9eb4,#ffd4e0);color:#fff;font-weight:700;font-size:20px;">School Request Update</td></tr>
                            <tr><td style="padding:28px 36px;color:#333;">
                                <p style="margin:0 0 12px 0;font-size:16px;">Hi ${escapeHtml(username)},</p>
                                <p style="margin:0 0 12px 0;color:#555;">We reviewed your request to add <strong>${escapeHtml(schoolName)}</strong>, but it was <strong style="color:#dc3545;">not approved</strong> at this time.</p>
                                ${adminNote ? `<p style="margin:12px 0;padding:12px;background:#fff5f5;border-left:4px solid #dc3545;border-radius:4px;color:#333;"><strong>Admin note:</strong> ${escapeHtml(adminNote)}</p>` : ''}
                                <p style="margin:12px 0 0 0;color:#555;">If you believe this is a mistake, please contact the admin team.</p>
                            </td></tr>
                            <tr><td style="padding:18px 36px;background:#faf5f7;color:#999;font-size:12px;text-align:center;">© ${new Date().getFullYear()} Thinky — All rights reserved</td></tr>
                        </table>
                    </td></tr>
                </table>
            </body></html>`;
        }
        // default simple template
        return `<div style="font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial;">${escapeHtml(vars.message || subject || '')}</div>`;
}

function escapeHtml(str) {
        if (!str) return '';
        return String(str).replace(/[&<>"]+/g, function (s) {
                return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[s];
        });
}

function generateVerificationCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateVerificationToken() {
    return crypto.randomBytes(24).toString('hex');
}

function evaluatePasswordStrength(password) {
    if (!password || typeof password !== 'string') return 'weak';
    const length = password.length;
    const hasLower = /[a-z]/.test(password);
    const hasUpper = /[A-Z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSpecial = /[^a-zA-Z\d]/.test(password);

    const score = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (length >= 10 && score >= 3) return 'strong';
    if (length >= 8 && score >= 2) return 'medium';
    return 'weak';
}

async function storeVerificationCode(email, token, ttlMinutes = 15, userId = null) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    // Insert a record; we'll clean up expired rows via DB job or periodic script if desired
    const lcEmail = (email || '').toLowerCase();
    const payload = { email: lcEmail, token: String(token), expires_at: expiresAt };
    if (userId) payload.user_id = userId;

    // Remove any previous verification tokens for this email to keep only one active row
    try {
        await supabaseAdmin.from('email_verifications').delete().eq('email', lcEmail);
    } catch (delErr) {
        console.warn('Failed to cleanup old verification tokens for', lcEmail, delErr && delErr.message ? delErr.message : delErr);
    }

    const { data, error } = await supabaseAdmin
        .from('email_verifications')
        .insert([payload]);
    if (error) console.warn('Failed to store verification token in DB:', error.message || error);
    return data;
}

// Password reset helpers
async function storePasswordReset(email, token, ttlMinutes = 60, userId = null) {
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
    const lcEmail = (email || '').toLowerCase();
    const payload = { email: lcEmail, token: String(token), expires_at: expiresAt };
    if (userId) payload.user_id = userId;
    try {
        await supabaseAdmin.from('password_resets').delete().eq('email', lcEmail);
    } catch (err) {
        console.warn('Failed to cleanup old password_resets for', lcEmail, err && err.message ? err.message : err);
    }
    const { data, error } = await supabaseAdmin.from('password_resets').insert([payload]);
    if (error) console.warn('Failed to store password reset token in DB:', error.message || error);
    return data;
}

async function findActivePasswordResetByToken(token) {
    try {
        const now = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('password_resets')
            .select('*')
            .eq('token', String(token))
            .gt('expires_at', now)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('findActivePasswordResetByToken error:', error);
            return null;
        }
        if (!data || data.length === 0) return null;
        return data[0];
    } catch (e) {
        console.error('findActivePasswordResetByToken exception:', e);
        return null;
    }
}

async function verifyCode(email, token) {
    try {
        const now = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('email_verifications')
            .select('*')
            .eq('token', String(token))
            .gt('expires_at', now)
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.error('Error querying verification token:', error);
            return false;
        }

        if (!data || data.length === 0) return false;

        // Delete verification rows for this token to avoid reuse
        const { error: delErr } = await supabaseAdmin
            .from('email_verifications')
            .delete()
            .eq('token', String(token));
        if (delErr) console.warn('Failed to delete verification rows:', delErr.message || delErr);
        return true;
    } catch (e) {
        console.error('verifyCode error:', e);
        return false;
    }
}

// Find a verification row by token regardless of expiry
async function findVerificationByToken(token) {
    try {
        const { data, error } = await supabaseAdmin
            .from('email_verifications')
            .select('*')
            .eq('token', String(token))
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('findVerificationByToken error:', error);
            return null;
        }
        if (!data || data.length === 0) return null;
        return data[0];
    } catch (e) {
        console.error('findVerificationByToken exception:', e);
        return null;
    }
}

// Find an active (non-expired) verification row by email
async function findActiveVerificationByEmail(email) {
    try {
        const now = new Date().toISOString();
        const { data, error } = await supabaseAdmin
            .from('email_verifications')
            .select('*')
            .eq('email', String(email).toLowerCase())
            .gt('expires_at', now)
            .order('created_at', { ascending: false })
            .limit(1);
        if (error) {
            console.error('findActiveVerificationByEmail error:', error);
            return null;
        }
        if (!data || data.length === 0) return null;
        return data[0];
    } catch (e) {
        console.error('findActiveVerificationByEmail exception:', e);
        return null;
    }
}

// Serve a favicon from the existing logo to avoid browser 404 for /favicon.ico
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'images', 'logo.png'));
});

// =====================================================
// AUTHENTICATION MIDDLEWARE
// =====================================================

const requireAuth = async (req, res, next) => {
    // Debug: log session to help diagnose 401 issues
    console.debug('requireAuth session:', !!req.session, req.session ? { userId: req.session.userId } : null);
    // Delegate to the stronger check which also enforces bans
    return requireAuthWithBanCheck(req, res, next);
};

// Stronger auth check that also validates account bans on each request
async function requireAuthWithBanCheck(req, res, next) {
    try {
        if (!req.session || !req.session.userId) return res.status(401).json({ error: 'Authentication required' });

        let userQuery;
        try {
            userQuery = await withTimeout(supabaseAdmin.from('users').select('banned_until').eq('id', req.session.userId).single(), 8000);
        } catch (e) {
            console.error('Supabase timeout in ban check:', e && e.message ? e.message : e);
            return res.status(504).json({ error: 'Upstream timeout' });
        }
        const { data: user, error } = userQuery;
        if (!error && user && user.banned_until) {
            const until = new Date(user.banned_until);
            const now = new Date();
            if (!isNaN(until.getTime()) && until > now) {
                // destroy session
                req.session.destroy(() => {});
                const yearsDiff = until.getFullYear() - now.getFullYear();
                if (yearsDiff >= 50) return res.status(403).json({ error: 'Account permanently banned' });
                return res.status(403).json({ error: `Account banned until ${until.toISOString()}` });
            }
        }
        next();
    } catch (e) {
        console.error('requireAuthWithBanCheck error:', e);
        return res.status(500).json({ error: 'Server error' });
    }
}

// Debug: return the last inserted message (requires auth)
app.get('/api/_last_message', requireAuth, async (req, res) => {
    try {
        const { data: messages, error } = await supabaseAdmin
            .from('messages')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(1);

        if (error) {
            console.error('Debug _last_message error:', error);
            return res.status(500).json({ error: 'Failed to fetch last message' });
        }

        return res.json({ message: (messages && messages[0]) ? messages[0] : null });
    } catch (err) {
        console.error('Debug _last_message unexpected error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Simple UUIDv4 generator for flashcard ids when not provided
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

const requireAdmin = async (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', req.session.userId)
            .single();

        if (error || !user || user.role !== 'admin') {
            return res.status(403).json({ error: 'Admin access required' });
        }

        next();
    } catch (error) {
        console.error('Admin middleware error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

const requireModerator = async (req, res, next) => {
    if (!req.session.userId) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('role')
            .eq('id', req.session.userId)
            .single();

        if (error || !user || (user.role !== 'moderator' && user.role !== 'admin')) {
            return res.status(403).json({ error: 'Moderator access required' });
        }

        next();
    } catch (error) {
        console.error('Moderator middleware error:', error);
        res.status(500).json({ error: 'Server error' });
    }
};

// =====================================================
// AUTHENTICATION ROUTES
// =====================================================

// Register
app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        let { email, username, password } = req.body;
        const lcEmail = (email || '').toLowerCase();

        // Validation
        if (!email || !username || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters' });
        }

        // Validate email format before querying
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(lcEmail)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }
        // Validate username (alphanumeric + underscore, 3-50 chars)
        const usernameRegex = /^[a-zA-Z0-9_]{3,50}$/;
        if (!usernameRegex.test(username)) {
            return res.status(400).json({ error: 'Username must be 3-50 alphanumeric characters or underscores' });
        }

        // Check if user exists - use separate queries to avoid string interpolation
        const [emailCheck, usernameCheck] = await Promise.all([
            supabaseAdmin.from('users').select('id, is_verified').eq('email', lcEmail).maybeSingle(),
            supabaseAdmin.from('users').select('id, is_verified').eq('username', username).maybeSingle()
        ]);
        const existingErr = emailCheck.error || usernameCheck.error;
        const existingUser = emailCheck.data || usernameCheck.data;

        if (existingErr) {
            console.error('Error checking existing user:', existingErr);
            return res.status(500).json({ error: 'Server error' });
        }

        // Enforce server-side password strength
        const strength = evaluatePasswordStrength(password);
        if (strength === 'weak') {
            return res.status(400).json({ error: 'Password is too weak. Use a longer password with numbers and symbols.' });
        }

        // Hash password
        const passwordHash = await bcrypt.hash(password, 10);

        let createdUser = null;
        if (existingUser) {
            if (existingUser.is_verified) {
                return res.status(400).json({ error: 'Email or username already exists' });
            }
            // User exists but not verified: do not recreate; proceed to (re)send code
            createdUser = null;
        } else {
            // Create the unverified user record now
            const { data: newUser, error: insertErr } = await supabaseAdmin
                .from('users')
                .insert([{ email: lcEmail, username, password_hash: passwordHash, is_verified: false }])
                .select()
                .maybeSingle();
            if (insertErr) {
                console.error('Failed to create user during registration:', insertErr);
                return res.status(500).json({ error: 'Registration failed' });
            }
            createdUser = newUser;
        }

        // Generate or reuse verification token (link-based verification)
        // Prefer reusing any existing active token; storeVerificationCode will ensure only one row exists per email
        const userId = (createdUser && createdUser.id) || (existingUser && existingUser.id) || null;
        const active = await findActiveVerificationByEmail(lcEmail);
        let token = active && active.token ? active.token : generateVerificationToken();
        if (!active) await storeVerificationCode(lcEmail, token, 60 * 24, userId); // 24 hours by default

        // Build verification link
        const base = process.env.BASE_URL || (`http://` + (req.headers.host || `localhost:${PORT}`));
        const verifyLink = `${base.replace(/\/$/, '')}/api/auth/verify?token=${encodeURIComponent(token)}`;

        // Send templated email with link
        const sent = await sendTemplatedEmail({ to: lcEmail, subject: 'Verify your Thinky account', template: 'verification', variables: { link: verifyLink, username } });
        if (!sent.ok) {
            // Email failed to send - delete the created user if it was newly created
            if (createdUser && createdUser.id) {
                try {
                    await supabaseAdmin.from('users').delete().eq('id', createdUser.id);
                    console.warn('Deleted unverified user due to email send failure:', createdUser.id);
                } catch (delErr) {
                    console.error('Failed to delete user after email send failure:', delErr);
                }

                try {
                    await supabaseAdmin.from('email_verifications').delete().eq('email', lcEmail);
                } catch (verDelErr) {
                    console.error('Failed to delete verification rows after email send failure:', verDelErr);
                }
            }
            console.warn('Verification email send failed for:', lcEmail, sent.error || sent.info);
            return res.status(400).json({ error: 'The email address provided is not valid or unable to receive emails. Please verify your email address and try again.' });
        }

        // Respond instructing client to verify via link
        res.json({ message: 'Verification link sent to email. Click the link to verify your account.' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});
// Old code-based verification endpoint removed in favor of link-based verification.
app.post('/api/auth/register-verify', authLimiter, async (req, res) => {
    res.status(410).json({ error: 'Verification-by-code removed. Use the email verification link.' });
});

// Link-based verification endpoint
app.get('/api/auth/verify', async (req, res) => {
    try {
        const { token } = req.query;
        if (!token) return res.status(400).send('<h3>Invalid verification link.</h3>');

        const row = await findVerificationByToken(token);
        if (!row) {
            return res.status(400).send('<h3>Invalid or expired verification link.</h3><p>Please request a new verification email from your account page or during login.</p>');
        }

        const now = new Date();
        const expiresAt = new Date(row.expires_at);
        if (expiresAt < now) {
            // token expired: remove row and send a new token
            await supabaseAdmin.from('email_verifications').delete().eq('token', String(token));

            // find user and resend
            const email = row.email;
            const { data: user } = await supabaseAdmin.from('users').select('*').eq('email', email).maybeSingle();
            if (user && !user.is_verified) {
                const newToken = generateVerificationToken();
                await storeVerificationCode(email, newToken, 60 * 24, user.id);
                const base = process.env.BASE_URL || (`http://` + (req.headers.host || `localhost:${PORT}`));
                const verifyLink = `${base.replace(/\/$/, '')}/api/auth/verify?token=${encodeURIComponent(newToken)}`;
                await sendTemplatedEmail({ to: email, subject: 'Your new verification link', template: 'verification', variables: { link: verifyLink, username: user.username } });
                return res.send(renderVerificationPage({
                    title: 'Verification Link Expired',
                    message: 'A new verification link has been sent to your email.',
                    ctaText: 'Back to Home',
                    ctaHref: '/'
                }));
            }
            return res.send(renderVerificationPage({
                title: 'Verification Link Expired',
                message: 'Please request a new verification email from your account page or try resending during login.',
                ctaText: 'Request New Link',
                ctaHref: '/login'
            }));
        }

        // Valid token: mark user as verified
        const email = row.email;
        const { data: user } = await supabaseAdmin.from('users').select('*').eq('email', email).maybeSingle();
        if (!user) {
            return res.status(400).send('<h3>User not found.</h3>');
        }

            if (user.is_verified) {
                // already verified: cleanup token and redirect to dashboard
                await supabaseAdmin.from('email_verifications').delete().eq('token', String(token));
                req.session.userId = user.id;
                req.session.username = user.username;
                req.session.role = user.role;
                return res.redirect('/dashboard');
            }

        const { error: updErr } = await supabaseAdmin.from('users').update({ is_verified: true }).eq('id', user.id);
        if (updErr) {
            console.error('Failed to mark user verified via link:', updErr);
            return res.status(500).send('<h3>Verification failed due to server error.</h3>');
        }

        // Delete verification rows for token
        await supabaseAdmin.from('email_verifications').delete().eq('token', String(token));

        // Log new registration to Discord registration webhook
        const userLink = `[${user.username}](${(process.env.PRODUCTION_URL || process.env.BASE_URL || '').replace(/\/$/, '')}/user?id=${user.id})`;
        _registrationDiscord('🆕 New User Registered', [
            ['Username', userLink],
            ['Email', user.email],
            ['Time (UTC)', new Date().toISOString()]
        ]);

        // Create a session and redirect to dashboard with verified flag
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;

        return res.redirect('/dashboard?verified=1');
    } catch (e) {
        console.error('Verification link error:', e);
                return res.status(500).send(renderVerificationPage({
                        title: 'Server Error',
                        message: 'An unexpected error occurred while verifying your account. Please try again later.',
                        ctaText: 'Home',
                        ctaHref: '/'
                }));
    }
});

// Helper: render a small responsive verification/status page
function renderVerificationPage({ title = 'Notice', message = '', ctaText = 'Home', ctaHref = '/' }) {
        const safeTitle = escapeHtml(title);
        const safeMessage = escapeHtml(message);
        const safeCtaText = escapeHtml(ctaText);
        const safeCtaHref = escapeHtml(ctaHref);

        return `<!doctype html>
        <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>${safeTitle} — Thinky</title>
            <style>
                :root{--bg:#f7f6fb;--card:#ffffff;--accent:#ff6b9d;--muted:#6b6b6b}
                html,body{height:100%;margin:0;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,'Helvetica Neue',Arial}
                body{display:flex;align-items:center;justify-content:center;background:linear-gradient(180deg,var(--bg),#ffffff)}
                .card{max-width:720px;width:92%;background:var(--card);border-radius:12px;box-shadow:0 10px 30px rgba(13,38,59,0.08);padding:32px;display:flex;gap:24px;align-items:center}
                .left{flex:0 0 96px;height:96px;border-radius:12px;background:linear-gradient(135deg,var(--accent),#ff9eb4);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:28px}
                .body{flex:1}
                h1{margin:0 0 8px 0;font-size:20px;color:#0f1724}
                p{margin:0 0 16px 0;color:var(--muted);line-height:1.4}
                .actions{display:flex;gap:12px;flex-wrap:wrap}
                .btn{display:inline-block;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600}
                .btn-primary{background:linear-gradient(90deg,var(--accent),#ff9eb4);color:#fff}
                .btn-ghost{background:transparent;border:1px solid #eee;color:var(--muted)}
                @media (max-width:520px){.card{flex-direction:column;align-items:stretch;padding:20px}.left{width:64px;height:64px;font-size:20px}.body h1{font-size:18px}}
            </style>
        </head>
        <body>
            <div class="card" role="main">
                <div class="left">✓</div>
                <div class="body">
                    <h1>${safeTitle}</h1>
                    <p>${safeMessage}</p>
                    <div class="actions">
                        <a class="btn btn-primary" href="${safeCtaHref}">${safeCtaText}</a>
                        <a class="btn btn-ghost" href="/login">Log in</a>
                    </div>
                </div>
            </div>
        </body>
        </html>`;
}

// Resend verification (POST) for users who didn't receive or whose link expired
app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const { data: user } = await supabaseAdmin.from('users').select('*').eq('email', String(email).toLowerCase()).maybeSingle();
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.is_verified) return res.status(400).json({ error: 'Account already verified' });

        // Reuse an existing active token where possible to avoid token spam
        const existing = await findActiveVerificationByEmail(email);
        let tokenToSend;
        if (existing && existing.token) {
            tokenToSend = existing.token;
        } else {
            tokenToSend = generateVerificationToken();
            await storeVerificationCode(email, tokenToSend, 60 * 24, user.id);
        }

        const base = process.env.BASE_URL || (`http://` + (req.headers.host || `localhost:${PORT}`));
        const verifyLink = `${base.replace(/\/$/, '')}/api/auth/verify?token=${encodeURIComponent(tokenToSend)}`;
        const sent = await sendTemplatedEmail({ to: email, subject: 'Your verification link', template: 'verification', variables: { link: verifyLink, username: user.username } });
        if (!sent.ok) {
            console.warn('Resend attempted but email send failed', sent.error || sent.info);
            // Still return success-ish so client shows resend UI, but inform operator via logs
            return res.status(202).json({ message: 'Verification link stored but failed to send email.' });
        }
        return res.json({ message: 'Verification email resent' });
    } catch (e) {
        console.error('Resend verification error:', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Forgot password - request reset link
app.post('/api/auth/forgot-password', passwordResetLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Email required' });

        const lcEmail = String(email).toLowerCase();
        const { data: user } = await supabaseAdmin.from('users').select('*').eq('email', lcEmail).maybeSingle();

        // Always return 200 to avoid user enumeration
        if (!user) {
            return res.json({ message: 'If an account exists, a reset link has been sent to that email.' });
        }

        // Create a reset token
        const token = generateVerificationToken();
        await storePasswordReset(lcEmail, token, 60, user.id);

        const base = process.env.BASE_URL || (`http://` + (req.headers.host || `localhost:${PORT}`));
        const resetLink = `${base.replace(/\/$/, '')}/auth/reset.html?token=${encodeURIComponent(token)}`;

        const sent = await sendTemplatedEmail({ to: lcEmail, subject: 'Reset your Thinky password', template: 'password_reset', variables: { link: resetLink, username: user.username } });
        if (!sent.ok) {
            console.warn('Password reset stored but email send failed', sent.error || sent.info);
            return res.status(202).json({ message: 'If an account exists, a reset link has been stored. Email delivery failed.' });
        }

        return res.json({ message: 'If an account exists, a reset link has been sent to that email.' });
    } catch (e) {
        console.error('Forgot password error:', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Reset password endpoint (POST) - accepts { token, password }
app.post('/api/auth/reset', authLimiter, async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Token and new password required' });

        const row = await findActivePasswordResetByToken(token);
        if (!row) return res.status(400).json({ error: 'Invalid or expired reset token' });

        // Find user
        const { data: user } = await supabaseAdmin.from('users').select('*').eq('email', row.email).maybeSingle();
        if (!user) return res.status(400).json({ error: 'User not found' });

        // Validate password strength
        if (evaluatePasswordStrength(password) === 'weak') return res.status(400).json({ error: 'Password is too weak' });

        const hash = await bcrypt.hash(password, 10);
        const { error: updErr } = await supabaseAdmin.from('users').update({ password_hash: hash }).eq('id', user.id);
        if (updErr) {
            console.error('Failed to update password:', updErr);
            return res.status(500).json({ error: 'Failed to reset password' });
        }

        // remove reset rows for this email
        await supabaseAdmin.from('password_resets').delete().eq('email', row.email);

        return res.json({ message: 'Password has been reset successfully' });
    } catch (e) {
        console.error('Password reset error:', e);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Send email verification code for 2FA
async function sendEmail2FACode(userId, email, code) {
    if (!mailTransporter) {
        console.warn('No mail transporter configured; 2FA email not sent.');
        return false;
    }

    try {
        await mailTransporter.sendMail({
            from: process.env.SMTP_FROM || 'noreply@thinky.app',
            to: email,
            subject: 'Your Thinky Login Verification Code',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                    <h2 style="color: #ff9eb4;">Thinky Login Verification</h2>
                    <p>Your verification code is:</p>
                    <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #333;">
                        ${code}
                    </div>
                    <p style="color: #666; margin-top: 20px;">This code will expire in 10 minutes.</p>
                    <p style="color: #666;">If you didn't request this code, please ignore this email.</p>
                </div>
            `,
            text: `Your Thinky verification code is: ${code}\n\nThis code will expire in 10 minutes.`
        });
        return true;
    } catch (error) {
        console.error('Failed to send 2FA email:', error);
        return false;
    }
}

// Login
app.post('/api/auth/login', authLimiter, async (req, res) => {
    console.info('[req] POST /api/auth/login from', req.ip, 'headers:', { origin: req.get('origin') });
    try {
        const { email, password } = req.body;

        // Validation
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password are required' });
        }

        // Per-user cooldown check
        const ident = String(email).toLowerCase();
        const attemptRec = loginAttempts.get(ident);
        if (attemptRec && attemptRec.lockUntil && Date.now() < attemptRec.lockUntil) {
            const retrySecs = Math.ceil((attemptRec.lockUntil - Date.now()) / 1000);
            const retryMins = Math.ceil(retrySecs / 60);
            return res.status(429).json({ error: `Too many login attempts. Try again in ${retryMins} minute(s).` });
        }

        // Get user
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('email', email)
            .single();

        if (error || !user) {
            // Record failed attempt to slow down brute-force/guessing even when user not found
            recordFailedLoginAttempt(ident);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Prevent login if account not verified
        if (!user.is_verified) {
            return res.status(403).json({ error: 'Account not verified. Check your email for the verification link.' });
        }

        // Verify password
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword) {
            recordFailedLoginAttempt(ident);
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        // Successful login — clear any recorded failed attempts for this identifier
        clearLoginAttempts(ident);

        // Prevent login if user is banned (banned_until in the future)
        try {
            if (user.banned_until) {
                const until = new Date(user.banned_until);
                const now = new Date();
                if (!isNaN(until.getTime()) && until > now) {
                    const yearsDiff = until.getFullYear() - now.getFullYear();
                    if (yearsDiff >= 50) {
                        return res.status(403).json({ error: 'Your account has been permanently banned and cannot log in.' });
                    }
                    return res.status(403).json({ error: `Your account is banned until ${until.toLocaleString()}.`, banned_until: user.banned_until, banned_until_readable: until.toLocaleString() });
                }
            }
        } catch (e) {
            console.warn('Error checking banned_until during login:', e);
        }

        // Check if 2FA is enabled
        const requires2FA = user.two_factor_enabled || user.email_2fa_enabled;
        
        if (requires2FA) {
            // Store userId in session temporarily for 2FA verification
            req.session.pending2FAUserId = user.id;
            
            // If email 2FA is enabled AND Google/TOTP 2FA is NOT enabled, send the code
                // Prefer Google/TOTP when both methods are enabled so we do not send unnecessary email codes.
                if (user.email_2fa_enabled && !user.two_factor_enabled) {
                // Cleanup old codes for this user: remove used or expired rows to keep table clean
                try {
                    const nowIso = new Date().toISOString();
                    try {
                        await supabaseAdmin
                            .from('email_2fa_codes')
                            .delete()
                            .eq('user_id', user.id)
                            .eq('used', true);
                    } catch (delUsedErr) {
                        console.warn('Failed to delete used email_2fa_codes rows during cleanup:', delUsedErr);
                    }
                    try {
                        await supabaseAdmin
                            .from('email_2fa_codes')
                            .delete()
                            .eq('user_id', user.id)
                            .lt('expires_at', nowIso);
                    } catch (delExpiredErr) {
                        console.warn('Failed to delete expired email_2fa_codes rows during cleanup:', delExpiredErr);
                    }
                } catch (e) {
                    console.warn('Exception during email_2fa_codes cleanup:', e);
                }

                // Check for an existing unused, unexpired code to prevent multiple active codes
                let code = null;
                try {
                    const nowIso = new Date().toISOString();
                    const { data: existingCodes, error: selErr } = await supabaseAdmin
                        .from('email_2fa_codes')
                        .select('*')
                        .eq('user_id', user.id)
                        .eq('used', false)
                        .gt('expires_at', nowIso)
                        .limit(1);

                    if (selErr) {
                        console.error('Failed to query existing email_2fa_codes:', selErr);
                    }

                    if (existingCodes && existingCodes.length > 0 && existingCodes[0].code) {
                        // Reuse the existing unexpired code instead of creating a new one
                        code = existingCodes[0].code;
                        console.info('Reusing existing email 2FA code for user', user.id);
                    }
                } catch (e) {
                    console.error('Exception checking existing email_2fa_codes:', e);
                }

                // If no existing code, generate and store a new one
                if (!code) {
                    code = Math.floor(100000 + Math.random() * 900000).toString();
                    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

                    try {
                        const { data: insertData, error: insertErr } = await supabaseAdmin
                            .from('email_2fa_codes')
                            .insert({
                                user_id: user.id,
                                code: code,
                                expires_at: expiresAt.toISOString()
                            });

                        if (insertErr) {
                            console.error('Failed to insert email_2fa_codes row:', insertErr);
                        } else {
                            console.info('Inserted email_2fa_codes row:', insertData && insertData[0] ? insertData[0] : insertData);
                        }
                    } catch (e) {
                        console.error('Exception inserting email_2fa_codes:', e);
                    }
                }

                // Send email with the (possibly reused) code
                const sent = await sendEmail2FACode(user.id, user.email, code);
                if (!sent) console.warn('Email 2FA sendEmail2FACode reported failure for user', user.id);
            }
            
            // Build a user-friendly message depending on which method is preferred
            let message = '';
            if (user.two_factor_enabled) {
                message = 'Please enter your authenticator code';
            } else if (user.email_2fa_enabled) {
                message = 'Verification code sent to your email';
            }

            return res.json({
                requires2FA: true,
                userId: user.id,
                methods: {
                    google: user.two_factor_enabled,
                    email: user.email_2fa_enabled
                },
                message
            });
        }

        // Set session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;

        // Ensure the session is saved to the store before doing follow-up work.
        try {
            await new Promise((resolve) => {
                try {
                    req.session.save((err) => {
                        if (err) console.warn('Session save error during login:', err && err.message ? err.message : err);
                        else console.info('Session saved during login, sid=', req.sessionID);
                        resolve();
                    });
                } catch (e) {
                    console.warn('Unexpected error while saving session:', e && e.message ? e.message : e);
                    resolve();
                }
            });
        } catch (e) {
            console.warn('Session save promise error:', e && e.message ? e.message : e);
        }

        // Multi-device login is allowed. Track this login so users can review
        // and revoke unfamiliar sessions from Settings.
        await trackLoginActivityAndNotify(req, user);

        // If client is on localhost over plain HTTP, ensure the session cookie
        // is not marked `secure` (otherwise the browser won't store it). This
        // handles the common case where NODE_ENV=production is set locally.
        try {
            const hostHeader = (req.headers && req.headers.host) ? req.headers.host : '';
            const originHeader = (req.headers && req.headers.origin) ? req.headers.origin : '';
            const isLocalhostHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(hostHeader);
            const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHeader);
            if (isLocalhostHost || isLocalhostOrigin) {
                req.session.cookie.secure = false;
                console.info('Login from localhost detected — setting session cookie secure=false for this session');
            }
        } catch (e) {
            // non-fatal
        }

        // Update online status (use admin client to bypass RLS for server-side writes)
        await supabaseAdmin
            .from('online_users')
            .upsert({
                user_id: user.id,
                username: user.username,
                last_seen: new Date().toISOString()
            });

        // Log login event to Discord login webhook
        const userLink = `[${user.username}](${(process.env.PRODUCTION_URL || process.env.BASE_URL || '').replace(/\/$/, '')}/user?id=${user.id})`;
        _activityDiscord('✅ User Logged In', [
            ['Username', userLink],
            ['Email', user.email],
            ['Role', user.role],
            ['IP', req.ip || 'n/a'],
            ['User-Agent', req.headers['user-agent'] || 'n/a'],
            ['Time (UTC)', new Date().toISOString()]
        ]);

        res.json({
            message: 'Login successful',
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                role: user.role
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
    try {
        const currentSid = req.sessionID ? String(req.sessionID) : null;

        // Remove from online users (use admin client server-side)
        await supabaseAdmin
            .from('online_users')
            .delete()
            .eq('user_id', req.session.userId);

        if (currentSid) {
            await supabaseAdmin
                .from('user_login_activity')
                .update({ revoked_at: new Date().toISOString() })
                .eq('user_id', req.session.userId)
                .eq('session_sid', currentSid)
                .is('revoked_at', null);
        }

        req.session.destroy((err) => {
            if (err) {
                console.error('Logout error:', err);
                return res.status(500).json({ error: 'Logout failed' });
            }
            res.json({ message: 'Logout successful' });
        });
    } catch (error) {
        console.error('Logout error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get current user
app.get('/api/auth/me', requireAuth, async (req, res) => {
    try {
        let meQuery;
        try {
            meQuery = await withTimeout(
                supabase
                    .from('users')
                    .select('id, email, username, role, display_name, profile_picture_url, created_at, is_dev, follower_count, following_count')
                    .eq('id', req.session.userId)
                    .single(),
                8000
            );
        } catch (e) {
            console.error('Supabase timeout fetching /api/auth/me:', e && e.message ? e.message : e);
            return res.status(504).json({ error: 'Upstream timeout' });
        }

        const { data: user, error } = meQuery;
        if (error || !user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// SUBJECT ROUTES
// =====================================================

// Get all subjects for current user
app.get('/api/subjects', requireAuth, cacheResponse({ namespace: 'subjects:user', includeUser: true, ttlSeconds: 120 }), async (req, res) => {
    try {
        const { data: subjects, error } = await supabase
            .from('subjects')
            .select('*')
            .eq('user_id', req.session.userId)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Get subjects error:', error);
            return res.status(500).json({ error: 'Failed to fetch subjects' });
        }

        res.json({ subjects });
    } catch (error) {
        console.error('Get subjects error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get verified schools (admin-provided). If table doesn't exist, return empty list.
app.get('/api/schools', requireAuth, cacheResponse({ namespace: 'schools:list', ttlSeconds: 600 }), async (req, res) => {
    try {
        const { data: schools, error } = await supabaseAdmin
            .from('verified_schools')
            .select('*')
            .order('name', { ascending: true });

        if (error) {
            console.warn('Could not load verified_schools table:', error.message || error);
            return res.json({ schools: [] });
        }

        res.json({ schools });
    } catch (error) {
        console.error('Get schools error:', error);
        res.json({ schools: [] });
    }
});

// ── School request routes ─────────────────────────────────────────────────────

// POST /api/school-requests — authenticated user submits a request
app.post('/api/school-requests', requireAuth, async (req, res) => {
    try {
        const { school_name, reason } = req.body;
        if (!school_name || !String(school_name).trim()) {
            return res.status(400).json({ error: 'School name is required' });
        }
        const cleanName = String(school_name).trim().slice(0, 200);
        const cleanReason = reason ? String(reason).trim().slice(0, 500) : null;

        // Block new request if user already has any pending request
        const { data: existing } = await supabaseAdmin
            .from('school_requests')
            .select('id, school_name')
            .eq('user_id', req.session.userId)
            .eq('status', 'pending')
            .maybeSingle();

        if (existing) {
            return res.status(409).json({ error: `You already have a pending request for "${existing.school_name}". Please wait for it to be reviewed before submitting another.` });
        }

        const { data, error } = await supabaseAdmin
            .from('school_requests')
            .insert([{ user_id: req.session.userId, school_name: cleanName, reason: cleanReason }])
            .select()
            .single();

        if (error) {
            console.error('School request insert error:', error);
            return res.status(500).json({ error: 'Failed to submit request' });
        }

        // Notify admins via Discord activity webhook
        const _base = (process.env.BASE_URL || process.env.PRODUCTION_URL || '').replace(/\/$/, '');
        _activityDiscord('School Request Submitted', [
            ['School Name', cleanName],
            ['Reason', cleanReason || '(none)'],
            ['Requester', _base ? `[${req.session.username}](${_base}/user?id=${req.session.userId})` : (req.session.username || 'n/a')],
            ['Time (UTC)', new Date().toISOString()]
        ]);

        res.json({ success: true, id: data.id });
    } catch (error) {
        console.error('School request error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/school-requests/my — returns the authenticated user's most recent school request
app.get('/api/school-requests/my', requireAuth, async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('school_requests')
            .select('id, school_name, reason, status, admin_note, created_at')
            .eq('user_id', req.session.userId)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) return res.status(500).json({ error: 'Server error' });
        res.json({ request: data || null });
    } catch (e) {
        console.error('Get my school request error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/school-requests — admin views all requests (filterable by status)
app.get('/api/admin/school-requests', requireAdmin, async (req, res) => {
    try {
        const status = req.query.status || 'pending';
        let query = supabaseAdmin
            .from('school_requests')
            .select('*, users:user_id(username, email)')
            .order('created_at', { ascending: false });

        if (status !== 'all') query = query.eq('status', status);

        const { data, error } = await query;
        if (error) {
            console.error('Get school requests error:', error);
            return res.status(500).json({ error: 'Failed to fetch requests' });
        }
        res.json({ requests: data || [] });
    } catch (error) {
        console.error('Get school requests error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/school-requests/:id/approve — approve and auto-create the school
app.put('/api/admin/school-requests/:id/approve', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_note } = req.body;

        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid request ID' });

        const { data: reqRow, error: fetchErr } = await supabaseAdmin
            .from('school_requests')
            .select('*')
            .eq('id', id)
            .single();

        if (fetchErr || !reqRow) return res.status(404).json({ error: 'Request not found' });
        if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

        // Add the school to verified_schools
        const { error: schoolErr } = await supabaseAdmin
            .from('verified_schools')
            .insert([{ name: reqRow.school_name }]);

        // Duplicate school name is acceptable (unique constraint may reject — treat as non-fatal)
        if (schoolErr && !schoolErr.message?.includes('unique')) {
            console.error('Approve: insert school error:', schoolErr);
            return res.status(500).json({ error: 'Failed to add school to verified list' });
        }

        // Mark request approved
        await supabaseAdmin
            .from('school_requests')
            .update({ status: 'approved', admin_note: admin_note || null, updated_at: new Date().toISOString() })
            .eq('id', id);

        await invalidateCacheNamespaces(['schools:list', 'subjects:public']);

        // Notify requester (in-app + push + email) — non-blocking
        (async () => {
            try {
                const { data: requester } = await supabaseAdmin
                    .from('users')
                    .select('id, email, username')
                    .eq('id', reqRow.user_id)
                    .single();
                if (!requester) return;

                // In-app notification + push
                await createNotification({
                    userId: requester.id,
                    type: 'school_request',
                    title: 'School Request Approved',
                    message: `Your request to add "${reqRow.school_name}" has been approved! You can now select it when creating a subject.`,
                    link: '/dashboard'
                });

                // Email
                sendTemplatedEmail({
                    to: requester.email,
                    subject: `Your school request for "${reqRow.school_name}" was approved`,
                    template: 'school_request_approved',
                    variables: { username: requester.username, schoolName: reqRow.school_name, adminNote: admin_note || '' }
                }).catch(() => {});
            } catch (notifyErr) {
                console.warn('Failed to notify requester on school approval:', notifyErr.message);
            }
        })();

        res.json({ success: true });
    } catch (error) {
        console.error('Approve school request error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/admin/school-requests/:id/reject — reject a request
app.put('/api/admin/school-requests/:id/reject', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { admin_note } = req.body;

        if (!isValidUUID(id)) return res.status(400).json({ error: 'Invalid request ID' });

        const { data: reqRow, error: fetchErr } = await supabaseAdmin
            .from('school_requests')
            .select('id, status, user_id, school_name')
            .eq('id', id)
            .single();

        if (fetchErr || !reqRow) return res.status(404).json({ error: 'Request not found' });
        if (reqRow.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });

        await supabaseAdmin
            .from('school_requests')
            .update({ status: 'rejected', admin_note: admin_note || null, updated_at: new Date().toISOString() })
            .eq('id', id);

        // Notify requester (in-app + push + email) — non-blocking
        (async () => {
            try {
                const { data: requester } = await supabaseAdmin
                    .from('users')
                    .select('id, email, username')
                    .eq('id', reqRow.user_id)
                    .single();
                if (!requester) return;

                // In-app notification + push
                await createNotification({
                    userId: requester.id,
                    type: 'school_request',
                    title: 'School Request Update',
                    message: `Your request to add "${reqRow.school_name}" was not approved at this time.${admin_note ? ' Reason: ' + admin_note : ''}`,
                    link: '/dashboard'
                });

                // Email
                sendTemplatedEmail({
                    to: requester.email,
                    subject: `Update on your school request for "${reqRow.school_name}"`,
                    template: 'school_request_rejected',
                    variables: { username: requester.username, schoolName: reqRow.school_name, adminNote: admin_note || '' }
                }).catch(() => {});
            } catch (notifyErr) {
                console.warn('Failed to notify requester on school rejection:', notifyErr.message);
            }
        })();

        res.json({ success: true });
    } catch (error) {
        console.error('Reject school request error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create subject
app.post('/api/subjects', requireAuth, async (req, res) => {
    try {
        const { name, description, school } = req.body;

        if (!name) {
            return res.status(400).json({ error: 'Subject name is required' });
        }
        if (!description) {
            return res.status(400).json({ error: 'Subject description is required' });
        }
        if (!school) {
            return res.status(400).json({ error: 'School selection is required' });
        }

        // Use admin client so Row Level Security does not block server-side inserts
        const { data: subject, error } = await supabaseAdmin
            .from('subjects')
            .insert([{
                user_id: req.session.userId,
                name,
                description: description || '',
                school
            }])
            .select()
            .single();

        if (error) {
            console.error('Create subject error:', error);
            return res.status(500).json({ error: 'Failed to create subject' });
        }

        // Log subject creation to Discord activity webhook
        const _subBase = (process.env.BASE_URL || process.env.PRODUCTION_URL || '').replace(/\/$/, '');
        _activityDiscord('📚 Subject Created', [
            ['Creator', _subBase ? `[${req.session.username || 'user'}](${_subBase}/user?id=${req.session.userId})` : (req.session.username || 'n/a')],
            ['Subject', name],
            ['School', school],
            ['Time (UTC)', new Date().toISOString()]
        ]);

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public']);

        res.json({ subject });
    } catch (error) {
        console.error('Create subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update subject
app.put('/api/subjects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, school } = req.body;

        if (!name) return res.status(400).json({ error: 'Subject name is required' });

        const { data: subject, error } = await supabaseAdmin
            .from('subjects')
            .update({ name, description: description || '', school })
            .eq('id', id)
            .eq('user_id', req.session.userId)
            .select()
            .single();

        if (error) {
            console.error('Update subject error:', error);
            return res.status(500).json({ error: 'Failed to update subject' });
        }

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public']);

        res.json({ subject });
    } catch (error) {
        console.error('Update subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete subject
app.delete('/api/subjects/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('subjects')
            .delete()
            .eq('id', id)
            .eq('user_id', req.session.userId);

        if (error) {
            console.error('Delete subject error:', error);
            return res.status(500).json({ error: 'Failed to delete subject' });
        }

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest']);

        res.json({ message: 'Subject deleted successfully' });
    } catch (error) {
        console.error('Delete subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// REVIEWER ROUTES
// =====================================================

// Get reviewers for a subject
app.get('/api/subjects/:subjectId/reviewers', requireAuth, cacheResponse({ namespace: 'reviewers:subject', includeUser: true, ttlSeconds: 120, extraParts: (req) => [req.params.subjectId] }), async (req, res) => {
    try {
        const { subjectId } = req.params;

        // Support pagination: ?limit=10&offset=0
        const limit = Math.min(parseInt(req.query.limit) || 10, 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const start = offset;
        const end = offset + limit - 1;

        const search = (req.query.search || '').trim();

        let query = supabase
            .from('reviewers')
            .select('*', { count: 'exact' })
            .eq('subject_id', subjectId)
            .eq('user_id', req.session.userId);

        if (search) {
            // search title or content
            query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
        }

        const { data: reviewers, count, error } = await query
            .order('created_at', { ascending: false })
            .range(start, end);

        if (error) {
            console.error('Get reviewers error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewers' });
        }

        res.json({ reviewers, count: count || 0, limit, offset });
    } catch (error) {
        console.error('Get reviewers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all public reviewers
app.get('/api/reviewers/public', requireAuth, cacheResponse({ namespace: 'reviewers:public-auth', ttlSeconds: 90 }), async (req, res) => {
    try {
        const { search, student } = req.query;

        let query = supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (id, username, display_name, profile_picture_url),
                subjects:subject_id (name, school)
            `)
            .eq('is_public', true);

        if (search) {
            // Escape special characters for ILIKE pattern matching
            const escapedSearch = String(search).replace(/[%_\\]/g, '\\$&');
            query = query.or(`title.ilike.%${escapedSearch}%,content.ilike.%${escapedSearch}%`);
        }

        if (student) {
            // Validate student UUID
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(student)) {
                return res.status(400).json({ error: 'Invalid student ID format' });
            }
            query = query.eq('user_id', student);
        }

        query = query.order('created_at', { ascending: false });

        const { data: reviewers, error } = await query;

        if (error) {
            console.error('Get public reviewers error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewers' });
        }

        res.json({ reviewers });
    } catch (error) {
        console.error('Get public reviewers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public endpoint: get public reviewers for anonymous users (no auth required)
app.get('/api/reviewers/public-guest', cacheResponse({ namespace: 'reviewers:public-guest', ttlSeconds: 90 }), async (req, res) => {
    console.info('[req] GET /api/reviewers/public-guest from', req.ip, 'query:', req.query);
    try {
        const { search, student } = req.query;

        // Pagination params
        const limit = Math.min(parseInt(req.query.limit) || 10, 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const start = offset;
        const end = offset + limit - 1;

        let query = supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (id, username, display_name, profile_picture_url),
                subjects:subject_id (name, school)
            `, { count: 'exact' })
            .eq('is_public', true);

        if (search) {
            query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
        }

        if (student) {
            query = query.eq('user_id', student);
        }

        if (req.query.subject_id && UUID_REGEX.test(req.query.subject_id)) {
            query = query.eq('subject_id', req.query.subject_id);
        }

        query = query.order('created_at', { ascending: false }).range(start, end);

        let result;
        try {
            result = await withTimeout(query, 8000);
        } catch (e) {
            console.error('Supabase timeout fetching public reviewers (guest):', e && e.message ? e.message : e);
            return res.status(504).json({ error: 'Upstream timeout' });
        }

        const { data: reviewers, count, error } = result;
        if (error) {
            console.error('Get public reviewers (guest) error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewers' });
        }

        res.json({ reviewers, count: count || 0, limit, offset });
    } catch (error) {
        console.error('Get public reviewers (guest) error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Subjects with at least one public reviewer (used for index page filter chips)
app.get('/api/subjects/public', cacheResponse({ namespace: 'subjects:public', ttlSeconds: 300 }), async (req, res) => {
    try {
        const { data, error } = await withTimeout(
            supabase
                .from('reviewers')
                .select('subject_id, subjects:subject_id(id, name, school)')
                .eq('is_public', true),
            8000
        );
        if (error) return res.status(500).json({ error: 'Failed to fetch subjects' });

        // Collect unique subject IDs and their school UUIDs
        const seen = new Map();
        for (const r of data || []) {
            if (r.subjects && r.subjects.id && !seen.has(r.subjects.id)) {
                seen.set(r.subjects.id, { id: r.subjects.id, name: r.subjects.name, school_id: r.subjects.school || null });
            }
        }

        // Fetch school names for subjects that have a school
        const schoolIds = [...new Set([...seen.values()].map(s => s.school_id).filter(Boolean))];
        const schoolMap = {};
        if (schoolIds.length) {
            const { data: schoolData } = await supabaseAdmin
                .from('verified_schools')
                .select('id, name')
                .in('id', schoolIds);
            for (const sc of schoolData || []) schoolMap[sc.id] = sc.name;
        }

        const subjects = Array.from(seen.values())
            .map(s => ({ ...s, school_name: s.school_id ? (schoolMap[s.school_id] || null) : null }))
            .sort((a, b) => a.name.localeCompare(b.name));
        res.json({ subjects });
    } catch (e) {
        console.error('Get public subjects error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Reactions endpoints
// Get reactions count for a reviewer and whether current user reacted (if authenticated)
app.get('/api/reviewers/:id/reactions', async (req, res) => {
    try {
        const { id } = req.params;

        // Count reactions for reviewer
        const { data: reactions, error } = await supabaseAdmin
            .from('reactions')
            .select('id, user_id, reaction_type')
            .eq('reviewer_id', id);

        if (error) {
            console.warn('Reactions table missing or query failed:', error.message || error);
            return res.json({ count: 0, reacted: false });
        }

        const count = reactions.length;
        let reacted = false;
        if (req.session && req.session.userId) {
            reacted = reactions.some(r => r.user_id === req.session.userId && r.reaction_type === 'heart');
        }

        res.json({ count, reacted });
    } catch (error) {
        console.error('Get reactions error:', error);
        res.status(500).json({ count: 0, reacted: false });
    }
});

// Toggle reaction (heart) for current user on a reviewer
app.post('/api/reviewers/:id/reactions', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.session.userId;
        const reactionType = (req.body && req.body.reaction) || 'heart';
        // Prevent the author from reacting to their own reviewer
        try {
            const { data: reviewerRow, error: reviewerErr } = await supabaseAdmin
                .from('reviewers')
                .select('user_id')
                .eq('id', id)
                .single();

            if (reviewerErr) {
                console.error('Failed to fetch reviewer for reaction check:', reviewerErr);
                return res.status(400).json({ error: 'Invalid reviewer' });
            }

            if (reviewerRow && reviewerRow.user_id === userId) {
                // Return current counts without modifying DB
                const { data: current, error: currErr } = await supabaseAdmin
                    .from('reactions')
                    .select('id, user_id, reaction_type')
                    .eq('reviewer_id', id)
                    .eq('reaction_type', reactionType);

                const count = (current && current.length) ? current.length : 0;
                return res.status(403).json({ error: 'Cannot react to your own reviewer', count, reacted: false });
            }
        } catch (e) {
            console.error('Reviewer owner check error:', e);
            return res.status(500).json({ error: 'Server error' });
        }
        // Check if any reaction(s) exist for this user/reviewer/type
        const { data: existingRows, error: fetchErr } = await supabaseAdmin
            .from('reactions')
            .select('id')
            .eq('reviewer_id', id)
            .eq('user_id', userId)
            .eq('reaction_type', reactionType);

        if (fetchErr) {
            console.error('Fetch existing reactions error:', fetchErr);
            return res.status(500).json({ error: 'Failed to fetch existing reactions' });
        }

        console.debug('Reactions toggle:', { reviewer_id: id, userId, existing: existingRows && existingRows.length });
        if (existingRows && existingRows.length > 0) {
            // User already reacted — remove all matching entries (toggle off)
            const { error: delErr } = await supabaseAdmin
                .from('reactions')
                .delete()
                .eq('reviewer_id', id)
                .eq('user_id', userId)
                .eq('reaction_type', reactionType);

            if (delErr) {
                console.error('Delete reaction error:', delErr);
                return res.status(500).json({ error: 'Failed to remove reaction' });
            }
        } else {
            // Insert a single reaction entry
            const { data: newR, error: insertErr } = await supabaseAdmin
                .from('reactions')
                .insert([{ reviewer_id: id, user_id: userId, reaction_type: reactionType }])
                .select()
                .single();

            if (insertErr) {
                console.error('Insert reaction error:', insertErr);
                return res.status(500).json({ error: 'Failed to add reaction' });
            }

            // Create notification for the reviewer owner
            // Get reviewer title and user info
            const { data: reviewer } = await supabaseAdmin
                .from('reviewers')
                .select('title, user_id')
                .eq('id', id)
                .single();
            
            const { data: reactingUser } = await supabaseAdmin
                .from('users')
                .select('username')
                .eq('id', userId)
                .single();

            if (reviewer && reactingUser && reviewer.user_id !== userId) {
                // Map reaction types to emoji and text
                const reactionDisplay = {
                    'like': '❤️ liked',
                    'haha': '😂 laughed at',
                    'sad': '😢 felt sad about',
                    'wow': '😮 was amazed by',
                    'heart': '💖 loved'
                };
                const reactionText = reactionDisplay[reactionType] || 'reacted to';

                await createNotification({
                    userId: reviewer.user_id,
                    type: 'reaction',
                    title: 'New Reaction',
                    message: `${reactingUser.username} ${reactionText} your reviewer "${reviewer.title}"`,
                    link: `/reviewer.html?id=${id}`,
                    relatedUserId: userId,
                    relatedItemId: id
                });
            }
        }

        // Return updated count and current user state
                const { data: reactionsAfter, error: afterErr } = await supabaseAdmin
                    .from('reactions')
                    .select('id, user_id, reaction_type')
                    .eq('reviewer_id', id)
                    .eq('reaction_type', reactionType);

        if (afterErr) {
            console.error('Fetch reactions after toggle error:', afterErr);
            return res.status(500).json({ error: 'Failed to fetch reactions' });
        }

        const count = reactionsAfter.length;
        const reacted = reactionsAfter.some(r => r.user_id === userId && r.reaction_type === reactionType);
        console.debug('Reactions after toggle:', { reviewer_id: id, count, reacted });

        res.json({ count, reacted });
    } catch (error) {
        console.error('Toggle reaction error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create reviewer
app.post('/api/reviewers', requireAuth, async (req, res) => {
    try {
        // Enforce bans/restrictions server-side
        try {
            const { data: me } = await supabaseAdmin.from('users').select('id, banned_until, blocked_from_creating_until').eq('id', req.session.userId).single();
            if (me) {
                const now = new Date().toISOString();
                    if (me.banned_until && new Date(me.banned_until) > new Date(now)) {
                        return res.status(403).json({ error: 'Your account is banned and cannot create content.', banned_until: me.banned_until, status: 'banned' });
                    }
                    if (me.blocked_from_creating_until && new Date(me.blocked_from_creating_until) > new Date(now)) {
                        return res.status(403).json({ error: 'You are restricted from creating reviewers at this time.', blocked_from_creating_until: me.blocked_from_creating_until, status: 'restricted' });
                    }
            }
        } catch (e) {
            console.warn('Failed to check user ban/restriction status', e);
        }

        const { subject_id, title, content, is_public, flashcards } = req.body;

        if (!subject_id || !title || !content) {
            return res.status(400).json({ error: 'Subject, title, and content are required' });
        }

        // Support single-textfield input: 'flashcards_text' where each line is "front,back"
        let flashcardsToSave = null;
        const parseFlashcardsText = (txt) => {
            if (!txt) return [];
            return String(txt).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                const parts = line.split(',');
                const front = parts[0] ? parts[0].trim() : '';
                const back = parts.slice(1).join(',').trim();
                return { id: generateUUID(), front, back, is_public: true, uploader_id: req.session.userId };
            });
        };

        if (Array.isArray(flashcards) && flashcards.length) {
            flashcardsToSave = flashcards.map(fc => ({
                id: fc.id || generateUUID(),
                front: (fc.front || fc.meaning || '').toString().trim(),
                back: (fc.back || fc.content || '').toString().trim(),
                is_public: !!fc.is_public,
                uploader_id: fc.uploader_id || req.session.userId
            }));
        } else if (req.body.flashcards_text) {
            const parsed = parseFlashcardsText(req.body.flashcards_text);
            if (parsed.length) flashcardsToSave = parsed;
        }

        const insertObj = Object.assign({
            user_id: req.session.userId,
            subject_id,
            title,
            content,
            is_public: is_public !== false
        }, flashcardsToSave ? { flashcards: flashcardsToSave } : {});

        const { data: reviewer, error } = await supabaseAdmin
            .from('reviewers')
            .insert([insertObj])
            .select()
            .single();

        if (error) {
            console.error('Create reviewer error:', error);
            return res.status(500).json({ error: 'Failed to create reviewer' });
        }

        // Log reviewer creation to Discord activity webhook
        const _revBase = (process.env.BASE_URL || process.env.PRODUCTION_URL || '').replace(/\/$/, '');
        _activityDiscord('📝 Reviewer Created', [
            ['Author', _revBase ? `[${req.session.username || 'user'}](${_revBase}/user?id=${req.session.userId})` : (req.session.username || 'n/a')],
            ['Title', title],
            ['Visibility', is_public !== false ? 'Public' : 'Private'],
            ['Flashcards', flashcardsToSave ? String(flashcardsToSave.length) : '0'],
            ['Time (UTC)', new Date().toISOString()]
        ]);

        // Background AI proactive moderation scan (fire-and-forget, non-blocking)
        autoModerateReviewer(reviewer.id, {
            title: reviewer.title || '',
            content: reviewer.content || '',
            username: req.session.username || 'Unknown'
        }).catch(() => {});

        // Notify followers about new reviewer (in-app + push + email, async, non-blocking)
        (async () => {
            try {
                const { data: followers } = await supabaseAdmin
                    .from('followers')
                    .select('follower_id, users:follower_id(email, username)')
                    .eq('following_id', req.session.userId);

                if (followers && followers.length > 0) {
                    const { data: author } = await supabaseAdmin
                        .from('users')
                        .select('username')
                        .eq('id', req.session.userId)
                        .single();

                    const authorName = author?.username || 'A user you follow';
                    const reviewerUrl = `/reviewer.html?id=${reviewer.id}`;

                    for (const follower of followers) {
                        // In-app notification + push
                        await createNotification({
                            userId: follower.follower_id,
                            type: 'new_reviewer',
                            title: `New reviewer from ${authorName}`,
                            message: `${authorName} just published "${title}" — check it out!`,
                            link: reviewerUrl,
                            relatedUserId: req.session.userId,
                            relatedItemId: reviewer.id,
                        });

                        // Email
                        if (follower.users && follower.users.email) {
                            try {
                                await mailTransporter.sendMail({
                                    from: process.env.SMTP_FROM || 'Thinky <no-reply@thinky.com>',
                                    to: follower.users.email,
                                    subject: `${authorName} posted a new reviewer on Thinky`,
                                    html: `
                                        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                                            <h2 style="color: #ff69b4;">New Reviewer from ${authorName}</h2>
                                            <p>Hello ${follower.users.username},</p>
                                            <p><strong>${authorName}</strong> just posted a new reviewer: <strong>${title}</strong></p>
                                            <p>Check it out on Thinky!</p>
                                            <a href="${process.env.PRODUCTION_URL || 'http://localhost:3000'}${reviewerUrl}" 
                                               style="display: inline-block; padding: 12px 24px; background: #ff69b4; color: white; text-decoration: none; border-radius: 999px; margin: 16px 0;">
                                                View Reviewer
                                            </a>
                                            <p style="color: #666; font-size: 12px; margin-top: 24px;">
                                                You received this email because you follow ${authorName} on Thinky.
                                            </p>
                                        </div>
                                    `
                                });
                            } catch (emailErr) {
                                console.error('Failed to send email to follower:', follower.follower_id, emailErr);
                            }
                        }
                    }
                }
            } catch (err) {
                console.error('Failed to notify followers:', err);
            }
        })();

        await invalidateCacheNamespaces(['reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest', 'subjects:public']);

        res.json({ reviewer });
    } catch (error) {
        console.error('Create reviewer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get a single reviewer with user and subject info
app.get('/api/reviewers/:id', requireAuth, cacheResponse({ namespace: 'reviewers:detail', ttlSeconds: 120, extraParts: (req) => [req.params.id] }), async (req, res) => {
    try {
        const { id } = req.params;

        const { data: reviewers, error } = await supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (id, username, display_name, profile_picture_url),
                subjects:subject_id (name, school)
            `)
            .eq('id', id)
            .limit(1)
            .single();

        if (error) {
            console.error('Get reviewer by id error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewer' });
        }

        res.json({ reviewer: reviewers });
    } catch (error) {
        console.error('Get reviewer by id error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Report a reviewer (user-facing)
app.post('/api/reviewers/:id/report', requireAuth, async (req, res) => {
    try {
        const reviewerId = req.params.id;
        const reporterId = req.session.userId;
        const { report_type, details } = req.body;

        if (!report_type) return res.status(400).json({ error: 'report_type is required' });

        const { data, error } = await supabaseAdmin
            .from('reviewer_reports')
            .insert([{ reviewer_id: reviewerId, reporter_id: reporterId, report_type, details }]);

        if (error) {
            console.error('Failed to create report:', error);
            return res.status(500).json({ error: 'Failed to submit report' });
        }

        res.json({ ok: true, report: data && data[0] });

        // Fire-and-forget: AI re-scans the reported reviewer with the report context
        ;(async () => {
            try {
                const { data: rev } = await supabaseAdmin
                    .from('reviewers')
                    .select('id, title, content, user_id, users:user_id(username)')
                    .eq('id', reviewerId)
                    .single();
                if (rev) {
                    await autoModerateReviewer(rev.id, {
                        title: rev.title || '',
                        content: rev.content || '',
                        username: rev.users?.username || 'Unknown',
                        reportType: report_type,
                        reportDetails: details
                    });
                }
            } catch (e) { /* non-blocking */ }
        })();
    } catch (err) {
        console.error('Report reviewer error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public: get basic user info by id
app.get('/api/users/:id', async (req, res) => {
    try {
        let { id } = req.params;
        
        // Support username lookups: if id starts with '@', treat it as username
        const isUsername = id.startsWith('@');
        if (isUsername) {
            id = id.substring(1); // Remove the '@' prefix
        }
        
        let query = supabase
            .from('users')
            .select('id, username, display_name, profile_picture_url, created_at, follower_count, following_count');
        
        if (isUsername) {
            query = query.eq('username', id);
        } else {
            query = query.eq('id', id);
        }
        
        const { data: user, error } = await query.maybeSingle();

        if (error) {
            console.error('Get user by id error:', error);
            return res.status(500).json({ error: 'Server error' });
        }

        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Get user by id error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public: get public reviewers by a specific user with pagination and search (guest-friendly)
app.get('/api/users/:id/reviewers', async (req, res) => {
    try {
        let { id } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 10, 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const start = offset;
        const end = offset + limit - 1;
        const search = (req.query.search || '').trim();

        // Support username lookups: if id starts with '@', treat it as username and resolve to user ID
        if (id.startsWith('@')) {
            const username = id.substring(1);
            const { data: userData } = await supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            
            if (!userData) {
                return res.status(404).json({ error: 'User not found' });
            }
            id = userData.id;
        }

        let query = supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (id, username, profile_picture_url, display_name),
                subjects:subject_id (name, school)
            `, { count: 'exact' })
            .eq('is_public', true)
            .eq('user_id', id);

        if (search) {
            query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
        }

        query = query.order('created_at', { ascending: false }).range(start, end);

        const { data: reviewers, count, error } = await query;

        if (error) {
            console.error('Get user reviewers error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewers' });
        }

        res.json({ reviewers, count: count || 0, limit, offset });
    } catch (error) {
        console.error('Get user reviewers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/users/me/social - Get followers and following for current user (for chat sidebar)
app.get('/api/users/me/social', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;

        // Fetch people who follow the current user
        const { data: followersData, error: followersError } = await supabaseAdmin
            .from('followers')
            .select('follower_id, users:follower_id (id, username, display_name, profile_picture_url)')
            .eq('following_id', userId);

        // Fetch people the current user follows
        const { data: followingData, error: followingError } = await supabaseAdmin
            .from('followers')
            .select('following_id, users:following_id (id, username, display_name, profile_picture_url)')
            .eq('follower_id', userId);

        if (followersError || followingError) {
            console.error('Social fetch error:', followersError || followingError);
            return res.status(500).json({ error: 'Failed to fetch social connections' });
        }

        // Deduplicate into a single user list
        const seen = new Set();
        const people = [];

        for (const row of (followersData || [])) {
            const u = row.users;
            if (u && !seen.has(u.id)) {
                seen.add(u.id);
                people.push({ id: u.id, username: u.username, display_name: u.display_name, profile_picture_url: u.profile_picture_url, relation: 'follower' });
            }
        }
        for (const row of (followingData || [])) {
            const u = row.users;
            if (u && !seen.has(u.id)) {
                seen.add(u.id);
                people.push({ id: u.id, username: u.username, display_name: u.display_name, profile_picture_url: u.profile_picture_url, relation: 'following' });
            } else if (u && seen.has(u.id)) {
                // Mark mutual
                const existing = people.find(p => p.id === u.id);
                if (existing) existing.relation = 'mutual';
            }
        }

        res.json({ people });
    } catch (error) {
        console.error('Get social connections error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/messages/unread-per-user - Get unread message counts per conversation partner
app.get('/api/messages/unread-per-user', requireAuth, async (req, res) => {
    try {
        const lastSeenPrivate = req.query.lastSeenPrivate || '1970-01-01T00:00:00Z';

        // Get all unread private messages for current user since lastSeenPrivate
        const { data: unreadMsgs, error } = await supabaseAdmin
            .from('messages')
            .select('user_id')
            .eq('chat_type', 'private')
            .eq('recipient_id', req.session.userId)
            .gt('created_at', lastSeenPrivate);

        if (error) {
            console.error('Unread per user error:', error);
            return res.status(500).json({ error: 'Failed to fetch unread counts' });
        }

        // Count per sender
        const counts = {};
        for (const msg of (unreadMsgs || [])) {
            counts[msg.user_id] = (counts[msg.user_id] || 0) + 1;
        }

        res.json({ counts });
    } catch (error) {
        console.error('Unread per user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/users/:id/follow - Follow a user
app.post('/api/users/:id/follow', requireAuth, async (req, res) => {
    try {
        let { id } = req.params;
        const followerId = req.session.userId;

        // Support username lookups
        if (id.startsWith('@')) {
            const username = id.substring(1);
            const { data: userData } = await supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            
            if (!userData) {
                return res.status(404).json({ error: 'User not found' });
            }
            id = userData.id;
        }

        if (id === followerId) {
            return res.status(400).json({ error: 'Cannot follow yourself' });
        }

        // Check if already following
        const { data: existing } = await supabaseAdmin
            .from('followers')
            .select('id')
            .eq('follower_id', followerId)
            .eq('following_id', id)
            .single();

        if (existing) {
            return res.status(400).json({ error: 'Already following this user' });
        }

        // Insert follow relationship
        const { error: insertError } = await supabaseAdmin
            .from('followers')
            .insert([{
                follower_id: followerId,
                following_id: id
            }]);

        if (insertError) {
            console.error('Follow user error:', insertError);
            return res.status(500).json({ error: 'Failed to follow user' });
        }

        // Create notification for the followed user
        try {
            const { data: follower } = await supabaseAdmin
                .from('users')
                .select('username')
                .eq('id', followerId)
                .single();

            if (follower) {
                await createNotification({
                    userId: id,
                    type: 'follow',
                    title: 'New Follower',
                    message: `${follower.username} started following you`,
                    link: `/user.html?user=${followerId}`,
                    relatedUserId: followerId,
                    relatedItemId: null
                });
            }
        } catch (notifErr) {
            console.error('Failed to create follow notification:', notifErr);
        }

        res.json({ success: true, following: true });
    } catch (error) {
        console.error('Follow user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/users/:id/follow - Unfollow a user
app.delete('/api/users/:id/follow', requireAuth, async (req, res) => {
    try {
        let { id } = req.params;
        const followerId = req.session.userId;

        // Support username lookups
        if (id.startsWith('@')) {
            const username = id.substring(1);
            const { data: userData } = await supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            
            if (!userData) {
                return res.status(404).json({ error: 'User not found' });
            }
            id = userData.id;
        }

        const { error } = await supabaseAdmin
            .from('followers')
            .delete()
            .eq('follower_id', followerId)
            .eq('following_id', id);

        if (error) {
            console.error('Unfollow user error:', error);
            return res.status(500).json({ error: 'Failed to unfollow user' });
        }

        res.json({ success: true, following: false });
    } catch (error) {
        console.error('Unfollow user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/users/:id/follow-status - Check if current user follows this user
app.get('/api/users/:id/follow-status', requireAuth, async (req, res) => {
    try {
        let { id } = req.params;
        const followerId = req.session.userId;

        // Support username lookups
        if (id.startsWith('@')) {
            const username = id.substring(1);
            const { data: userData } = await supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .maybeSingle();
            
            if (!userData) {
                return res.status(404).json({ error: 'User not found' });
            }
            id = userData.id;
        }

        const { data: follow } = await supabaseAdmin
            .from('followers')
            .select('id')
            .eq('follower_id', followerId)
            .eq('following_id', id)
            .single();

        res.json({ following: !!follow });
    } catch (error) {
        console.error('Get follow status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/users/:id/followers - List of users who follow user :id
app.get('/api/users/:id/followers', async (req, res) => {
    try {
        const { id } = req.params;
        const loggedInUserId = req.session?.userId || null;
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = parseInt(req.query.offset) || 0;

        const { data, error } = await supabaseAdmin
            .from('followers')
            .select('follower_id, users:follower_id (id, username, display_name, profile_picture_url)')
            .eq('following_id', id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Get followers list error:', error);
            return res.status(500).json({ error: 'Server error' });
        }

        const users = (data || []).map(row => row.users).filter(Boolean);

        let myFollowingSet = new Set();
        if (loggedInUserId && users.length > 0) {
            const { data: myData } = await supabaseAdmin
                .from('followers')
                .select('following_id')
                .eq('follower_id', loggedInUserId)
                .in('following_id', users.map(u => u.id));
            (myData || []).forEach(row => myFollowingSet.add(row.following_id));
        }

        res.json({
            users: users.map(u => ({ ...u, is_following: loggedInUserId ? myFollowingSet.has(u.id) : null })),
            hasMore: users.length === limit
        });
    } catch (error) {
        console.error('Get followers list error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/users/:id/following - List of users that user :id follows
app.get('/api/users/:id/following', async (req, res) => {
    try {
        const { id } = req.params;
        const loggedInUserId = req.session?.userId || null;
        const limit = Math.min(parseInt(req.query.limit) || 20, 50);
        const offset = parseInt(req.query.offset) || 0;

        const { data, error } = await supabaseAdmin
            .from('followers')
            .select('following_id, users:following_id (id, username, display_name, profile_picture_url)')
            .eq('follower_id', id)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (error) {
            console.error('Get following list error:', error);
            return res.status(500).json({ error: 'Server error' });
        }

        const users = (data || []).map(row => row.users).filter(Boolean);

        let myFollowingSet = new Set();
        if (loggedInUserId && users.length > 0) {
            const { data: myData } = await supabaseAdmin
                .from('followers')
                .select('following_id')
                .eq('follower_id', loggedInUserId)
                .in('following_id', users.map(u => u.id));
            (myData || []).forEach(row => myFollowingSet.add(row.following_id));
        }

        res.json({
            users: users.map(u => ({ ...u, is_following: loggedInUserId ? myFollowingSet.has(u.id) : null })),
            hasMore: users.length === limit
        });
    } catch (error) {
        console.error('Get following list error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Compiler proxy (Wandbox — free, no API key) ─────────────────────────────
const _WANDBOX_COMPILERS = {
    cpp:        { compiler: 'gcc-head' },
    c:          { compiler: 'gcc-head', 'compiler-option-raw': '-x c' },
    python:     { compiler: 'cpython-3.12.0' },
    javascript: { compiler: 'nodejs-head' },
    java:       { compiler: 'openjdk-head' },
    go:         { compiler: 'go-head' },
    rust:       { compiler: 'rust-head' },
    php:        { compiler: 'php-head' },
    ruby:       { compiler: 'ruby-head' },
};

app.post('/api/compiler/run', requireAuth, async (req, res) => {
    try {
        const { language, code, stdin } = req.body;
        if (!language || !code) return res.status(400).json({ error: 'language and code are required' });
        const langConfig = _WANDBOX_COMPILERS[language];
        if (!langConfig) return res.status(400).json({ error: `Unsupported language: ${language}` });

        const body = { code, ...langConfig };
        if (stdin) body.stdin = stdin;

        const wandRes = await fetch('https://wandbox.org/api/compile', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!wandRes.ok) {
            const text = await wandRes.text();
            return res.status(502).json({ error: 'Compiler service error', detail: text });
        }
        const data = await wandRes.json();
        return res.json({
            stdout: data.program_output || '',
            stderr: (data.compiler_error || '') + (data.program_error || ''),
            compileOutput: data.compiler_output || '',
            status: data.status,
        });
    } catch (err) {
        console.error('Wandbox proxy error:', err);
        res.status(500).json({ error: 'Compiler service unavailable' });
    }
});

// Update reviewer
app.put('/api/reviewers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, content, is_public, flashcards } = req.body;

        const updateObj = { title, content, is_public: is_public !== false };

        // parse simple textarea format if provided
        const parseFlashcardsText = (txt) => {
            if (!txt) return [];
            return String(txt).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                const parts = line.split(',');
                const front = parts[0] ? parts[0].trim() : '';
                const back = parts.slice(1).join(',').trim();
                return { id: generateUUID(), front, back, is_public: true, uploader_id: req.session.userId };
            });
        };

        if (Array.isArray(flashcards)) {
            updateObj.flashcards = flashcards.map(fc => ({
                id: fc.id || generateUUID(),
                front: (fc.front || fc.meaning || '').toString().trim(),
                back: (fc.back || fc.content || '').toString().trim(),
                is_public: !!fc.is_public,
                uploader_id: fc.uploader_id || req.session.userId
            }));
        } else if (req.body.flashcards_text) {
            const parsed = parseFlashcardsText(req.body.flashcards_text);
            if (parsed.length) updateObj.flashcards = parsed;
        }

        const { data: reviewer, error } = await supabaseAdmin
            .from('reviewers')
            .update(updateObj)
            .eq('id', id)
            .eq('user_id', req.session.userId)
            .select()
            .single();

        if (error) {
            console.error('Update reviewer error:', error);
            return res.status(500).json({ error: 'Failed to update reviewer' });
        }

        await invalidateCacheNamespaces(['reviewers:detail', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest', 'subjects:public']);

        res.json({ reviewer });
    } catch (error) {
        console.error('Update reviewer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete reviewer
app.delete('/api/reviewers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('reviewers')
            .delete()
            .eq('id', id)
            .eq('user_id', req.session.userId);

        if (error) {
            console.error('Delete reviewer error:', error);
            return res.status(500).json({ error: 'Failed to delete reviewer' });
        }

        await invalidateCacheNamespaces(['reviewers:detail', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest', 'subjects:public']);

        res.json({ message: 'Reviewer deleted successfully' });
    } catch (error) {
        console.error('Delete reviewer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Quiz Routes ──────────────────────────────────────────────────────────────

// PUT /api/reviewers/:id/quiz  – create or replace quiz (owner only)
app.put('/api/reviewers/:id/quiz', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid reviewer ID' });

        const { quiz } = req.body;

        // Basic structure validation
        if (!quiz || !Array.isArray(quiz.questions) || quiz.questions.length < 1) {
            return res.status(400).json({ error: 'Quiz must have at least 1 question' });
        }
        if (quiz.questions.length > 100) {
            return res.status(400).json({ error: 'Quiz cannot exceed 100 questions' });
        }

        for (const q of quiz.questions) {
            if (!q.question || typeof q.question !== 'string' || !q.question.trim()) {
                return res.status(400).json({ error: 'All questions must have text' });
            }
            if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) {
                return res.status(400).json({ error: 'Each question must have 2–6 options' });
            }
            for (const opt of q.options) {
                if (!opt || typeof opt !== 'string' || !opt.trim()) {
                    return res.status(400).json({ error: 'All answer options must have text' });
                }
            }
            if (typeof q.correct !== 'number' || q.correct < 0 || q.correct >= q.options.length) {
                return res.status(400).json({ error: 'Each question must have a valid correct answer index' });
            }
        }

        // Sanitise – only keep known fields, truncate lengths
        const sanitizedQuiz = {
            timer: (typeof quiz.timer === 'number' && quiz.timer > 0)
                ? Math.min(Math.floor(quiz.timer), 7200)
                : null,
            questions: quiz.questions.map(q => ({
                id: (typeof q.id === 'string' && UUID_REGEX.test(q.id))
                    ? q.id
                    : crypto.randomUUID(),
                question: String(q.question).trim().slice(0, 1000),
                options:  q.options.map(o => String(o).trim().slice(0, 500)),
                correct:  Math.floor(q.correct)
            }))
        };

        const { data, error } = await supabaseAdmin
            .from('reviewers')
            .update({ quiz: sanitizedQuiz })
            .eq('id', id)
            .eq('user_id', req.session.userId)
            .select('id')
            .single();

        if (error || !data) {
            return res.status(403).json({ error: 'Reviewer not found or you are not the owner' });
        }

        await invalidateCacheNamespaces(['reviewers:detail', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest']);

        res.json({ success: true, quiz: sanitizedQuiz });
    } catch (error) {
        console.error('Save quiz error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/reviewers/:id/quiz  – remove quiz (owner only)
app.delete('/api/reviewers/:id/quiz', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid reviewer ID' });

        const { data, error } = await supabaseAdmin
            .from('reviewers')
            .update({ quiz: null })
            .eq('id', id)
            .eq('user_id', req.session.userId)
            .select('id')
            .single();

        if (error || !data) {
            return res.status(403).json({ error: 'Reviewer not found or you are not the owner' });
        }

        await invalidateCacheNamespaces(['reviewers:detail', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest']);

        res.json({ success: true });
    } catch (error) {
        console.error('Delete quiz error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ─── Comment Routes ────────────────────────────────────────────────────────────

// GET /api/reviewers/:id/comments  — public
app.get('/api/reviewers/:id/comments', async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid reviewer ID' });

        const { data: reviewer } = await supabase.from('reviewers').select('id').eq('id', id).single();
        if (!reviewer) return res.status(404).json({ error: 'Reviewer not found' });

        // Try full query with is_pinned; fall back if the column doesn't exist yet
        let comments = null;

        const fullResult = await supabaseAdmin
            .from('reviewer_comments')
            .select(`id, content, created_at, updated_at, parent_id, is_pinned, users:user_id (id, username, display_name, profile_picture_url)`)
            .eq('reviewer_id', id)
            .order('is_pinned', { ascending: false })
            .order('created_at', { ascending: false });

        if (fullResult.error) {
            // Fallback: select without is_pinned (migration may not be applied yet)
            const fallback = await supabaseAdmin
                .from('reviewer_comments')
                .select(`id, content, created_at, updated_at, parent_id, users:user_id (id, username, display_name, profile_picture_url)`)
                .eq('reviewer_id', id)
                .order('created_at', { ascending: false });

            if (fallback.error) {
                console.error('Fetch comments error:', fallback.error);
                return res.status(500).json({ error: 'Failed to fetch comments' });
            }
            comments = fallback.data;
        } else {
            comments = fullResult.data;
        }

        const commentIds = (comments || []).map(c => c.id);
        let reactions = [];
        if (commentIds.length > 0) {
            const { data: rxData } = await supabaseAdmin
                .from('reviewer_comment_reactions')
                .select('comment_id, user_id, reaction_type')
                .in('comment_id', commentIds);
            reactions = rxData || [];
        }

        const sessionUserId = req.session && req.session.userId;
        const reactMap = {};
        const userReactMap = {};
        for (const rx of reactions) {
            if (!reactMap[rx.comment_id]) reactMap[rx.comment_id] = {};
            reactMap[rx.comment_id][rx.reaction_type] = (reactMap[rx.comment_id][rx.reaction_type] || 0) + 1;
            if (sessionUserId && rx.user_id === sessionUserId) {
                userReactMap[rx.comment_id] = rx.reaction_type;
            }
        }

        const byId = {};
        const topLevel = [];
        for (const c of (comments || [])) {
            byId[c.id] = {
                id: c.id, content: c.content, created_at: c.created_at,
                updated_at: c.updated_at, parent_id: c.parent_id,
                is_pinned: c.is_pinned || false,
                user: c.users || null,
                reactions: reactMap[c.id] || {},
                userReaction: userReactMap[c.id] || null,
                replies: []
            };
        }
        for (const c of (comments || [])) {
            if (c.parent_id && byId[c.parent_id]) {
                byId[c.parent_id].replies.push(byId[c.id]);
            } else if (!c.parent_id) {
                topLevel.push(byId[c.id]);
            }
        }

        res.json({ comments: topLevel });
    } catch (error) {
        console.error('Comments GET error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/reviewers/:id/comments  — auth required
app.post('/api/reviewers/:id/comments', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid reviewer ID' });

        const content = sanitizeString(req.body.content, 2000);
        if (!content || content.length < 1) return res.status(400).json({ error: 'Content is required' });

        const parentId = req.body.parent_id || null;
        if (parentId) {
            if (!UUID_REGEX.test(parentId)) return res.status(400).json({ error: 'Invalid parent_id' });
            const { data: parent } = await supabase
                .from('reviewer_comments')
                .select('id')
                .eq('id', parentId)
                .eq('reviewer_id', id)
                .single();
            if (!parent) return res.status(404).json({ error: 'Parent comment not found' });
        }

        const { data: comment, error } = await supabaseAdmin
            .from('reviewer_comments')
            .insert([{ reviewer_id: id, user_id: req.session.userId, parent_id: parentId, content }])
            .select(`id, content, created_at, updated_at, parent_id, users:user_id (id, username, display_name, profile_picture_url)`)
            .single();

        if (error) {
            console.error('Post comment error:', error);
            return res.status(500).json({ error: 'Failed to post comment' });
        }

        // Create notification for the reviewer owner or parent comment owner
        try {
            const { data: currentUser } = await supabaseAdmin
                .from('users')
                .select('username')
                .eq('id', req.session.userId)
                .single();

            if (parentId) {
                // Reply notification - notify parent comment owner
                const { data: parentComment } = await supabaseAdmin
                    .from('reviewer_comments')
                    .select('user_id')
                    .eq('id', parentId)
                    .single();

                if (parentComment && parentComment.user_id !== req.session.userId && currentUser) {
                    // Fetch reviewer title for context
                    const { data: reviewer } = await supabaseAdmin
                        .from('reviewers')
                        .select('title')
                        .eq('id', id)
                        .single();

                    const reviewerTitle = reviewer?.title || 'a reviewer';
                    await createNotification({
                        userId: parentComment.user_id,
                        type: 'reply',
                        title: 'New Reply',
                        message: `${currentUser.username} replied to your comment on "${reviewerTitle}"`,
                        link: `/reviewer.html?id=${id}#comment-${parentId}`,
                        relatedUserId: req.session.userId,
                        relatedItemId: comment.id
                    });
                }
            } else {
                // Comment notification - notify reviewer owner
                const { data: reviewer } = await supabaseAdmin
                    .from('reviewers')
                    .select('title, user_id')
                    .eq('id', id)
                    .single();

                if (reviewer && reviewer.user_id !== req.session.userId && currentUser) {
                    await createNotification({
                        userId: reviewer.user_id,
                        type: 'comment',
                        title: 'New Comment',
                        message: `${currentUser.username} commented on your reviewer "${reviewer.title}"`,
                        link: `/reviewer.html?id=${id}`,
                        relatedUserId: req.session.userId,
                        relatedItemId: comment.id
                    });
                }
            }
        } catch (notifErr) {
            console.error('Failed to create comment notification:', notifErr);
            // Don't fail the request if notification creation fails
        }

        res.status(201).json({
            comment: { ...comment, user: comment.users || null, reactions: {}, userReaction: null, replies: [] }
        });
    } catch (error) {
        console.error('Post comment error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/comments/:commentId  — auth required, owner only
app.delete('/api/comments/:commentId', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!UUID_REGEX.test(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });

        // Get the comment with reviewer info using admin client to bypass RLS
        const { data: comment, error: fetchError } = await supabaseAdmin
            .from('reviewer_comments')
            .select('id, user_id, reviewer_id, reviewers!inner(user_id)')
            .eq('id', commentId)
            .single();

        if (fetchError || !comment) {
            return res.status(404).json({ error: 'Comment not found' });
        }

        // Allow deletion if user is comment owner OR reviewer owner
        const isCommentOwner = comment.user_id === req.session.userId;
        const isReviewerOwner = comment.reviewers.user_id === req.session.userId;

        if (!isCommentOwner && !isReviewerOwner) {
            return res.status(403).json({ error: 'You do not have permission to delete this comment' });
        }

        // Delete the comment
        const { error: deleteError } = await supabaseAdmin
            .from('reviewer_comments')
            .delete()
            .eq('id', commentId);

        if (deleteError) throw deleteError;

        res.json({ success: true });
    } catch (error) {
        console.error('Delete comment error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/comments/:commentId/reactions  — auth required, toggle model
app.post('/api/comments/:commentId/reactions', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!UUID_REGEX.test(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });

        const VALID_REACTIONS = ['like', 'haha', 'sad', 'wow', 'heart'];
        const reactionType = req.body.reaction_type;
        if (!VALID_REACTIONS.includes(reactionType)) {
            return res.status(400).json({ error: 'Invalid reaction type' });
        }

        const { data: existing } = await supabase
            .from('reviewer_comment_reactions')
            .select('id, reaction_type')
            .eq('comment_id', commentId)
            .eq('user_id', req.session.userId)
            .maybeSingle();

        if (existing) {
            if (existing.reaction_type === reactionType) {
                await supabaseAdmin.from('reviewer_comment_reactions').delete().eq('id', existing.id);
                return res.json({ reacted: false, reaction_type: null });
            } else {
                await supabaseAdmin.from('reviewer_comment_reactions').update({ reaction_type: reactionType }).eq('id', existing.id);
                return res.json({ reacted: true, reaction_type: reactionType });
            }
        } else {
            await supabaseAdmin.from('reviewer_comment_reactions').insert([{ comment_id: commentId, user_id: req.session.userId, reaction_type: reactionType }]);
            return res.json({ reacted: true, reaction_type: reactionType });
        }
    } catch (error) {
        console.error('Comment reaction error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/comments/:commentId/reactions/:reactionType/users  — get users who reacted with specific type
app.get('/api/comments/:commentId/reactions/:reactionType/users', async (req, res) => {
    try {
        const { commentId, reactionType } = req.params;
        if (!UUID_REGEX.test(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });
        
        const VALID_REACTIONS = ['like', 'haha', 'sad', 'wow', 'heart'];
        if (!VALID_REACTIONS.includes(reactionType)) {
            return res.status(400).json({ error: 'Invalid reaction type' });
        }

        const { data: reactions, error } = await supabase
            .from('reviewer_comment_reactions')
            .select('user_id, users(id, username, display_name, profile_picture_url)')
            .eq('comment_id', commentId)
            .eq('reaction_type', reactionType)
            .order('created_at', { ascending: false })
            .limit(50);

        if (error) throw error;

        const users = reactions.map(r => r.users).filter(u => u);
        res.json({ users });
    } catch (error) {
        console.error('Get reaction users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// POST /api/comments/:commentId/pin  — auth required, reviewer owner only (toggle)
app.post('/api/comments/:commentId/pin', requireAuth, async (req, res) => {
    try {
        const { commentId } = req.params;
        if (!UUID_REGEX.test(commentId)) return res.status(400).json({ error: 'Invalid comment ID' });

        const { data: comment } = await supabase
            .from('reviewer_comments')
            .select('id, reviewer_id, is_pinned')
            .eq('id', commentId)
            .maybeSingle();

        if (!comment) return res.status(404).json({ error: 'Comment not found' });

        const { data: reviewer } = await supabase
            .from('reviewers')
            .select('id')
            .eq('id', comment.reviewer_id)
            .eq('user_id', req.session.userId)
            .maybeSingle();

        if (!reviewer) return res.status(403).json({ error: 'Not the reviewer owner' });

        const toPin = !comment.is_pinned;

        if (toPin) {
            await supabaseAdmin.from('reviewer_comments').update({ is_pinned: false }).eq('reviewer_id', comment.reviewer_id);
            await supabaseAdmin.from('reviewer_comments').update({ is_pinned: true }).eq('id', commentId);
        } else {
            await supabaseAdmin.from('reviewer_comments').update({ is_pinned: false }).eq('id', commentId);
        }

        res.json({ pinned: toPin });
    } catch (error) {
        console.error('Pin comment error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// -------------------------
// Admin moderation endpoints
// -------------------------

// Get open/all reports for moderation
app.get('/api/admin/moderation', requireModerator, async (req, res) => {
    try {
        // Load reviewer reports
        const { data: reviewerReports, error: rerr } = await supabaseAdmin
            .from('reviewer_reports')
            .select(
                '*, reviewers(id,title,user_id,subject_id), ' +
                "reporter:users!reviewer_reports_reporter_id_fkey(id,username,email), " +
                "action_user:users!reviewer_reports_action_taken_by_fkey(id,username,email)"
            )
            .or('status.eq.open,status.is.null')
            .order('created_at', { ascending: false });

        if (rerr) {
            console.error('Failed to load reviewer reports:', rerr);
            return res.status(500).json({ error: 'Failed to load reports' });
        }

        // Load chat message reports
        const { data: chatReports, error: cerr } = await supabaseAdmin
            .from('chat_reports')
            .select('*, reporter:users!chat_reports_reporter_id_fkey(id,username,email), message:messages(id, user_id, username, message, created_at)')
            .or('status.eq.open,status.is.null')
            .order('created_at', { ascending: false });

        if (cerr) {
            console.error('Failed to load chat reports:', cerr);
            return res.status(500).json({ error: 'Failed to load reports' });
        }

        // Enrich reviewer reports with reviewer owner username when possible
        const reviewerReportsWithUser = (reviewerReports || []);
        try {
            const userIds = Array.from(new Set(reviewerReportsWithUser.map(rr => rr.reviewers?.user_id).filter(Boolean)));
            if (userIds.length > 0) {
                const { data: usersData, error: uerr } = await supabaseAdmin
                    .from('users')
                    .select('id,username')
                    .in('id', userIds);

                if (!uerr && usersData) {
                    const userMap = new Map(usersData.map(u => [u.id, u]));
                    reviewerReportsWithUser.forEach(rr => {
                        const uid = rr.reviewers?.user_id;
                        if (uid && userMap.has(uid)) {
                            rr.reviewers.users = userMap.get(uid);
                        }
                    });
                }
            }
        } catch (e) {
            console.error('Error enriching reviewer reports with user data:', e);
        }

        // Normalize and combine report types for the admin UI
        const normalizedReviewer = reviewerReportsWithUser.map(r => ({ ...r, report_type: r.report_type, type: 'reviewer' }));
        const normalizedChat = (chatReports || []).map(r => ({ ...r, report_type: r.report_type, type: 'chat' }));

        const reports = normalizedReviewer.concat(normalizedChat).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));

        res.json({ reports });
    } catch (err) {
        console.error('Admin moderation list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// AI MODERATION ENGINE
// =====================================================

/**
 * Core AI moderation function.
 * Analyses content against platform policies and returns a structured verdict.
 * Uses Puter.js (Claude) for zero-configuration, no-API-key AI moderation.
 */
async function runAiModeration({ contentType, content, username, reportType, reportDetails, policies }) {
    const policyText = (policies || [])
        .map((p, i) => `  ${i + 1}. [${p.category || 'general'}] ${p.title}: ${p.description}`)
        .join('\n');

    const reportContext = [
        reportType   ? `- Report Type Filed: ${reportType}`          : '',
        reportDetails ? `- Reporter Description: ${reportDetails}` : ''
    ].filter(Boolean).join('\n');

    const prompt = `You are the professional content moderation AI for Thinky, an educational platform for students. Your responsibility is to impartially, consistently, and fairly evaluate content against the platform's Community Standards and recommend enforcement actions.

You MUST base every decision strictly on the listed policies — not personal opinion, cultural bias, or subjective preference. When in doubt, recommend the less severe action and defer to human review.

=== THINKY COMMUNITY STANDARDS ===
${policyText || '  1. No hate speech, discrimination, or targeted harassment\n  2. No explicit, offensive, or age-inappropriate content\n  3. No spam, flooding, or repeated unsolicited messages\n  4. All content must be educational, constructive, and respectful\n  5. No promotion of illegal activity, self-harm, violence, or threats'}

=== CONTENT UNDER MODERATION REVIEW ===
Content Type      : ${contentType}
Author            : ${username || 'Unknown'}
${reportContext ? 'Report Context:\n' + reportContext : '(Proactive AI scan — no specific report filed)'}

--- BEGIN CONTENT ---
${String(content || '').slice(0, 10000)}
--- END CONTENT ---

=== MODERATION INSTRUCTIONS ===
1. Read the entire content carefully and holistically.
2. Compare against EACH policy listed above, citing specific policy numbers where applicable.
3. Be fair — academic debate, criticism, and strong language in educational context must not be over-penalised.
4. Context matters: a quoted slur in an academic analysis differs fundamentally from a targeted slur.
5. For study reviewers / notes: violations are restricted to harassment of named individuals, explicitly harmful non-academic material, severe hate speech, or promotion of illegal activity.
6. For chat messages: apply stricter enforcement for direct threats, targeted attacks, doxxing, or explicit content.
7. Do NOT flag content solely for being opinionated, controversial, or uncomfortable — educational discourse requires free inquiry.
8. False/malicious reports are common; if the content appears clearly benign, recommend dismiss with high confidence.

=== REQUIRED JSON RESPONSE ===
Return ONLY a valid JSON object — no markdown, no commentary:

{
  "violation_found": true | false,
  "severity": "none" | "low" | "medium" | "high" | "critical",
  "policies_violated": ["exact policy title(s) from the list above"],
  "violations_summary": "One to two factual sentences describing what was found, or 'No policy violations detected.'",
  "recommended_action": "dismiss" | "warn_message" | "warn_reviewer" | "mute" | "delete_message" | "delete_content" | "ban_chat" | "suspend_author",
  "reasoning": "Detailed, professional 3-5 sentence justification citing specific policies and content passages. Must be suitable for inclusion in a formal moderation log.",
  "confidence": 0.0,
  "auto_apply": false
}

=== SEVERITY AND ACTION GUIDELINES ===
severity   | situation                                          | action (message)       | action (reviewer)    | auto_apply threshold
-----------|----------------------------------------------------|-----------------------|-----------------------|---------------------
none       | No violation — benign content or false report      | dismiss                | dismiss               | conf >= 0.90
low        | Minor rudeness, mild community standard breach     | warn_message           | warn_reviewer         | never (human review)
medium     | Repeated harassment, explicit personal attacks      | delete_message         | delete_content        | never (human review)
high       | Targeted threats, hate speech, severe harassment   | mute                   | suspend_author        | never (human review)
critical   | Doxxing, CSAM-adjacent, calls to violence          | ban_chat               | suspend_author        | conf >= 0.96

IMPORTANT: When confidence < 0.80, set auto_apply to false regardless of severity. Final enforcement authority rests with human moderators.

Return ONLY the JSON object. No other text.`;

    return await callPuter(prompt, true);
}

/**
 * Background auto-moderation for newly created/updated reviewers (and report-triggered re-scans).
 * Fire-and-forget — never throws. Auto-hides only at critical severity with very high confidence.
 * Flags lower severity violations by inserting an open reviewer_report for human review.
 */
async function autoModerateReviewer(reviewerId, { title, content, username, reportType, reportDetails } = {}) {
    try {
        if (getGeminiApiKeys().length === 0) return;

        const { data: policies } = await supabaseAdmin.from('policies').select('*').order('id');
        const plainContent = `Title: ${title || 'Untitled'}\n\nContent:\n${(content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`;
        const scanLabel = reportType ? 'report-triggered scan' : 'proactive upload scan';

        const aiResult = await runAiModeration({
            contentType: `reviewer (study notes — ${scanLabel})`,
            content: plainContent,
            username: username || 'Unknown',
            reportType: reportType || null,
            reportDetails: reportDetails || null,
            policies: policies || []
        });

        if (!aiResult || !aiResult.violation_found) return;

        const logNote = `[AI Auto-Review] Severity: ${aiResult.severity}. ${aiResult.violations_summary} Recommended: ${aiResult.recommended_action}. Confidence: ${Math.round((aiResult.confidence || 0) * 100)}%. Reasoning: ${aiResult.reasoning}`;

        if (aiResult.auto_apply && aiResult.severity === 'critical' && (aiResult.confidence || 0) >= 0.96) {
            await supabaseAdmin.from('reviewers').update({ is_public: false }).eq('id', reviewerId);
            await supabaseAdmin.from('reviewer_reports').insert([{
                reviewer_id: reviewerId,
                reporter_id: null,
                report_type: 'ai_auto_moderation',
                details: logNote,
                status: 'resolved',
                action_taken: 'hide_content (ai_auto)',
                action_taken_at: new Date().toISOString(),
                resolved_at: new Date().toISOString()
            }]).catch(e => console.warn('[AI Mod] auto-mod report insert failed', e));
            console.info(`[AI Moderation] Auto-hid reviewer ${reviewerId} — severity: ${aiResult.severity}, confidence: ${aiResult.confidence}`);
        } else {
            // Flag for human moderators
            await supabaseAdmin.from('reviewer_reports').insert([{
                reviewer_id: reviewerId,
                reporter_id: null,
                report_type: 'ai_flagged',
                details: logNote,
                status: 'open'
            }]).catch(e => console.warn('[AI Mod] flag report insert failed', e));
            console.info(`[AI Moderation] Flagged reviewer ${reviewerId} for human review — severity: ${aiResult.severity}, conf: ${aiResult.confidence}`);
        }
    } catch (err) {
        console.warn('[AI Moderation] Background reviewer scan failed:', err && err.message);
    }
}

/**
 * Background auto-moderation for chat messages (new posts and report-triggered scans).
 * Fire-and-forget — never throws. Auto-deletes only at critical severity + high confidence.
 * Flags lower severity violations by inserting an open chat_report for human review.
 */
async function autoModerateMessage(messageId, { content, username, chatType, reportType, reportDetails } = {}) {
    try {
        const keys = getGeminiApiKeys();
        console.info(`[AI Mod] autoModerateMessage invoked for message ${messageId} — Gemini keys present: ${keys.length > 0}`);
        if (keys.length === 0) {
            console.info('[AI Mod] Skipping AI moderation: no Gemini API keys configured');
            return;
        }

        const { data: policies } = await supabaseAdmin.from('policies').select('*').order('id');
        const scanLabel = reportType ? 'report-triggered scan' : 'proactive scan';

        const aiResult = await runAiModeration({
            contentType: `chat message (${chatType || 'general'} — ${scanLabel})`,
            content: String(content || ''),
            username: username || 'Unknown',
            reportType: reportType || null,
            reportDetails: reportDetails || null,
            policies: policies || []
        });

        try {
            console.info('[AI Mod] autoModerateMessage verdict:', {
                messageId,
                violation_found: !!aiResult?.violation_found,
                severity: aiResult?.severity || 'none',
                confidence: typeof aiResult?.confidence === 'number' ? aiResult.confidence : null,
                recommended_action: aiResult?.recommended_action || null,
                auto_apply: !!aiResult?.auto_apply
            });
        } catch (logErr) { /* ignore logging errors */ }

        if (!aiResult || !aiResult.violation_found) {
            console.info(`[AI Mod] No violation detected for message ${messageId}; skipping action.`);
            return;
        }

        const logNote = `[AI Auto-Review] Severity: ${aiResult.severity}. ${aiResult.violations_summary} Recommended: ${aiResult.recommended_action}. Confidence: ${Math.round((aiResult.confidence || 0) * 100)}%. Reasoning: ${aiResult.reasoning}`;

        if (aiResult.auto_apply && aiResult.severity === 'critical' && (aiResult.confidence || 0) >= 0.96) {
            await supabaseAdmin.from('messages').delete().eq('id', messageId);
            await supabaseAdmin.from('chat_reports').insert([{
                message_id: messageId,
                reporter_id: null,
                report_type: 'ai_auto_moderation',
                details: logNote,
                status: 'resolved',
                handled_by: null,
                handled_at: new Date().toISOString()
            }]).catch(e => console.warn('[AI Mod] chat auto-mod insert failed', e));
            console.info(`[AI Moderation] Auto-deleted message ${messageId} — severity: ${aiResult.severity}, confidence: ${aiResult.confidence}`);
        } else {
            // Flag for human moderators
            await supabaseAdmin.from('chat_reports').insert([{
                message_id: messageId,
                reporter_id: null,
                report_type: 'ai_flagged',
                details: logNote,
                status: 'open'
            }]).catch(e => console.warn('[AI Mod] chat flag insert failed', e));
            console.info(`[AI Moderation] Flagged message ${messageId} for human review — severity: ${aiResult.severity}, conf: ${aiResult.confidence}`);
        }
    } catch (err) {
        console.warn('[AI Moderation] Background message scan failed:', err && err.message ? err.message : err);
    }
}

// POST /api/admin/moderation/ai-review
// Returns AI moderation verdict for a specific report, reviewer, or message.
// Admin/moderator only — does NOT auto-apply any action.
app.post('/api/admin/moderation/ai-review', requireModerator, async (req, res) => {
    try {
        if (getGeminiApiKeys().length === 0) {
            return res.status(503).json({ error: 'AI moderation is not configured — no Gemini API key found.' });
        }

        const { reportId, reviewerId, messageId } = req.body;
        if (!reportId && !reviewerId && !messageId) {
            return res.status(400).json({ error: 'One of reportId, reviewerId, or messageId is required.' });
        }

        const { data: policies } = await supabaseAdmin.from('policies').select('*').order('id');

        let content = '', contentType = '', username = '', reportType = '', reportDetails = '';
        let resolvedReportId = reportId || null;
        let resolvedReviewerId = reviewerId || null;
        let resolvedMessageId = messageId || null;

        if (reportId) {
            // Try reviewer_reports first
            const { data: rr } = await supabaseAdmin
                .from('reviewer_reports')
                .select('*, reviewers(id, title, content, user_id, users:user_id(username))')
                .eq('id', reportId)
                .single();

            if (rr && rr.reviewers) {
                const rev = rr.reviewers;
                resolvedReviewerId = rev.id;
                contentType = 'reviewer (study notes)';
                content = `Title: ${rev.title || 'Untitled'}\n\nContent:\n${(rev.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`;
                username = rev.users?.username || 'Unknown';
                reportType = rr.report_type;
                reportDetails = rr.details || '';
            } else {
                // Try chat_reports
                const { data: cr } = await supabaseAdmin
                    .from('chat_reports')
                    .select('*, message:messages(id, user_id, username, message, users:user_id(username))')
                    .eq('id', reportId)
                    .single();

                if (!cr) return res.status(404).json({ error: 'Report not found.' });

                const msg = cr.message || {};
                resolvedMessageId = msg.id || null;
                contentType = 'chat message';
                content = msg.message || '';
                username = msg.username || msg.users?.username || 'Unknown';
                reportType = cr.report_type;
                reportDetails = cr.details || '';
            }
        } else if (reviewerId) {
            const { data: rev, error: revErr } = await supabaseAdmin
                .from('reviewers')
                .select('id, title, content, user_id, users:user_id(username)')
                .eq('id', reviewerId)
                .single();
            if (revErr || !rev) return res.status(404).json({ error: 'Reviewer not found.' });
            contentType = 'reviewer (study notes)';
            content = `Title: ${rev.title || 'Untitled'}\n\nContent:\n${(rev.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`;
            username = rev.users?.username || 'Unknown';
        } else if (messageId) {
            const { data: msg, error: msgErr } = await supabaseAdmin
                .from('messages')
                .select('id, user_id, username, message, users:user_id(username)')
                .eq('id', messageId)
                .single();
            if (msgErr || !msg) return res.status(404).json({ error: 'Message not found.' });
            contentType = 'chat message';
            content = msg.message || '';
            username = msg.username || msg.users?.username || 'Unknown';
        }

        const aiResult = await runAiModeration({ contentType, content, username, reportType, reportDetails, policies: policies || [] });

        res.json({
            ok: true,
            result: aiResult,
            meta: { reportId: resolvedReportId, reviewerId: resolvedReviewerId, messageId: resolvedMessageId }
        });
    } catch (err) {
        console.error('[AI Moderation] ai-review endpoint error:', err);
        res.status(500).json({ error: 'AI moderation failed: ' + (err.message || 'Unknown error') });
    }
});

// POST /api/admin/moderation/ai-apply
// Applies an AI-recommended action. For reports, delegates to the existing action endpoint.
// For unreported content (reviewer/message only), applies action directly and logs it.
app.post('/api/admin/moderation/ai-apply', requireModerator, async (req, res) => {
    try {
        const { reportId, reviewerId, messageId, action, note } = req.body;
        const adminId = req.session.userId;
        if (!action) return res.status(400).json({ error: 'action is required' });

        if (reportId) {
            // Delegate to the existing action handler by calling it internally
            const port = process.env.PORT || 3000;
            const actionResp = await fetch(`http://127.0.0.1:${port}/api/admin/moderation/${encodeURIComponent(reportId)}/action`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    'Cookie': req.headers.cookie || ''
                },
                body: JSON.stringify({ action, note: note || `AI-recommended: ${action}` })
            });
            const data = await actionResp.json().catch(() => ({}));
            return res.status(actionResp.status).json(data);
        }

        // Direct action on unreported reviewer content
        if (reviewerId) {
            const logNote = note || `AI moderator applied: ${action}`;
            if (action === 'delete_content') {
                const { error } = await supabaseAdmin.from('reviewers').delete().eq('id', reviewerId);
                if (error) return res.status(500).json({ error: 'Failed to delete reviewer: ' + error.message });
            } else if (action === 'hide_content' || action === 'warn_reviewer') {
                if (action === 'hide_content') {
                    const { error } = await supabaseAdmin.from('reviewers').update({ is_public: false }).eq('id', reviewerId);
                    if (error) return res.status(500).json({ error: 'Failed to hide reviewer: ' + error.message });
                }
            } else {
                return res.status(400).json({ error: `Action '${action}' is not valid for an unreported reviewer.` });
            }
            await supabaseAdmin.from('reviewer_reports').insert([{
                reviewer_id: reviewerId,
                reporter_id: null,
                report_type: 'ai_moderation',
                details: logNote,
                status: 'resolved',
                action_taken_by: adminId,
                action_taken: `ai_applied:${action}`,
                action_taken_at: new Date().toISOString(),
                resolved_at: new Date().toISOString()
            }]).catch(e => console.warn('[AI Mod] reviewer log insert failed', e));
            return res.json({ ok: true });
        }

        // Direct action on unreported message
        if (messageId) {
            const logNote = note || `AI moderator applied: ${action}`;
            if (action === 'delete_message') {
                const { error } = await supabaseAdmin.from('messages').delete().eq('id', messageId);
                if (error) return res.status(500).json({ error: 'Failed to delete message: ' + error.message });
            } else if (action !== 'warn_message') {
                return res.status(400).json({ error: `Action '${action}' is not valid for an unreported message.` });
            }
            await supabaseAdmin.from('chat_reports').insert([{
                message_id: messageId,
                reporter_id: null,
                report_type: 'ai_moderation',
                details: logNote,
                status: 'resolved',
                handled_by: adminId,
                handled_at: new Date().toISOString()
            }]).catch(e => console.warn('[AI Mod] message log insert failed', e));
            return res.json({ ok: true });
        }

        return res.status(400).json({ error: 'No valid action target provided (reportId, reviewerId, or messageId required).' });
    } catch (err) {
        console.error('[AI Moderation] ai-apply endpoint error:', err);
        res.status(500).json({ error: 'Failed to apply AI moderation action.' });
    }
});

// GET /api/admin/ai-actions
// Returns all AI-generated moderation records (reporter_id IS NULL) from both tables.
// Supports ?type=all|message|reviewer  and  ?status=all|open|resolved
app.get('/api/admin/ai-actions', requireModerator, async (req, res) => {
    try {
        const type = req.query.type || 'all';
        const status = req.query.status || 'all';
        const AI_TYPES = ['ai_auto_moderation', 'ai_flagged', 'ai_moderation'];
        let results = [];

        if (type === 'all' || type === 'message') {
            let q = supabaseAdmin
                .from('chat_reports')
                .select('*, message:messages(id, user_id, username, message, chat_type, users:user_id(username, profile_picture_url))')
                .is('reporter_id', null)
                .in('report_type', AI_TYPES);
            if (status !== 'all') q = q.eq('status', status);
            const { data } = await q.order('created_at', { ascending: false }).limit(300);
            if (data) results.push(...data.map(r => ({ ...r, _type: 'message' })));
        }

        if (type === 'all' || type === 'reviewer') {
            let q = supabaseAdmin
                .from('reviewer_reports')
                .select('*, reviewers(id, title, content, user_id, users:user_id(username, profile_picture_url))')
                .is('reporter_id', null)
                .in('report_type', AI_TYPES);
            if (status !== 'all') q = q.eq('status', status);
            const { data } = await q.order('created_at', { ascending: false }).limit(300);
            if (data) results.push(...data.map(r => ({ ...r, _type: 'reviewer' })));
        }

        results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json({ actions: results });
    } catch (err) {
        console.error('[AI Actions] Failed to fetch ai-actions:', err);
        res.status(500).json({ error: 'Failed to fetch AI actions' });
    }
});

// Take action on a report
app.put('/api/admin/moderation/:id/action', requireModerator, async (req, res) => {
    try {
        const reportId = req.params.id;
        const adminId = req.session.userId;
        const { action, until, note } = req.body; // action: ban|restrict|delete_user|dismiss

        // Load report (try reviewer_reports first, then chat_reports)
        let rdata = null;
        let reportTable = null;

        const { data: rr, error: rerr } = await supabaseAdmin
            .from('reviewer_reports')
            .select('*')
            .eq('id', reportId)
            .single();

        if (rerr || !rr) {
            // try chat_reports
            const { data: cr, error: cerr } = await supabaseAdmin
                .from('chat_reports')
                .select('*')
                .eq('id', reportId)
                .single();
            if (cerr || !cr) return res.status(404).json({ error: 'Report not found' });
            rdata = cr;
            reportTable = 'chat_reports';
        } else {
            rdata = rr;
            reportTable = 'reviewer_reports';
        }

        let reportedUserId = null;
        let rev = null;
        // If reviewer report, load reviewer to get reported user
        if (reportTable === 'reviewer_reports') {
            const { data: revData, error: revErr } = await supabaseAdmin
                .from('reviewers')
                .select('*')
                .eq('id', rdata.reviewer_id)
                .single();
            if (revErr || !revData) return res.status(404).json({ error: 'Reviewer not found' });
            rev = revData;
            reportedUserId = rev.user_id;
        } else {
            // chat report: load referenced message to find reported user
            const { data: msg, error: msgErr } = await supabaseAdmin
                .from('messages')
                .select('*')
                .eq('id', rdata.message_id)
                .single();
            if (msgErr || !msg) return res.status(404).json({ error: 'Reported message not found' });
            reportedUserId = msg.user_id;
            rev = null;
        }

        // Perform actions
        // Interpret empty/undefined/blank 'until' as permanent (far-future) for ban/restrict/mute
        const farFuture = new Date(); farFuture.setFullYear(farFuture.getFullYear() + 100);
        let effectiveUntil = null;
        if (['ban', 'restrict', 'mute', 'ban_chat', 'suspend_author', 'hide_content'].includes(action)) {
            if (typeof until === 'string' && until.trim() !== '') {
                effectiveUntil = until;
            } else if (action === 'hide_content' || action === 'suspend_author') {
                // for hide/suspend, require an until value
                effectiveUntil = farFuture.toISOString();
            } else {
                // treat blank/undefined/null as permanent for ban/mute
                effectiveUntil = farFuture.toISOString();
            }
        }

        // Validate effectiveUntil is a valid date string; if not, treat as permanent
        if (effectiveUntil) {
            const parsed = new Date(effectiveUntil);
            if (isNaN(parsed.getTime())) {
                console.warn('Invalid until value provided for moderation action, treating as permanent:', effectiveUntil);
                effectiveUntil = farFuture.toISOString();
            }
        }

        // Message moderation actions (only for chat_reports)
        if (reportTable === 'chat_reports') {
            if (action === 'delete_message') {
                // Delete the message
                await supabaseAdmin.from('messages').delete().eq('id', rdata.message_id);
            } else if (action === 'mute') {
                // Mute user from chat temporarily - use chat_muted_until for temporary chat restrictions
                await supabaseAdmin.from('users').update({ chat_muted_until: effectiveUntil }).eq('id', reportedUserId);
            } else if (action === 'ban_chat') {
                // Ban user completely from the platform (account-level ban)
                await supabaseAdmin.from('users').update({ banned_until: effectiveUntil }).eq('id', reportedUserId);
            } else if (action === 'warn_message') {
                // Warning - no database action needed, email will be sent
            } else if (!['dismiss', 'ban', 'restrict', 'delete_user'].includes(action)) {
                // Invalid action for chat reports
                console.warn(`Invalid action '${action}' for chat report`);
            }
        }
        // Reviewer moderation actions (only for reviewer_reports)
        else if (reportTable === 'reviewer_reports') {
            if (action === 'hide_content') {
                // Hide reviewer (make it private)
                await supabaseAdmin.from('reviewers').update({ is_public: false }).eq('id', rdata.reviewer_id);
            } else if (action === 'delete_content') {
                // Delete reviewer
                await supabaseAdmin.from('reviewers').delete().eq('id', rdata.reviewer_id);
            } else if (action === 'suspend_author') {
                // Suspend user from creating content
                await supabaseAdmin.from('users').update({ blocked_from_creating_until: effectiveUntil }).eq('id', reportedUserId);
            } else if (action === 'warn_reviewer') {
                // Warning - no database action needed, email will be sent
            } else if (!['dismiss', 'ban', 'restrict', 'delete_user'].includes(action)) {
                // Invalid action for reviewer reports
                console.warn(`Invalid action '${action}' for reviewer report`);
            }
        }
        // Legacy actions for backward compatibility
        else if (action === 'ban') {
            await supabaseAdmin.from('users').update({ banned_until: effectiveUntil }).eq('id', reportedUserId);
        } else if (action === 'restrict') {
            await supabaseAdmin.from('users').update({ blocked_from_creating_until: effectiveUntil }).eq('id', reportedUserId);
        } else if (action === 'delete_user') {
            // Delete user and cascade reviews
            await supabaseAdmin.from('users').delete().eq('id', reportedUserId);
        }

        // Mark report resolved — use appropriate columns per report table
        const actionTakenAt = new Date().toISOString();
        let update = null;
        if (reportTable === 'chat_reports') {
            // chat_reports schema uses handled_by/handled_at
            update = {
                status: action === 'dismiss' ? 'dismissed' : 'resolved',
                handled_by: adminId,
                handled_at: actionTakenAt
            };
            if (note) {
                try {
                    const existing = rdata && rdata.details ? String(rdata.details) : '';
                    update.details = existing ? (existing + '\n\nAction: ' + note) : note;
                } catch (_) {}
            }
        } else {
            // reviewer_reports uses action_taken_* columns
            update = {
                status: action === 'dismiss' ? 'dismissed' : 'resolved',
                action_taken_by: adminId,
                action_taken: action + (note ? (' - ' + note) : ''),
                action_taken_at: actionTakenAt,
                resolved_at: actionTakenAt
            };
        }

        const { data: updatedReport, error: updateError } = await supabaseAdmin.from(reportTable).update(update).eq('id', reportId).select().single();
        if (updateError) {
            console.error('Failed to update report status:', updateError);
            return res.status(500).json({ error: 'Failed to update report status' });
        }

        // Notify reporter and reported user by email (best-effort)
        try {
            const reporter = rdata.reporter_id;
            // fetch emails (use admin client)
            const { data: reportedUser } = await supabaseAdmin.from('users').select('email,username').eq('id', reportedUserId).single();
            const { data: reporterUser } = await supabaseAdmin.from('users').select('email,username').eq('id', rdata.reporter_id).single();

            const reason = note || '';
            const contentType = reportTable === 'chat_reports' ? 'message' : 'reviewer content';
            let decision = 'No action taken';
            
            if (action === 'dismiss') {
                decision = 'No action taken - report dismissed';
            }
            // Message moderation decisions
            else if (action === 'delete_message') {
                decision = 'Message removed from chat';
            } else if (action === 'mute') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    const now = new Date();
                    if (!isNaN(dt.getTime()) && (dt.getFullYear() - now.getFullYear()) >= 50) {
                        decision = 'Permanently muted from chat';
                    } else if (!isNaN(dt.getTime())) {
                        decision = `Muted from chat until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Muted from chat';
                    }
                } else {
                    decision = 'Muted from chat';
                }
            } else if (action === 'ban_chat') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    const now = new Date();
                    if (!isNaN(dt.getTime()) && (dt.getFullYear() - now.getFullYear()) >= 50) {
                        decision = 'Permanently banned from platform';
                    } else if (!isNaN(dt.getTime())) {
                        decision = `Banned from platform until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Banned from platform';
                    }
                } else {
                    decision = 'Banned from platform';
                }
            } else if (action === 'warn_message') {
                decision = 'Warning issued for chat message';
            }
            // Reviewer moderation decisions
            else if (action === 'hide_content') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    const now = new Date();
                    if (!isNaN(dt.getTime()) && (dt.getFullYear() - now.getFullYear()) >= 50) {
                        decision = 'Content hidden permanently';
                    } else if (!isNaN(dt.getTime())) {
                        decision = `Content hidden until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Content hidden';
                    }
                } else {
                    decision = 'Content hidden';
                }
            } else if (action === 'delete_content') {
                decision = 'Content permanently deleted';
            } else if (action === 'suspend_author') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    const now = new Date();
                    if (!isNaN(dt.getTime()) && (dt.getFullYear() - now.getFullYear()) >= 50) {
                        decision = 'Permanently suspended from creating content';
                    } else if (!isNaN(dt.getTime())) {
                        decision = `Suspended from creating content until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Suspended from creating content';
                    }
                } else {
                    decision = 'Suspended from creating content';
                }
            } else if (action === 'warn_reviewer') {
                decision = 'Warning issued for content violation';
            }
            // Legacy actions
            else if (action === 'delete_user') {
                decision = 'Account deleted';
            } else if (action === 'ban') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    const now = new Date();
                    if (!isNaN(dt.getTime()) && (dt.getFullYear() - now.getFullYear()) >= 50) {
                        decision = 'Permanently banned';
                    } else if (!isNaN(dt.getTime())) {
                        decision = `Banned until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Banned';
                    }
                } else {
                    decision = 'Banned';
                }
            } else if (action === 'restrict') {
                if (effectiveUntil) {
                    const dt = new Date(effectiveUntil);
                    if (!isNaN(dt.getTime())) {
                        decision = `Restricted from posting until ${dt.toLocaleString()}`;
                    } else {
                        decision = 'Restricted from posting';
                    }
                } else {
                    decision = 'Restricted from posting';
                }
            }

            if (reportedUser && reportedUser.email) {
                // Notify the reported user with clear explanation and next steps
                sendTemplatedEmail({
                    to: reportedUser.email,
                    subject: 'Moderation decision regarding your content on Thinky',
                    template: 'moderation_decision_reported',
                    variables: {
                        decision,
                        reason,
                        reportedUser: reportedUser.username || '',
                        reviewerTitle: rev ? (rev.title || '') : '',
                        actionTakenAt
                    }
                });
            }
            if (reporterUser && reporterUser.email) {
                // Notify the reporter thanking them and summarizing the outcome
                // DO NOT include reporter name for safety
                sendTemplatedEmail({
                    to: reporterUser.email,
                    subject: 'Update on your report to Thinky moderation',
                    template: 'moderation_decision_reporter',
                    variables: {
                        decision,
                        reason,
                        contentType: reportTable === 'chat_reports' ? 'message' : 'content',
                        reviewerTitle: rev ? (rev.title || '') : '',
                        actionTakenAt
                    }
                });
            }
        } catch (e) {
            console.warn('Failed to send moderation emails', e);
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('Moderation action error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// CHAT ROUTES
// =====================================================

// Get private inbox messages addressed to current user (supports since)
// MUST come before /api/messages/:chatType to match first
app.get('/api/messages/private-inbox', requireAuth, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 100;
        const since = req.query.since || null;

        // Get all hidden conversations for this user
        const { data: hiddenConvos } = await supabaseAdmin
            .from('hidden_conversations')
            .select('other_user_id, hidden_at')
            .eq('user_id', req.session.userId);
        
        const hiddenMap = (hiddenConvos || []).reduce((acc, h) => {
            acc[h.other_user_id] = new Date(h.hidden_at);
            return acc;
        }, {});

        let q = supabaseAdmin
            .from('messages')
            .select('*, users:user_id (username, profile_picture_url)')
            .eq('chat_type', 'private')
            .eq('recipient_id', req.session.userId)
            .order('created_at', { ascending: false })
            .limit(limit);

        if (since) q = q.gt('created_at', since);

        const { data: messages, error } = await q;
        if (error) {
            console.error('Get private-inbox messages error:', error);
            return res.status(500).json({ error: 'Failed to fetch private messages' });
        }

        // Filter out messages from hidden conversations (older than hidden_at)
        const filteredMessages = messages.filter(msg => {
            const hiddenAt = hiddenMap[msg.user_id];
            if (!hiddenAt) return true;
            return new Date(msg.created_at) > hiddenAt;
        });

        try {
            const msgs = filteredMessages.reverse();
            const replyIds = msgs.map(m => m.reply_to).filter(Boolean);
            if (replyIds.length > 0) {
                const { data: replies } = await supabaseAdmin.from('messages').select('id, message, user_id, username').in('id', replyIds);
                const map = (replies || []).reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
                msgs.forEach(m => { if (m.reply_to && map[m.reply_to]) m.reply_to_meta = map[m.reply_to]; });
            }

            // For anonymous messages, avoid leaking the real user's joined `users` data
            // to other users. Keep profile info for the message sender only.
            for (const m of msgs) {
                try {
                    const maybeAnon = (m && (m.is_anonymous === true));
                    const fallbackAnon = (m && m.username && String(m.username) === generateAnonName(m.user_id));
                    if (maybeAnon || fallbackAnon) {
                        if (String(m.user_id) !== String(req.session.userId)) {
                            if (m.users) {
                                delete m.users.profile_picture_url;
                                delete m.users.username;
                            }
                        }
                    }
                } catch (e) { /* ignore */ }
            }

            return res.json({ messages: msgs });
        } catch (e) {
            return res.json({ messages: filteredMessages.reverse() });
        }
    } catch (error) {
        console.error('Get private-inbox messages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

const ALLOWED_MESSAGE_REACTIONS = new Set(['like', 'love', 'haha', 'sad', 'wow', 'angry']);

// Get reactions summary for one or more message IDs
// Example: /api/messages/reactions?ids=<id1>,<id2>
app.get('/api/messages/reactions', requireAuth, async (req, res) => {
    try {
        const raw = String(req.query.ids || '');
        const ids = [...new Set(raw.split(',').map(s => String(s || '').trim()).filter(Boolean))].slice(0, 300);

        if (ids.length === 0) {
            return res.json({ reactionsByMessage: {}, userReactions: {} });
        }

        const { data, error } = await supabaseAdmin
            .from('message_reactions')
            .select('message_id, user_id, reaction_type')
            .in('message_id', ids);

        if (error) {
            const msg = String(error.message || '');
            if (msg.includes('message_reactions')) {
                // Backward compatibility if migration has not been applied yet
                return res.json({ reactionsByMessage: {}, userReactions: {} });
            }
            console.error('Get message reactions error:', error);
            return res.status(500).json({ error: 'Failed to fetch message reactions' });
        }

        const reactionsByMessage = {};
        const userReactions = {};

        for (const id of ids) reactionsByMessage[id] = {};

        for (const row of (data || [])) {
            if (!reactionsByMessage[row.message_id]) reactionsByMessage[row.message_id] = {};
            const prev = reactionsByMessage[row.message_id][row.reaction_type] || 0;
            reactionsByMessage[row.message_id][row.reaction_type] = prev + 1;

            if (String(row.user_id) === String(req.session.userId)) {
                userReactions[row.message_id] = row.reaction_type;
            }
        }

        return res.json({ reactionsByMessage, userReactions });
    } catch (error) {
        console.error('Get message reactions error:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Get users for a specific reaction on a specific message
// Example: /api/messages/<messageId>/reactions/like/users
app.get('/api/messages/:id/reactions/:reactionType/users', requireAuth, async (req, res) => {
    try {
        const messageId = String(req.params.id || '').trim();
        const reactionType = String(req.params.reactionType || '').trim().toLowerCase();

        if (!messageId) return res.status(400).json({ error: 'Message ID is required' });
        if (!ALLOWED_MESSAGE_REACTIONS.has(reactionType)) {
            return res.status(400).json({ error: 'Invalid reaction type' });
        }

        const { data: message, error: msgError } = await supabaseAdmin
            .from('messages')
            .select('id, user_id, recipient_id, chat_type')
            .eq('id', messageId)
            .single();

        if (msgError || !message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        // Access guard for private messages: only participants can view reactor list.
        if (message.chat_type === 'private') {
            const isParticipant = String(message.user_id) === String(req.session.userId)
                || String(message.recipient_id) === String(req.session.userId);
            if (!isParticipant) return res.status(403).json({ error: 'Not allowed' });
        }

        const { data: reactions, error } = await supabaseAdmin
            .from('message_reactions')
            .select('user_id, users(id, username, display_name, profile_picture_url)')
            .eq('message_id', messageId)
            .eq('reaction_type', reactionType)
            .order('created_at', { ascending: false })
            .limit(80);

        if (error) {
            const msg = String(error.message || '');
            if (msg.includes('message_reactions')) {
                // Backward compatibility if migration is missing.
                return res.json({ users: [] });
            }
            console.error('Get message reaction users error:', error);
            return res.status(500).json({ error: 'Failed to fetch reaction users' });
        }

        const users = Array.isArray(reactions)
            ? reactions.map((r) => r && r.users).filter(Boolean)
            : [];

        return res.json({ users });
    } catch (error) {
        console.error('Get message reaction users error:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Toggle/update a message reaction for current user
app.post('/api/messages/:id/reactions', requireAuth, async (req, res) => {
    try {
        const messageId = req.params.id;
        const reactionType = String((req.body && req.body.reaction) || '').trim().toLowerCase();

        if (!ALLOWED_MESSAGE_REACTIONS.has(reactionType)) {
            return res.status(400).json({ error: 'Invalid reaction type' });
        }

        const { data: message, error: msgError } = await supabaseAdmin
            .from('messages')
            .select('id, user_id, recipient_id, chat_type')
            .eq('id', messageId)
            .single();

        if (msgError || !message) {
            return res.status(404).json({ error: 'Message not found' });
        }

        // Access guard for private messages
        if (message.chat_type === 'private') {
            const isParticipant = String(message.user_id) === String(req.session.userId)
                || String(message.recipient_id) === String(req.session.userId);
            if (!isParticipant) return res.status(403).json({ error: 'Not allowed' });
        }

        const { data: existing, error: existingError } = await supabaseAdmin
            .from('message_reactions')
            .select('id, reaction_type')
            .eq('message_id', messageId)
            .eq('user_id', req.session.userId)
            .maybeSingle();

        if (existingError) {
            const msg = String(existingError.message || '');
            if (msg.includes('message_reactions')) {
                return res.status(503).json({ error: 'Message reactions unavailable. Please run latest database migrations.' });
            }
            console.error('Get existing message reaction error:', existingError);
            return res.status(500).json({ error: 'Failed to update reaction' });
        }

        // Toggle off when same reaction is clicked again
        if (existing && existing.reaction_type === reactionType) {
            const { error: delError } = await supabaseAdmin
                .from('message_reactions')
                .delete()
                .eq('id', existing.id);

            if (delError) {
                console.error('Delete message reaction error:', delError);
                return res.status(500).json({ error: 'Failed to update reaction' });
            }

            return res.json({ success: true, reaction: null, toggledOff: true });
        }

        if (existing) {
            const { error: updError } = await supabaseAdmin
                .from('message_reactions')
                .update({ reaction_type: reactionType })
                .eq('id', existing.id);

            if (updError) {
                console.error('Update message reaction error:', updError);
                return res.status(500).json({ error: 'Failed to update reaction' });
            }
        } else {
            const { error: insError } = await supabaseAdmin
                .from('message_reactions')
                .insert([{ message_id: messageId, user_id: req.session.userId, reaction_type: reactionType }]);

            if (insError) {
                console.error('Insert message reaction error:', insError);
                return res.status(500).json({ error: 'Failed to update reaction' });
            }
        }

        return res.json({ success: true, reaction: reactionType, toggledOff: false });
    } catch (error) {
        console.error('Toggle message reaction error:', error);
        return res.status(500).json({ error: 'Server error' });
    }
});

// Get messages
app.get('/api/messages/:chatType', requireAuth, async (req, res) => {
    try {
        const { chatType } = req.params;
        const limit = parseInt(req.query.limit) || 100;
        const before = req.query.before || null; // Message ID to paginate before

        let query;
        if (chatType === 'private') {
            const other = req.query.with;
            if (!other) return res.status(400).json({ error: 'Missing "with" query param for private chat' });

            // Validate UUIDs to prevent injection
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(req.session.userId) || !uuidRegex.test(other)) {
                return res.status(400).json({ error: 'Invalid user ID format' });
            }

            // Check if user has hidden this conversation
            const { data: hidden } = await supabaseAdmin
                .from('hidden_conversations')
                .select('hidden_at')
                .eq('user_id', req.session.userId)
                .eq('other_user_id', other)
                .single();
            
            const hiddenAt = hidden ? new Date(hidden.hidden_at) : null;

            // Build queries with optional before parameter for pagination
            let sentQuery = supabaseAdmin.from('messages').select('*, users:user_id (username, profile_picture_url)')
                .eq('user_id', req.session.userId).eq('recipient_id', other)
                .order('created_at', { ascending: false }).limit(limit);
            let receivedQuery = supabaseAdmin.from('messages').select('*, users:user_id (username, profile_picture_url)')
                .eq('user_id', other).eq('recipient_id', req.session.userId)
                .order('created_at', { ascending: false }).limit(limit);
            
            // If conversation was hidden, only show messages after the hidden date
            if (hiddenAt) {
                sentQuery = sentQuery.gt('created_at', hiddenAt.toISOString());
                receivedQuery = receivedQuery.gt('created_at', hiddenAt.toISOString());
            }

            // Apply since filter (polling: only fetch messages newer than given timestamp)
            const since = req.query.since || null;
            if (since) {
                sentQuery = sentQuery.gt('created_at', since);
                receivedQuery = receivedQuery.gt('created_at', since);
            }
            
            // Apply before filter if provided
            if (before) {
                // Get the timestamp of the before message
                const { data: beforeMsg } = await supabaseAdmin.from('messages').select('created_at').eq('id', before).single();
                if (beforeMsg && beforeMsg.created_at) {
                    sentQuery = sentQuery.lt('created_at', beforeMsg.created_at);
                    receivedQuery = receivedQuery.lt('created_at', beforeMsg.created_at);
                }
            }
            
            // Fetch messages between current user and the other user using admin client
            const [sentRes, receivedRes] = await Promise.all([sentQuery, receivedQuery]);
            const error = sentRes.error || receivedRes.error;
            let messages = [...(sentRes.data || []), ...(receivedRes.data || [])]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, limit);

                if (error) {
                    console.error('Get messages error:', error);
                    return res.status(500).json({ error: 'Failed to fetch messages' });
                }

                // Filter out soft-deleted messages for current user
                const { data: deletedMsgs } = await supabaseAdmin
                    .from('deleted_messages')
                    .select('message_id')
                    .eq('user_id', req.session.userId);
                
                const deletedIds = new Set((deletedMsgs || []).map(d => d.message_id));
                messages = messages.filter(m => !deletedIds.has(m.id));

                try { console.debug('Get messages:', chatType, 'count=', (messages && messages.length) ? messages.length : 0); } catch (e) {}
                // Enrich reply metadata for private messages
                try {
                    const msgs = messages.reverse();
                    const replyIds = msgs.map(m => m.reply_to).filter(Boolean);
                    if (replyIds.length > 0) {
                        const { data: replies } = await supabaseAdmin.from('messages').select('id, message, user_id, username').in('id', replyIds);
                        const map = (replies || []).reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
                        msgs.forEach(m => { if (m.reply_to && map[m.reply_to]) m.reply_to_meta = map[m.reply_to]; });
                    }
                    return res.json({ messages: msgs });
                } catch (e) {
                    return res.json({ messages: messages.reverse() });
                }
        } else {
            // Support optional `since` query param so clients can request only messages
            // newer than a given ISO timestamp. Example: /api/messages/general?since=2026-01-31T10:00:00Z
            const since = req.query.since || null;
            let q = supabaseAdmin
            .from('messages')
            .select('*, users:user_id (username, profile_picture_url)')
            .eq('chat_type', chatType)
            .order('created_at', { ascending: false })
            .limit(limit);

            if (since) {
                q = q.gt('created_at', since);
            }
            
            // Apply before filter for pagination
            if (before) {
                const { data: beforeMsg } = await supabaseAdmin.from('messages').select('created_at').eq('id', before).single();
                if (beforeMsg && beforeMsg.created_at) {
                    q = q.lt('created_at', beforeMsg.created_at);
                }
            }

            const { data: messages, error } = await q;

                if (error) {
                    console.error('Get messages error:', error);
                    return res.status(500).json({ error: 'Failed to fetch messages' });
                }

                // Filter out soft-deleted messages for current user
                const { data: deletedMsgs } = await supabaseAdmin
                    .from('deleted_messages')
                    .select('message_id')
                    .eq('user_id', req.session.userId);
                
                const deletedIds = new Set((deletedMsgs || []).map(d => d.message_id));
                const filteredMessages = messages.filter(m => !deletedIds.has(m.id));

                // Enrich reply metadata if present
                try {
                    const msgs = filteredMessages.reverse();
                    const replyIds = msgs.map(m => m.reply_to).filter(Boolean);
                    if (replyIds.length > 0) {
                        const { data: replies } = await supabaseAdmin.from('messages').select('id, message, user_id, username').in('id', replyIds);
                        const map = (replies || []).reduce((acc, r) => { acc[r.id] = r; return acc; }, {});
                        msgs.forEach(m => { if (m.reply_to && map[m.reply_to]) m.reply_to_meta = map[m.reply_to]; });
                    }

                    // For anonymous messages, avoid leaking the real user's joined `users` data
                    // to other users. Keep profile info for the message sender only.
                    for (const m of msgs) {
                        try {
                            const maybeAnon = (m && (m.is_anonymous === true));
                            const fallbackAnon = (m && m.username && String(m.username) === generateAnonName(m.user_id));
                            if (maybeAnon || fallbackAnon) {
                                if (String(m.user_id) !== String(req.session.userId)) {
                                    // Strip joined user profile fields and the raw `user_id` so
                                    // anonymous authors cannot be resolved by other clients.
                                    try { delete m.user_id; } catch (_) {}
                                    if (m.users) {
                                        try { delete m.users.profile_picture_url; } catch (_) {}
                                        try { delete m.users.username; } catch (_) {}
                                        try { delete m.users.email; } catch (_) {}
                                        try { delete m.users.is_dev; } catch (_) {}
                                        try { delete m.users.role; } catch (_) {}
                                    }
                                }
                            }
                        } catch (e) { /* ignore */ }
                    }

                    try { console.debug('Get messages:', chatType, 'count=', (msgs && msgs.length) ? msgs.length : 0); } catch (e) {}
                    return res.json({ messages: msgs });
                } catch (e) {
                    try { console.debug('Get messages:', chatType, 'count=', (filteredMessages && filteredMessages.length) ? filteredMessages.length : 0); } catch (ee) {}
                    return res.json({ messages: filteredMessages.reverse() });
                }
        }

        if (error) {
            console.error('Get messages error:', error);
            return res.status(500).json({ error: 'Failed to fetch messages' });
        }

        res.json({ messages: messages.reverse() });
    } catch (error) {
        console.error('Get messages error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete private conversation (one-sided) - marks conversation as hidden for current user
app.delete('/api/messages/private/delete', requireAuth, async (req, res) => {
    try {
        const other = req.query.with;
        if (!other) return res.status(400).json({ error: 'Missing "with" query param' });
        
        // Validate UUIDs
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
        if (!uuidRegex.test(req.session.userId) || !uuidRegex.test(other)) {
            return res.status(400).json({ error: 'Invalid user ID format' });
        }
        
        // Insert or update hidden_conversations entry (one-sided)
        const { error: upsertError } = await supabaseAdmin
            .from('hidden_conversations')
            .upsert({
                user_id: req.session.userId,
                other_user_id: other,
                hidden_at: new Date().toISOString()
            }, { onConflict: 'user_id,other_user_id' });
        
        if (upsertError) {
            console.error('Hide conversation error:', upsertError);
            return res.status(500).json({ error: 'Failed to delete conversation' });
        }
        
        res.json({ success: true, message: 'Conversation deleted successfully' });
    } catch (error) {
        console.error('Delete conversation error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

/**
 * Generates a deterministic unique anonymous display name from a user's UUID.
 * Uses three independent polynomial hash functions so adjective, animal, and
 * number are drawn from independent parts of the hash space.
 * Matches the client-side generateAnonymousName() in chat.js exactly.
 */
function generateAnonName(userId) {
    const adjectives = [
        'Mystic','Shadow','Silent','Bright','Swift','Calm','Bold','Gentle','Wild','Noble',
        'Cosmic','Azure','Crimson','Golden','Jade','Luna','Solar','Stellar','Vivid','Zen',
        'Amber','Cobalt','Dusk','Ember','Frost','Ivory','Navy','Onyx','Pearl','Ruby'
    ];
    const animals = [
        'Fox','Wolf','Hawk','Bear','Deer','Lion','Owl','Raven','Seal','Tiger',
        'Crane','Drake','Eagle','Finch','Goose','Heron','Ibis','Jaguar','Koala','Lynx',
        'Mink','Newt','Orca','Panda','Quail','Robin','Stoat','Toad','Vole','Wren'
    ];
    const str = String(userId || '');
    let h1 = 0, h2 = 0, h3 = 0;
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1, 31) + c | 0;
        h2 = Math.imul(h2, 37) + c | 0;
        h3 = Math.imul(h3, 41) + c | 0;
    }
    const adj    = adjectives[Math.abs(h1) % 30];
    const animal = animals[Math.abs(h2) % 30];
    const num    = Math.abs(h3) % 900 + 100;
    return `${adj}${animal}#${num}`;
}

// Send message
app.post('/api/messages', requireAuth, messageLimiter, async (req, res) => {
    try {
        const { message, chat_type } = req.body;
        const recipient_id = req.body.recipient_id || null;
        const reply_to = req.body.reply_to || null;
        const is_anonymous = req.body.is_anonymous === true && chat_type === 'general';

        if (!message || !chat_type) {
            return res.status(400).json({ error: 'Message and chat type are required' });
        }

        // Check if user is muted or banned
        const { data: user, error: userError } = await supabaseAdmin
            .from('users')
            .select('chat_muted_until, banned_until')
            .eq('id', req.session.userId)
            .single();

        if (userError) {
            console.error('Failed to check user moderation status:', userError);
            return res.status(500).json({ error: 'Server error' });
        }

        // Check if user is currently banned
        if (user.banned_until) {
            const bannedUntil = new Date(user.banned_until);
            if (bannedUntil > new Date()) {
                return res.status(403).json({ 
                    error: 'You are currently banned from the platform', 
                    banned_until: user.banned_until 
                });
            }
        }

        // Check if user is currently muted from chat
        if (user.chat_muted_until) {
            const mutedUntil = new Date(user.chat_muted_until);
            if (mutedUntil > new Date()) {
                return res.status(403).json({ 
                    error: 'You are currently muted from sending chat messages', 
                    muted_until: user.chat_muted_until 
                });
            }
        }

        // Server-side sanitization: trim and limit length
        let cleanMessage = String(message || '').trim();
        if (cleanMessage.length > 1000) cleanMessage = cleanMessage.substring(0, 1000);

        // Basic stripping of HTML tags to avoid stored HTML/JS
        cleanMessage = cleanMessage.replace(/<[^>]*>/g, '');

        // Prevent control characters that could confuse downstream systems
        cleanMessage = cleanMessage.replace(/[\x00-\x1F\x7F]/g, '');

        // Note: automatic server-side blocking/muting for blacklisted words
        // has been removed. Messages are accepted and admins moderate via
        // reports submitted by users.

        const insertObj = {
            user_id: req.session.userId,
            username: is_anonymous ? generateAnonName(req.session.userId) : req.session.username,
            message: cleanMessage,
            chat_type,
            is_anonymous: is_anonymous || false
        };
        if (chat_type === 'private') insertObj.recipient_id = recipient_id;
        if (reply_to) insertObj.reply_to = reply_to;

        let { data: newMessage, error } = await supabaseAdmin
            .from('messages')
            .insert([insertObj])
            .select()
            .single();

        // Backward-compatible fallback when the DB has not yet added messages.is_anonymous
        if (error && String(error.message || '').includes('is_anonymous')) {
            const fallbackInsert = { ...insertObj };
            delete fallbackInsert.is_anonymous;

            const retry = await supabaseAdmin
                .from('messages')
                .insert([fallbackInsert])
                .select()
                .single();

            newMessage = retry.data;
            error = retry.error;
        }

        if (error) {
            console.error('Send message error:', error);
            return res.status(500).json({ error: 'Failed to send message' });
        }

        // Create notification for private messages
        if (chat_type === 'private' && recipient_id && recipient_id !== req.session.userId) {
            try {
                const preview = cleanMessage.length > 80 ? cleanMessage.slice(0, 80) + '…' : cleanMessage;
                await createNotification({
                    userId: recipient_id,
                    type: 'message',
                    title: `💬 ${req.session.username} sent you a message`,
                    message: preview,
                    link: `/chat.html?with=${req.session.userId}`,
                    relatedUserId: req.session.userId,
                    relatedItemId: newMessage.id
                });
            } catch (notifErr) {
                console.error('Failed to create message notification:', notifErr);
            }
        }

        // Fire-and-forget push notifications for general / school chat
        if (chat_type !== 'private') {
            (async () => {
                try {
                    // Find all users with push subscriptions (excluding sender)
                    const { data: subUsers } = await supabaseAdmin
                        .from('push_subscriptions')
                        .select('user_id')
                        .neq('user_id', req.session.userId);

                    if (!subUsers || subUsers.length === 0) return;

                    const subUserIds = [...new Set(subUsers.map(s => s.user_id))];

                    // Filter to those who have general chat notifications enabled
                    const { data: notifUsers } = await supabaseAdmin
                        .from('users')
                        .select('id')
                        .in('id', subUserIds)
                        .eq('notif_general_chat', true);

                    if (!notifUsers || notifUsers.length === 0) return;

                    const preview = cleanMessage.length > 80 ? cleanMessage.slice(0, 80) + '…' : cleanMessage;
                    const chatLabel = chat_type === 'general' ? 'General Chat' : 'School Chat';
                    const notifUsername = is_anonymous ? newMessage.username : req.session.username;

                    await Promise.allSettled(
                        notifUsers.map(u => sendPushToUser(u.id, {
                            title: `💬 ${notifUsername} — ${chatLabel}`,
                            body: preview,
                            url: '/chat.html',
                            type: 'message',
                            tag: `chat-${chat_type}-${newMessage.id}`
                        }))
                    );
                } catch (pushErr) {
                    console.warn('[push] general chat push error:', pushErr.message);
                }
            })();
        }

        try { console.debug('New message inserted:', newMessage && newMessage.id ? { id: newMessage.id, user_id: newMessage.user_id, chat_type: newMessage.chat_type } : newMessage); } catch (e) {}

        // Broadcast newly created message to connected WebSocket clients
        (async () => {
            try {
                // Attempt to fetch the inserted message including joined user info
                let fetched = null;
                try {
                    const { data: f, error: fErr } = await supabaseAdmin
                        .from('messages')
                        .select('*, users:user_id (username, profile_picture_url)')
                        .eq('id', newMessage.id)
                        .single();
                    if (!fErr) fetched = f;
                } catch (e) { fetched = null; }

                const baseMsg = fetched || newMessage;

                // Helper to deep-clone and mask joined user info for anonymous messages
                const maskForOthers = (msgObj) => {
                    try {
                        const copy = JSON.parse(JSON.stringify(msgObj));
                        const maybeAnon = (copy && (copy.is_anonymous === true));
                        const fallbackAnon = (copy && copy.username && String(copy.username) === generateAnonName(copy.user_id));
                                if (maybeAnon || fallbackAnon) {
                                    // Remove any potentially sensitive profile fields that may have
                                    // been joined by upstream queries. Keep this list conservative.
                                    if (copy.users) {
                                        try { delete copy.users.profile_picture_url; } catch (_) {}
                                        try { delete copy.users.username; } catch (_) {}
                                        try { delete copy.users.email; } catch (_) {}
                                        try { delete copy.users.is_dev; } catch (_) {}
                                        try { delete copy.users.role; } catch (_) {}
                                    }
                                    // Remove the raw user_id so other clients cannot resolve the
                                    // anonymous author's profile by visiting /user.html?user=<id>.
                                    try { delete copy.user_id; } catch (_) {}
                                }
                        return copy;
                    } catch (e) { return msgObj; }
                };

                const payloadForSender = { type: 'new_message', message: baseMsg };
                const payloadForOthers = { type: 'new_message', message: maskForOthers(baseMsg) };

                if (baseMsg.chat_type === 'private') {
                    // Send to recipient and sender (if connected)
                    const recipientId = String(baseMsg.recipient_id || '');
                    const senderId = String(baseMsg.user_id || '');
                    const sendTo = new Set([recipientId, senderId]);
                    for (const uid of sendTo) {
                        const sockets = _wsClientsByUserId.get(uid) || new Set();
                        for (const s of sockets) {
                            try {
                                if (s && s.readyState === 1) {
                                    // If the recipient is the sender, send full payload; otherwise send full as private messages are not anonymous
                                    await s.send(JSON.stringify(payloadForSender));
                                }
                            } catch (_) {}
                        }
                    }
                } else {
                    // General chat: send masked payload to everyone except the sender
                    const senderId = String(baseMsg.user_id || '');
                    for (const [uid, sockets] of _wsClientsByUserId.entries()) {
                        for (const s of sockets) {
                            try {
                                if (!s || s.readyState !== 1) continue;
                                if (String(uid) === senderId) {
                                    s.send(JSON.stringify(payloadForSender));
                                } else {
                                    s.send(JSON.stringify(payloadForOthers));
                                }
                            } catch (_) {}
                        }
                    }
                }
            } catch (err) {
                console.warn('WS broadcast error:', err && err.message ? err.message : err);
            }
        })();
        // Log anonymous general chat messages to Discord
        if (is_anonymous && chat_type === 'general' && process.env.DISCORD_CHAT_WEBHOOK) {
            (async () => {
                try {
                    // Fetch user email
                    const { data: userData } = await supabaseAdmin
                        .from('users')
                        .select('email')
                        .eq('id', req.session.userId)
                        .single();
                    
                    const userEmail = userData?.email || 'unknown';
                    const userLink = _userLink(req);
                    const anonName = newMessage.username;
                    
                    _chatDiscord('💬 Anonymous General Chat', [
                        ['Username', userLink],
                        ['Email', userEmail],
                        ['Anonymous Name', anonName],
                        ['Message', cleanMessage]
                    ]);
                } catch (logErr) {
                    console.error('Failed to log chat to Discord:', logErr);
                }
            })();
        }

        // Background AI proactive moderation scan (fire-and-forget, non-blocking)
        console.info(`[AI Mod] Scheduling autoModerateMessage for message ${newMessage.id} (chatType=${chat_type})`);
        autoModerateMessage(newMessage.id, {
            content: cleanMessage,
            username: is_anonymous ? (newMessage.username || 'Anonymous') : (req.session.username || 'Unknown'),
            chatType: chat_type
        }).catch(e => console.warn('[AI Mod] autoModerateMessage error (new message):', e && e.message ? e.message : e));

        res.json({ message: newMessage });
    } catch (error) {
        console.error('Send message error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

    // Delete message for everyone (hard delete - only message owner can do this)
    app.delete('/api/messages/:id/delete-all', requireAuth, async (req, res) => {
        try {
            const messageId = req.params.id;
            
            // Verify the user owns this message
            const { data: message, error: fetchError } = await supabaseAdmin
                .from('messages')
                .select('user_id')
                .eq('id', messageId)
                .single();
            
            if (fetchError || !message) {
                return res.status(404).json({ error: 'Message not found' });
            }
            
            if (String(message.user_id) !== String(req.session.userId)) {
                return res.status(403).json({ error: 'You can only delete your own messages' });
            }
            
            // Hard delete the message
            const { error: deleteError } = await supabaseAdmin
                .from('messages')
                .delete()
                .eq('id', messageId);
            
            if (deleteError) {
                console.error('Delete message error:', deleteError);
                return res.status(500).json({ error: 'Failed to delete message' });
            }
            
            res.json({ success: true, message: 'Message deleted for everyone' });
        } catch (error) {
            console.error('Delete message error:', error);
            res.status(500).json({ error: 'Server error' });
        }
    });

    // Delete message for current user only (soft delete)
    app.delete('/api/messages/:id/delete-for-me', requireAuth, async (req, res) => {
        try {
            const messageId = req.params.id;
            
            // Verify message exists
            const { data: message, error: fetchError } = await supabaseAdmin
                .from('messages')
                .select('id')
                .eq('id', messageId)
                .single();
            
            if (fetchError || !message) {
                return res.status(404).json({ error: 'Message not found' });
            }
            
            // Add to deleted_messages table (soft delete)
            const upsertPayload = {
                user_id: req.session.userId,
                message_id: messageId,
                deleted_at: new Date().toISOString()
            };

            let { error: insertError } = await supabaseAdmin
                .from('deleted_messages')
                .upsert(upsertPayload, { onConflict: 'user_id,message_id' });

            // If the table does not exist, attempt to create it and retry once
            if (insertError && (String(insertError.message || '').includes('does not exist') || String(insertError.code || '') === '42P01')) {
                console.warn('deleted_messages table missing; attempting to create it on-the-fly');
                try {
                    const pool = createSessionPool();
                    const createSql = `
                        CREATE TABLE IF NOT EXISTS deleted_messages (
                            id UUID PRIMARY KEY,
                            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                            message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
                            deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                            UNIQUE(user_id, message_id)
                        );
                        CREATE INDEX IF NOT EXISTS idx_deleted_messages_user_id ON deleted_messages(user_id);
                        CREATE INDEX IF NOT EXISTS idx_deleted_messages_message_id ON deleted_messages(message_id);
                    `;
                    await pool.query(createSql);

                    // retry upsert
                    const retry = await supabaseAdmin.from('deleted_messages').upsert(upsertPayload, { onConflict: 'user_id,message_id' });
                    insertError = retry.error;
                } catch (e) {
                    console.error('Failed to create deleted_messages table:', e);
                    return res.status(500).json({ error: 'Failed to delete message' });
                }
            }

            if (insertError) {
                console.error('Soft delete message error:', insertError);
                return res.status(500).json({ error: 'Failed to delete message' });
            }
            
            res.json({ success: true, message: 'Message deleted for you' });
        } catch (error) {
            console.error('Delete message error:', error);
            res.status(500).json({ error: 'Server error' });
        }
    });

    // Report a chat message
    app.post('/api/messages/:id/report', requireAuth, async (req, res) => {
        try {
            const messageId = req.params.id;
            const reporterId = req.session.userId;
            const { report_type, details } = req.body;

            if (!report_type) return res.status(400).json({ error: 'report_type is required' });

            // Prevent users from reporting their own messages
            try {
                const { data: msgRow, error: fetchErr } = await supabaseAdmin
                    .from('messages')
                    .select('user_id')
                    .eq('id', messageId)
                    .single();

                if (fetchErr || !msgRow) {
                    return res.status(404).json({ error: 'Message not found' });
                }

                if (String(msgRow.user_id) === String(reporterId)) {
                    return res.status(400).json({ error: 'You cannot report your own message' });
                }
            } catch (e) {
                console.error('Failed checking message owner before report:', e);
                return res.status(500).json({ error: 'Server error' });
            }

            const { data, error } = await supabaseAdmin
                .from('chat_reports')
                .insert([{ message_id: messageId, reporter_id: reporterId, report_type, details }]);

            if (error) {
                console.error('Failed to create chat report:', error);
                return res.status(500).json({ error: 'Failed to submit report' });
            }

            res.json({ ok: true, report: data && data[0] });

            // Fire-and-forget: AI re-scans the reported message with the report context
            ;(async () => {
                try {
                    const { data: msg } = await supabaseAdmin
                        .from('messages')
                        .select('id, message, username, chat_type, user_id, users:user_id(username)')
                        .eq('id', messageId)
                        .single();
                    if (msg) {
                        console.info(`[AI Mod] Scheduling autoModerateMessage for reported message ${msg.id} (report_type=${report_type})`);
                        await autoModerateMessage(msg.id, {
                            content: msg.message || '',
                            username: msg.username || msg.users?.username || 'Unknown',
                            chatType: msg.chat_type || 'general',
                            reportType: report_type,
                            reportDetails: details
                        });
                    }
                } catch (e) { console.warn('[AI Mod] Failed to schedule AI rescan for reported message', e && e.message ? e.message : e); }
            })();
        } catch (err) {
            console.error('Report message error:', err);
            res.status(500).json({ error: 'Server error' });
        }
    });

// Unread counts since client-provided timestamps
app.get('/api/messages/unread', requireAuth, async (req, res) => {
    try {
        // Client should send ISO timestamps for last seen times
        const lastSeenGeneral = req.query.lastSeenGeneral || null;
        const lastSeenPrivate = req.query.lastSeenPrivate || null;

        // Default to epoch (count everything) if client didn't provide timestamps.
        // Clients are expected to set sensible defaults (usually now on load).
        const generalSince = lastSeenGeneral ? lastSeenGeneral : '1970-01-01T00:00:00Z';
        const privateSince = lastSeenPrivate ? lastSeenPrivate : '1970-01-01T00:00:00Z';

        // Count new general messages from others
        const generalResp = await supabaseAdmin
            .from('messages')
            .select('*', { head: true, count: 'exact' })
            .eq('chat_type', 'general')
            .neq('user_id', req.session.userId)
            .gt('created_at', generalSince);

        if (generalResp.error) {
            console.error('Unread general count error:', generalResp.error);
            return res.status(500).json({ error: 'Failed to compute unread general count' });
        }

        // Count new private messages addressed to this user
        const privateResp = await supabaseAdmin
            .from('messages')
            .select('*', { head: true, count: 'exact' })
            .eq('chat_type', 'private')
            .eq('recipient_id', req.session.userId)
            .gt('created_at', privateSince);

        if (privateResp.error) {
            console.error('Unread private count error:', privateResp.error);
            return res.status(500).json({ error: 'Failed to compute unread private count' });
        }

        const generalCount = generalResp.count || 0;
        const privateCount = privateResp.count || 0;

        res.json({ general: generalCount, private: privateCount });
    } catch (err) {
        console.error('Unread counts error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get online users
app.get('/api/online-users', requireAuth, async (req, res) => {
    try {
        // Exclude the current user from the list so users don't see themselves
        const { data: onlineUsers, error } = await supabase
            .from('online_users')
            .select('*')
            .neq('user_id', req.session.userId)
            .order('last_seen', { ascending: false });

        if (error) {
            console.error('Get online users error:', error);
            return res.status(500).json({ error: 'Failed to fetch online users' });
        }

        res.json({ onlineUsers });
    } catch (error) {
        console.error('Get online users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update online status
app.post('/api/online-status', requireAuth, async (req, res) => {
    try {
        await supabaseAdmin
            .from('online_users')
            .upsert({
                user_id: req.session.userId,
                username: req.session.username,
                last_seen: new Date().toISOString()
            });

        // Fire-and-forget: clean up users who haven't pinged in over 5 minutes
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        supabaseAdmin.from('online_users').delete().lt('last_seen', fiveMinAgo).then(() => {}).catch(() => {});

        res.json({ message: 'Status updated' });
    } catch (error) {
        console.error('Update status error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update current user's profile (username / display_name / email)
app.put('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const { username, display_name, email } = req.body;

        const updates = {};
        if (username) {
            if (!isValidUsername(username)) {
                return res.status(400).json({ error: 'Invalid username format' });
            }
            // Check if username is already taken
            const { data: existingUser } = await supabase
                .from('users')
                .select('id')
                .eq('username', username)
                .neq('id', req.session.userId)
                .single();
            
            if (existingUser) {
                return res.status(400).json({ error: 'Username already taken' });
            }
            updates.username = username;
        }
        if (display_name !== undefined) updates.display_name = display_name;
        if (email) {
            if (!isValidEmail(email)) {
                return res.status(400).json({ error: 'Invalid email format' });
            }
            // Check if email is already taken
            const { data: existingUser } = await supabase
                .from('users')
                .select('id')
                .eq('email', email)
                .neq('id', req.session.userId)
                .single();
            
            if (existingUser) {
                return res.status(400).json({ error: 'Email already in use' });
            }
            updates.email = email;
        }

        const { data: user, error } = await supabaseAdmin
            .from('users')
            .update(updates)
            .eq('id', req.session.userId)
            .select('id, email, username, display_name, profile_picture_url')
            .single();

        if (error) {
            console.error('Update profile error:', error);
            return res.status(500).json({ error: 'Failed to update profile' });
        }

        // Update session username if changed
        if (user && user.username) req.session.username = user.username;

        res.json({ user });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Upload avatar
app.post('/api/auth/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

        // Remember old avatar URL to delete it after successful update
        const { data: existingUser } = await supabaseAdmin
            .from('users')
            .select('profile_picture_url')
            .eq('id', req.session.userId)
            .single();
        const oldUrl = existingUser?.profile_picture_url || null;

        // Upload file buffer to Supabase storage bucket
        const file = req.file;
        const bucket = process.env.SUPABASE_AVATAR_BUCKET || 'avatars';
        const ext = path.extname(file.originalname) || '.png';
        const filename = `${req.session.userId}-${Date.now()}${ext}`;
        const filePath = `${req.session.userId}/${filename}`;

        const { error: uploadErr } = await supabaseAdmin.storage
            .from(bucket)
            .upload(filePath, file.buffer, {
                contentType: file.mimetype,
                upsert: true
            });

        if (uploadErr) {
            console.error('Supabase storage upload error:', uploadErr);
            return res.status(500).json({ error: 'Failed to upload avatar to storage' });
        }

        // Get public URL for uploaded object
        const { data: publicData, error: publicErr } = await supabaseAdmin.storage
            .from(bucket)
            .getPublicUrl(filePath);

        if (publicErr) {
            console.error('Failed to get public URL:', publicErr);
            return res.status(500).json({ error: 'Failed to get avatar URL' });
        }

        const publicUrl = publicData && publicData.publicUrl ? publicData.publicUrl : null;

        // Update user record with new public URL
        const { data: user, error } = await supabaseAdmin
            .from('users')
            .update({ profile_picture_url: publicUrl })
            .eq('id', req.session.userId)
            .select('id, email, username, display_name, profile_picture_url')
            .single();

        if (error) {
            console.error('Avatar update error:', error);
            return res.status(500).json({ error: 'Failed to save avatar URL' });
        }

        // Attempt to delete previous avatar from storage (best-effort).
        try {
            if (oldUrl && typeof oldUrl === 'string') {
                const marker = '/storage/v1/object/public/';
                const idx = oldUrl.indexOf(marker);
                if (idx !== -1) {
                    let rest = oldUrl.substring(idx + marker.length); // e.g. 'avatars/userid/old.png'
                    // Ensure we are targeting the same bucket
                    if (rest.startsWith(bucket + '/')) {
                        const oldPath = decodeURIComponent(rest.substring(bucket.length + 1));
                        if (oldPath) {
                            const { error: delErr } = await supabaseAdmin.storage.from(bucket).remove([oldPath]);
                            if (delErr) console.warn('Failed to delete old avatar:', delErr.message || delErr);
                        }
                    } else {
                        // If rest doesn't start with bucket, attempt to remove the path part after first segment
                        const parts = rest.split('/');
                        if (parts.length > 1) {
                            const maybeBucket = parts[0];
                            const oldPath = decodeURIComponent(parts.slice(1).join('/'));
                            if (maybeBucket === bucket && oldPath) {
                                const { error: delErr } = await supabaseAdmin.storage.from(bucket).remove([oldPath]);
                                if (delErr) console.warn('Failed to delete old avatar (alt):', delErr.message || delErr);
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('Error while attempting to delete previous avatar:', e);
        }

        res.json({ user });
    } catch (error) {
        console.error('Avatar upload error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// USER SETTINGS ROUTES
// =====================================================

// Get user settings (notifications and 2FA status)
app.get('/api/auth/settings', requireAuth, async (req, res) => {
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('notif_general_chat, notif_private_messages, two_factor_enabled, email_2fa_enabled')
            .eq('id', req.session.userId)
            .single();

        if (error) {
            console.error('Get settings error:', error);
            return res.status(500).json({ error: 'Failed to fetch settings' });
        }

        res.json({
            settings: {
                notif_general_chat: user.notif_general_chat ?? true,
                notif_private_messages: user.notif_private_messages ?? true,
                two_factor_enabled: user.two_factor_enabled ?? false,
                email_2fa_enabled: user.email_2fa_enabled ?? false
            }
        });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update notification preferences
app.put('/api/auth/settings/notifications', requireAuth, async (req, res) => {
    try {
        const { notif_general_chat, notif_private_messages } = req.body;

        if (typeof notif_general_chat !== 'boolean' || typeof notif_private_messages !== 'boolean') {
            return res.status(400).json({ error: 'Invalid notification settings' });
        }

        const { error } = await supabaseAdmin
            .from('users')
            .update({
                notif_general_chat,
                notif_private_messages
            })
            .eq('id', req.session.userId);

        if (error) {
            console.error('Update notifications error:', error);
            return res.status(500).json({ error: 'Failed to update notification settings' });
        }

        res.json({ message: 'Notification settings updated successfully' });
    } catch (error) {
        console.error('Update notifications error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

function requireLoginActivityVerification(req, res, next) {
    if (!isLoginActivityVerified(req)) {
        return res.status(403).json({ error: 'Verification required', codeRequired: true });
    }
    next();
}

app.post('/api/auth/settings/login-activity/request-code', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const { data: user, error: userErr } = await supabaseAdmin
            .from('users')
            .select('id, username, email')
            .eq('id', userId)
            .single();

        if (userErr || !user || !user.email) {
            return res.status(400).json({ error: 'Unable to send verification code' });
        }

        const now = new Date();
        const nowIso = now.toISOString();

        // Cleanup stale rows to keep the table compact per user.
        await Promise.all([
            supabaseAdmin
                .from('login_activity_access_codes')
                .delete()
                .eq('user_id', userId)
                .eq('used', true),
            supabaseAdmin
                .from('login_activity_access_codes')
                .delete()
                .eq('user_id', userId)
                .lt('expires_at', nowIso)
        ]);

        const { data: existingCode } = await supabaseAdmin
            .from('login_activity_access_codes')
            .select('id, code, expires_at')
            .eq('user_id', userId)
            .eq('used', false)
            .gt('expires_at', nowIso)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        let code = existingCode ? String(existingCode.code) : Math.floor(100000 + Math.random() * 900000).toString();
        let expiresAt = existingCode ? new Date(existingCode.expires_at) : new Date(Date.now() + LOGIN_ACTIVITY_VERIFY_WINDOW_MS);
        let insertedId = null;

        if (!existingCode) {
            const { data: inserted, error: insertErr } = await supabaseAdmin
                .from('login_activity_access_codes')
                .insert({
                    user_id: userId,
                    code,
                    expires_at: expiresAt.toISOString(),
                    used: false
                })
                .select('id')
                .single();

            if (insertErr || !inserted) {
                console.error('Failed to create login-activity access code:', insertErr);
                return res.status(500).json({ error: 'Failed to generate verification code' });
            }
            insertedId = inserted.id;
        }

        const sent = await sendTemplatedEmail({
            to: user.email,
            subject: 'Thinky Login Activity Verification Code',
            template: 'login_activity_code',
            variables: {
                username: user.username || 'there',
                code,
                expires_minutes: String(Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000)))
            }
        });

        if (!sent) {
            if (insertedId) {
                await supabaseAdmin
                    .from('login_activity_access_codes')
                    .delete()
                    .eq('id', insertedId);
            }
            return res.status(500).json({ error: 'Failed to send verification email' });
        }

        clearLoginActivityVerified(req);
        await new Promise((resolve) => req.session.save(() => resolve()));

        res.json({
            message: 'Verification code sent to your email',
            expiresInMinutes: Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 60000))
        });
    } catch (error) {
        console.error('Request login-activity code error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/auth/settings/login-activity/verify-code', requireAuth, async (req, res) => {
    try {
        const rawCode = req.body && req.body.code ? String(req.body.code).trim() : '';
        if (!/^\d{6}$/.test(rawCode)) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        const nowIso = new Date().toISOString();
        const { data: codeRow, error: codeErr } = await supabaseAdmin
            .from('login_activity_access_codes')
            .select('id, expires_at')
            .eq('user_id', req.session.userId)
            .eq('code', rawCode)
            .eq('used', false)
            .gt('expires_at', nowIso)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

        if (codeErr || !codeRow) {
            return res.status(400).json({ error: 'Invalid or expired verification code' });
        }

        await supabaseAdmin
            .from('login_activity_access_codes')
            .update({ used: true })
            .eq('id', codeRow.id);

        markLoginActivityVerified(req);
        await new Promise((resolve) => req.session.save(() => resolve()));

        res.json({
            message: 'Verification successful',
            verifiedUntil: req.session.loginActivityVerifiedUntil
        });
    } catch (error) {
        console.error('Verify login-activity code error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.get('/api/auth/settings/login-activity', requireAuth, requireLoginActivityVerification, async (req, res) => {
    try {
        const { data: rows, error } = await supabaseAdmin
            .from('user_login_activity')
            .select('session_sid, device_label, device_model, ip_address, country_code, location_text, user_agent, is_unfamiliar, created_at, last_seen_at')
            .eq('user_id', req.session.userId)
            .is('revoked_at', null)
            .order('last_seen_at', { ascending: false })
            .limit(50);

        if (error) {
            console.error('Get login activity error:', error);
            return res.status(500).json({ error: 'Failed to load login activity' });
        }

        const currentSid = req.sessionID ? String(req.sessionID) : '';
        const sessions = (rows || []).map((row) => ({
            session_sid: row.session_sid,
            device_label: row.device_label || 'Unknown device',
            device_model: row.device_model || '',
            ip_address: row.ip_address || 'n/a',
            country_code: row.country_code || null,
            location_text: row.location_text || 'Unknown location',
            user_agent: row.user_agent || '',
            is_unfamiliar: !!row.is_unfamiliar,
            created_at: row.created_at,
            last_seen_at: row.last_seen_at,
            is_current: !!currentSid && String(row.session_sid) === currentSid
        }));

        res.json({
            sessions,
            verifiedUntil: req.session.loginActivityVerifiedUntil || null
        });
    } catch (error) {
        console.error('Get login activity error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/auth/settings/login-activity/:sessionSid', requireAuth, requireLoginActivityVerification, async (req, res) => {
    try {
        const sessionSid = sanitizeString(req.params.sessionSid || '', 255);
        if (!sessionSid) {
            return res.status(400).json({ error: 'Invalid session id' });
        }

        const { data: revokedRows, error: revokeErr } = await supabaseAdmin
            .from('user_login_activity')
            .update({ revoked_at: new Date().toISOString() })
            .eq('user_id', req.session.userId)
            .eq('session_sid', sessionSid)
            .is('revoked_at', null)
            .select('session_sid');

        if (revokeErr) {
            console.error('Revoke login activity error:', revokeErr);
            return res.status(500).json({ error: 'Failed to revoke session' });
        }

        if (!revokedRows || revokedRows.length === 0) {
            return res.status(404).json({ error: 'Session not found' });
        }

        await destroySessionBySid(sessionSid);

        const isCurrent = req.sessionID && String(req.sessionID) === String(sessionSid);
        if (isCurrent) {
            return req.session.destroy((err) => {
                if (err) {
                    console.error('Destroy current session after revoke error:', err);
                    return res.status(500).json({ error: 'Session revoked but local logout failed' });
                }
                res.json({ message: 'Current session revoked', loggedOut: true });
            });
        }

        res.json({ message: 'Session revoked' });
    } catch (error) {
        console.error('Revoke login activity error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Import speakeasy and qrcode for 2FA
import speakeasy from 'speakeasy';
import QRCode from 'qrcode';

// Enable Google Authenticator (TOTP)
app.post('/api/auth/2fa/google/enable', requireAuth, async (req, res) => {
    try {
        // Generate secret
        const secret = speakeasy.generateSecret({
            name: `Thinky (${req.session.username})`,
            issuer: 'Thinky'
        });

        // Generate QR code
        const qrCode = await QRCode.toDataURL(secret.otpauth_url);

        // Store secret temporarily in session (will be saved to DB after verification)
        req.session.pending2FASecret = secret.base32;

        res.json({
            secret: secret.base32,
            qrCode: qrCode,
            otpauth_url: secret.otpauth_url
        });
    } catch (error) {
        console.error('Enable Google Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Verify and activate Google Authenticator
app.post('/api/auth/2fa/google/verify', requireAuth, async (req, res) => {
    try {
        const { code } = req.body;

        if (!code || typeof code !== 'string' || code.length !== 6) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        const secret = req.session.pending2FASecret;
        if (!secret) {
            return res.status(400).json({ error: 'No pending 2FA setup found. Please start the setup again.' });
        }

        // Verify the code
        const verified = speakeasy.totp.verify({
            secret: secret,
            encoding: 'base32',
            token: code,
            window: 2 // Allow 2 time windows for clock drift
        });

        if (!verified) {
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Save secret to database
        const { error } = await supabaseAdmin
            .from('users')
            .update({
                two_factor_enabled: true,
                two_factor_secret: secret
            })
            .eq('id', req.session.userId);

        if (error) {
            console.error('Save 2FA secret error:', error);
            return res.status(500).json({ error: 'Failed to enable 2FA' });
        }

        // Clear pending secret
        delete req.session.pending2FASecret;

        res.json({ message: 'Google Authenticator enabled successfully' });
    } catch (error) {
        console.error('Verify Google Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Disable Google Authenticator
app.post('/api/auth/2fa/google/disable', requireAuth, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('users')
            .update({
                two_factor_enabled: false,
                two_factor_secret: null
            })
            .eq('id', req.session.userId);

        if (error) {
            console.error('Disable Google Auth error:', error);
            return res.status(500).json({ error: 'Failed to disable 2FA' });
        }

        res.json({ message: 'Google Authenticator disabled successfully' });
    } catch (error) {
        console.error('Disable Google Auth error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Enable Email 2FA
app.post('/api/auth/2fa/email/enable', requireAuth, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('users')
            .update({
                email_2fa_enabled: true
            })
            .eq('id', req.session.userId);

        if (error) {
            console.error('Enable Email 2FA error:', error);
            return res.status(500).json({ error: 'Failed to enable email 2FA' });
        }

        res.json({ message: 'Email 2FA enabled successfully' });
    } catch (error) {
        console.error('Enable Email 2FA error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Disable Email 2FA
app.post('/api/auth/2fa/email/disable', requireAuth, async (req, res) => {
    try {
        const { error } = await supabaseAdmin
            .from('users')
            .update({
                email_2fa_enabled: false
            })
            .eq('id', req.session.userId);

        if (error) {
            console.error('Disable Email 2FA error:', error);
            return res.status(500).json({ error: 'Failed to disable email 2FA' });
        }

        res.json({ message: 'Email 2FA disabled successfully' });
    } catch (error) {
        console.error('Disable Email 2FA error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Verify 2FA code (used during login)
app.post('/api/auth/2fa/verify', async (req, res) => {
    try {
        let { userId, code, type } = req.body;

        if (!userId || !code || !type) {
            console.warn('/api/auth/2fa/verify missing fields', { userId, code, type });
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // Normalize code: ensure string, remove whitespace
        try {
            code = String(code).replace(/\s/g, '').trim();
        } catch (e) {
            console.warn('Failed to normalize 2FA code', e);
        }

        // Get user
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('id', userId)
            .single();

        if (userError || !user) {
            return res.status(400).json({ error: 'Invalid user' });
        }

        let verified = false;

        if (type === 'google' && user.two_factor_enabled && user.two_factor_secret) {
            // Verify TOTP code
            verified = speakeasy.totp.verify({
                secret: user.two_factor_secret,
                encoding: 'base32',
                token: code,
                window: 2
            });
        } else if (type === 'email' && user.email_2fa_enabled) {
            // Verify email code from database
            console.log('Email 2FA verification requested for user:', userId, 'code:', code, 'type:', typeof code);
            
            // Fetch the latest unused code matching user and code, then validate expiry in server-side JS
            // Use admin client for this lookup to avoid RLS/permission issues
            const { data: codeRecord, error: codeError } = await supabaseAdmin
                .from('email_2fa_codes')
                .select('*')
                .eq('user_id', userId)
                .eq('code', code)
                .eq('used', false)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            console.log('Code lookup result:', { 
                found: !!codeRecord, 
                error: codeError, 
                searchCode: code,
                dbCode: codeRecord?.code,
                codesMatch: codeRecord?.code === code,
                userId: userId,
                dbUserId: codeRecord?.user_id,
                used: codeRecord?.used
            });

            if (!codeError && codeRecord) {
                try {
                    const expiresAt = new Date(codeRecord.expires_at);
                    const now = new Date();
                    console.log('Expiry check:', { expiresAt: expiresAt.toISOString(), now: now.toISOString(), valid: expiresAt > now });
                    
                    if (!isNaN(expiresAt.getTime()) && expiresAt > now) {
                        verified = true;
                        console.log('Email 2FA code verified successfully');
                        // Delete code after successful use to avoid leaving used rows
                        try {
                            await supabaseAdmin
                                .from('email_2fa_codes')
                                .delete()
                                .eq('id', codeRecord.id);
                        } catch (delErr) {
                            console.warn('Failed to delete used email_2fa_codes row:', delErr);
                            // Fallback: attempt to mark as used if delete fails
                            try {
                                await supabaseAdmin
                                    .from('email_2fa_codes')
                                    .update({ used: true })
                                    .eq('id', codeRecord.id);
                            } catch (updErr) {
                                console.error('Failed to mark email_2fa_codes row as used after delete failure:', updErr);
                            }
                        }
                    } else {
                        console.log('Email 2FA code expired or invalid date');
                    }
                } catch (e) {
                    console.warn('Error parsing expires_at for email_2fa_codes:', e);
                }
            } else {
                console.log('No matching email 2FA code found or DB error');
                try {
                    const { data: recentCodes, error: recentErr } = await supabaseAdmin
                        .from('email_2fa_codes')
                        .select('*')
                        .eq('user_id', userId)
                        .order('created_at', { ascending: false })
                        .limit(10);

                    console.log('Recent codes for user (debug):', { recentErr, recentCodes });
                } catch (dbgE) {
                    console.warn('Failed to fetch recent email_2fa_codes for debug:', dbgE);
                }
            }
        }

        if (!verified) {
            console.warn('2FA verify failed for user:', userId, 'type:', type);
            // Provide a helpful-but-safe error for debugging
            return res.status(400).json({ error: 'Invalid verification code' });
        }

        // Set session
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;

        await new Promise((resolve) => {
            req.session.save((err) => {
                if (err) console.warn('Session save error during 2FA login:', err);
                resolve();
            });
        });

        await trackLoginActivityAndNotify(req, user);

        res.json({
            message: '2FA verification successful',
            user: {
                id: user.id,
                email: user.email,
                username: user.username,
                role: user.role
            }
        });
    } catch (error) {
        console.error('2FA verify error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// ADMIN ROUTES
// =====================================================

// Get analytics
app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
    try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const [analyticsResult, onlineCountResult] = await Promise.all([
            supabase.from('admin_analytics').select('*').single(),
            supabaseAdmin.from('online_users').select('user_id', { count: 'exact', head: true }).gte('last_seen', fiveMinAgo)
        ]);

        if (analyticsResult.error) {
            console.error('Get analytics error:', analyticsResult.error);
            return res.status(500).json({ error: 'Failed to fetch analytics' });
        }

        // Override the view's stale count with a live count filtered to the last 5 minutes
        const analytics = { ...analyticsResult.data, current_online_users: onlineCountResult.count || 0 };
        res.json({ analytics });
    } catch (error) {
        console.error('Get analytics error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Analytics drill-down paginated endpoints ──────────────────────────────────

// GET /api/admin/users/list?page=1&limit=20&role=  (all users or filtered by role)
app.get('/api/admin/users/list', requireAdmin, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const role  = req.query.role || null;
        const from  = (page - 1) * limit;
        const to    = from + limit - 1;

        let q = supabaseAdmin
            .from('users')
            .select('id, username, display_name, profile_picture_url, role', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);

        if (role) q = q.eq('role', role);

        const { data, error, count } = await q;
        if (error) return res.status(500).json({ error: 'Failed to fetch users' });
        res.json({ items: data || [], total: count || 0, page, limit });
    } catch (e) {
        console.error('Admin users list error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/subjects/list?page=1&limit=20
app.get('/api/admin/subjects/list', requireAdmin, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const from  = (page - 1) * limit;
        const to    = from + limit - 1;

        const { data, error, count } = await supabaseAdmin
            .from('subjects')
            .select('id, name, created_at, users!user_id(id, username, display_name)', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);

        if (error) return res.status(500).json({ error: 'Failed to fetch subjects' });
        res.json({ items: data || [], total: count || 0, page, limit });
    } catch (e) {
        console.error('Admin subjects list error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create subject (admin)
app.post('/api/admin/subjects', requireAdmin, async (req, res) => {
    try {
        const { name, description, school, user_id } = req.body;
        if (!name) return res.status(400).json({ error: 'Subject name is required' });

        const cleanName = String(name).trim().slice(0, 200);
        const payload = { name: cleanName, description: description || '', school: school || null };
        if (user_id) payload.user_id = user_id;

        const { data: subject, error } = await supabaseAdmin
            .from('subjects')
            .insert([payload])
            .select()
            .single();

        if (error) {
            console.error('Admin create subject error:', error);
            return res.status(500).json({ error: 'Failed to create subject' });
        }

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public']);

        res.json({ subject });
    } catch (error) {
        console.error('Admin create subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update subject (admin)
app.put('/api/admin/subjects/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { name, description, school, user_id } = req.body;
        if (!name) return res.status(400).json({ error: 'Subject name is required' });

        const update = { name: String(name).trim().slice(0,200), description: description || '' };
        if (typeof school !== 'undefined') update.school = school || null;
        if (typeof user_id !== 'undefined') update.user_id = user_id || null;

        const { data: subject, error } = await supabaseAdmin
            .from('subjects')
            .update(update)
            .eq('id', id)
            .select()
            .single();

        if (error) {
            console.error('Admin update subject error:', error);
            return res.status(500).json({ error: 'Failed to update subject' });
        }

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public']);

        res.json({ subject });
    } catch (error) {
        console.error('Admin update subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete subject (admin)
app.delete('/api/admin/subjects/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('subjects')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Admin delete subject error:', error);
            return res.status(500).json({ error: 'Failed to delete subject' });
        }

        await invalidateCacheNamespaces(['subjects:user', 'subjects:public', 'reviewers:subject', 'reviewers:public-auth', 'reviewers:public-guest']);

        res.json({ message: 'Subject deleted successfully' });
    } catch (error) {
        console.error('Admin delete subject error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/reviewers/list?page=1&limit=20
app.get('/api/admin/reviewers/list', requireAdmin, async (req, res) => {
    try {
        const page  = Math.max(1, parseInt(req.query.page)  || 1);
        const limit = Math.min(50, parseInt(req.query.limit) || 20);
        const from  = (page - 1) * limit;
        const to    = from + limit - 1;

        const { data, error, count } = await supabaseAdmin
            .from('reviewers')
            .select('id, title, created_at, users!user_id(id, username, display_name)', { count: 'exact' })
            .order('created_at', { ascending: false })
            .range(from, to);

        if (error) return res.status(500).json({ error: 'Failed to fetch reviewers' });
        res.json({ items: data || [], total: count || 0, page, limit });
    } catch (e) {
        console.error('Admin reviewers list error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/admin/online-users/list?page=1&limit=20
app.get('/api/admin/online-users/list', requireAdmin, async (req, res) => {
    try {
        const page     = Math.max(1, parseInt(req.query.page)  || 1);
        const limit    = Math.min(50, parseInt(req.query.limit) || 20);
        const from     = (page - 1) * limit;
        const to       = from + limit - 1;
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

        const { data, error, count } = await supabaseAdmin
            .from('online_users')
            .select('user_id, username, last_seen, users!user_id(id, username, display_name, profile_picture_url)', { count: 'exact' })
            .gte('last_seen', fiveMinAgo)
            .order('last_seen', { ascending: false })
            .range(from, to);

        if (error) return res.status(500).json({ error: 'Failed to fetch online users' });
        res.json({ items: data || [], total: count || 0, page, limit });
    } catch (e) {
        console.error('Admin online users list error:', e);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, email, username, role, is_verified, created_at, ai_limit_exempt')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Get users error:', error);
            return res.status(500).json({ error: 'Failed to fetch users' });
        }

        res.json({ users });
    } catch (error) {
        console.error('Get users error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update user role
app.put('/api/admin/users/:id/role', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { role } = req.body;

        if (!['student', 'admin', 'moderator'].includes(role)) {
            return res.status(400).json({ error: 'Invalid role' });
        }

        const { data: user, error } = await supabaseAdmin
            .from('users')
            .update({ role })
            .eq('id', id)
            .select('id, email, username, role')
            .single();

        if (error) {
            console.error('Update role error:', error);
            return res.status(500).json({ error: 'Failed to update role' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Update role error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update user details (admin save modal expects this endpoint)
app.put('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { display_name, username, email, role, is_verified } = req.body;

        const update = {};
        if (typeof display_name !== 'undefined') update.display_name = display_name;
        if (typeof username !== 'undefined') update.username = username;
        if (typeof email !== 'undefined') update.email = email;
        if (typeof is_verified !== 'undefined') update.is_verified = !!is_verified;
        if (typeof role !== 'undefined') {
            if (!['student','moderator','admin'].includes(role)) {
                return res.status(400).json({ error: 'Invalid role' });
            }
            update.role = role;
        }
        if (typeof req.body.ai_limit_exempt !== 'undefined') {
            update.ai_limit_exempt = !!req.body.ai_limit_exempt;
        }

        const { data: user, error } = await supabaseAdmin
            .from('users')
            .update(update)
            .eq('id', id)
            .select('id, email, username, role, display_name, is_verified, ai_limit_exempt')
            .single();

        if (error) {
            console.error('Update user error:', error);
            return res.status(500).json({ error: 'Failed to update user' });
        }

        res.json({ user });
    } catch (error) {
        console.error('Update user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete user
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent self-deletion
        if (id === req.session.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
        }

        // Attempt to remove any avatar files belonging to this user from the
        // configured Supabase storage bucket. This is a best-effort cleanup so
        // we don't leave orphaned files behind after a user is removed.
        try {
            const bucket = process.env.SUPABASE_AVATAR_BUCKET || 'avatars';
            // List objects under the user's folder (prefix = user id)
            const { data: listData, error: listErr } = await supabaseAdmin.storage
                .from(bucket)
                .list(id, { limit: 1000 });

            if (listErr) {
                console.warn('Could not list avatar files for user', id, listErr.message || listErr);
            } else if (Array.isArray(listData) && listData.length > 0) {
                const paths = listData.map(item => `${id}/${item.name}`);
                const { error: removeErr } = await supabaseAdmin.storage.from(bucket).remove(paths);
                if (removeErr) {
                    console.warn('Failed to delete avatar files for user', id, removeErr.message || removeErr);
                } else {
                    console.info('Deleted avatar files for user', id, 'from bucket', bucket);
                }
            }
        } catch (e) {
            console.warn('Error while attempting to remove avatar folder for user', id, e && e.message ? e.message : e);
        }

        const { error } = await supabaseAdmin
            .from('users')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete user error:', error);
            return res.status(500).json({ error: 'Failed to delete user' });
        }

        res.json({ message: 'User deleted successfully' });
    } catch (error) {
        console.error('Delete user error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all reviewers (admin)
app.get('/api/admin/reviewers', requireAdmin, async (req, res) => {
    try {
        const { data: reviewers, error } = await supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (username, email),
                subjects:subject_id (name, school)
            `)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Get reviewers error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewers' });
        }

        res.json({ reviewers });
    } catch (error) {
        console.error('Get reviewers error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete any reviewer (admin)
app.delete('/api/admin/reviewers/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('reviewers')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete reviewer error:', error);
            return res.status(500).json({ error: 'Failed to delete reviewer' });
        }

        res.json({ message: 'Reviewer deleted successfully' });
    } catch (error) {
        console.error('Delete reviewer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete message (admin)
app.delete('/api/admin/messages/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('messages')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete message error:', error);
            return res.status(500).json({ error: 'Failed to delete message' });
        }

        res.json({ message: 'Message deleted successfully' });
    } catch (error) {
        console.error('Delete message error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Create school (admin)
app.post('/api/admin/schools', requireAdmin, async (req, res) => {
    try {
        console.info('POST /api/admin/schools invoked by session user', req.session && req.session.userId);
        const { name } = req.body;

        if (!name || !name.trim()) {
            return res.status(400).json({ error: 'School name is required' });
        }

        const { data: school, error } = await supabaseAdmin
            .from('verified_schools')
            .insert({
                name: name.trim()
            })
            .select()
            .single();

        if (error) {
            console.error('Create school error:', error);
            return res.status(500).json({ error: 'Failed to create school' });
        }

        await invalidateCacheNamespaces(['schools:list', 'subjects:public']);

        res.json({ school, message: 'School created successfully' });
    } catch (error) {
        console.error('Create school error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Delete school (admin)
app.delete('/api/admin/schools/:id', requireAdmin, async (req, res) => {
    try {
        console.info('DELETE /api/admin/schools/:id invoked by session user', req.session && req.session.userId, 'id=', req.params && req.params.id);
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('verified_schools')
            .delete()
            .eq('id', id);

        if (error) {
            console.error('Delete school error:', error);
            return res.status(500).json({ error: 'Failed to delete school' });
        }

        await invalidateCacheNamespaces(['schools:list', 'subjects:public']);

        res.json({ message: 'School deleted successfully' });
    } catch (error) {
        console.error('Delete school error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// POLICY MANAGEMENT ENDPOINTS (ADMIN ONLY)
// =====================================================

// Get all policies (cacheable - policies rarely change)
app.get('/api/policies', cacheResponse({ namespace: 'policies:list', ttlSeconds: 300 }), async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('policies')
            .select('*')
            .order('id', { ascending: true });

        if (error) throw error;

        // Cache for 5 minutes - policies are semi-static
        res.set('Cache-Control', 'public, max-age=300');
        res.json(data || []);
    } catch (error) {
        console.error('Get policies error:', error);
        res.status(500).json({ error: 'Failed to fetch policies' });
    }
});

// Get last updated timestamp for policies
app.get('/api/policies/last-updated', cacheResponse({ namespace: 'policies:last-updated', ttlSeconds: 120 }), async (req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from('policies')
            .select('updated_at')
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();

        if (error && error.code !== 'PGRST116') throw error;

        res.json({ lastUpdated: data?.updated_at || null });
    } catch (error) {
        console.error('Get policies last updated error:', error);
        res.status(500).json({ error: 'Failed to fetch last updated' });
    }
});

// Create new policy (admin only)
app.post('/api/admin/policies', requireAdmin, async (req, res) => {
    try {
        const { title, description, category } = req.body;

        if (!title || !description || !category) {
            return res.status(400).json({ error: 'Title, description, and category are required' });
        }

        if (!['reviewer', 'message', 'both'].includes(category)) {
            return res.status(400).json({ error: 'Category must be reviewer, message, or both' });
        }

        const { data, error } = await supabaseAdmin
            .from('policies')
            .insert([{ title, description, category }])
            .select()
            .single();

        if (error) throw error;

        await invalidateCacheNamespaces(['policies:list', 'policies:last-updated']);

        res.json(data);
    } catch (error) {
        console.error('Create policy error:', error);
        res.status(500).json({ error: 'Failed to create policy' });
    }
});

// Update policy (admin only)
app.put('/api/admin/policies/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, category } = req.body;

        if (!title || !description || !category) {
            return res.status(400).json({ error: 'Title, description, and category are required' });
        }

        if (!['reviewer', 'message', 'both'].includes(category)) {
            return res.status(400).json({ error: 'Category must be reviewer, message, or both' });
        }

        const { data, error } = await supabaseAdmin
            .from('policies')
            .update({ title, description, category, updated_at: new Date().toISOString() })
            .eq('id', id)
            .select()
            .single();

        if (error) throw error;

        await invalidateCacheNamespaces(['policies:list', 'policies:last-updated']);

        res.json(data);
    } catch (error) {
        console.error('Update policy error:', error);
        res.status(500).json({ error: 'Failed to update policy' });
    }
});

// Delete policy (admin only)
app.delete('/api/admin/policies/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabaseAdmin
            .from('policies')
            .delete()
            .eq('id', id);

        if (error) throw error;

        await invalidateCacheNamespaces(['policies:list', 'policies:last-updated']);

        res.json({ message: 'Policy deleted successfully' });
    } catch (error) {
        console.error('Delete policy error:', error);
        res.status(500).json({ error: 'Failed to delete policy' });
    }
});

// =====================================================
// SERVE HTML PAGES
// =====================================================

// Public pages
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/register', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

// Public user profile page (allow access for guests)
app.get('/user', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Also explicitly serve the static .html path so some proxies/links resolve the same way
app.get('/user.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'user.html'));
});

// Protected pages
app.get('/dashboard', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.get('/chat', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'chat.html'));
});

app.get('/admin', (req, res) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/moderator', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    // allow moderators and admins to access the moderator console
    // server-side enforcement of role happens in API endpoints; here we simply serve the page
    res.sendFile(path.join(__dirname, 'public', 'moderator.html'));
});

// Profile and Settings (protected)
app.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Settings page (protected)
app.get('/settings', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});

// Also serve explicit settings.html path
app.get('/settings.html', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});


// =====================================================
// NOTIFICATIONS API
// =====================================================

// Helper function to create a notification AND fire a push notification
async function createNotification({ userId, type, title, message, link, relatedUserId, relatedItemId }) {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .insert([{
                user_id: userId,
                type,
                title,
                message,
                link,
                related_user_id: relatedUserId,
                related_item_id: relatedItemId
            }]);
        
        if (error) {
            console.error('Failed to create notification:', error);
        }
    } catch (err) {
        console.error('Create notification error:', err);
    }

    // Fire push notification (non-blocking)
    sendPushToUser(userId, {
        title,
        body: message,
        url: link || '/dashboard.html',
        type,
        tag: `${type}-${relatedItemId || relatedUserId || userId}`,
    }).catch(() => {});
}

// ── Push subscription endpoints ───────────────────────────────────────────────

// GET /api/push/vapid-public-key — returns VAPID public key for client subscription
app.get('/api/push/vapid-public-key', (req, res) => {
    if (!process.env.VAPID_PUBLIC_KEY) {
        return res.status(503).json({ error: 'Push notifications not configured' });
    }
    res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — save or refresh a push subscription for the current user
app.post('/api/push/subscribe', requireAuth, async (req, res) => {
    try {
        const { endpoint, keys } = req.body;
        if (!endpoint || !keys?.p256dh || !keys?.auth) {
            return res.status(400).json({ error: 'Invalid subscription object' });
        }
        const userId = req.session.userId;

        // Upsert — if same user+endpoint already exists, update keys
        const { error } = await supabaseAdmin
            .from('push_subscriptions')
            .upsert(
                [{ user_id: userId, endpoint, p256dh: keys.p256dh, auth: keys.auth }],
                { onConflict: 'user_id,endpoint' }
            );

        if (error) {
            console.error('Push subscribe error:', error);
            return res.status(500).json({ error: 'Failed to save subscription' });
        }
        res.json({ success: true });
    } catch (err) {
        console.error('Push subscribe error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// DELETE /api/push/unsubscribe — remove push subscription
app.delete('/api/push/unsubscribe', requireAuth, async (req, res) => {
    try {
        const { endpoint } = req.body;
        const userId = req.session.userId;
        const query = supabaseAdmin.from('push_subscriptions').delete().eq('user_id', userId);
        if (endpoint) query.eq('endpoint', endpoint);
        await query;
        res.json({ success: true });
    } catch (err) {
        console.error('Push unsubscribe error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// GET /api/notifications - Get user's notifications
app.get('/api/notifications', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const unreadOnly = req.query.unread === 'true';

        let query = supabaseAdmin
            .from('notifications')
            .select('*, related_user:related_user_id(username, profile_picture_url)')
            .eq('user_id', userId)
            .order('created_at', { ascending: false })
            .range(offset, offset + limit - 1);

        if (unreadOnly) {
            query = query.eq('is_read', false);
        }

        const { data: notifications, error } = await query;

        if (error) {
            console.error('Get notifications error:', error);
            return res.status(500).json({ error: 'Failed to fetch notifications' });
        }

        // Get unread count
        const { count: unreadCount } = await supabaseAdmin
            .from('notifications')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        res.json({ notifications: notifications || [], unreadCount: unreadCount || 0 });
    } catch (error) {
        console.error('Get notifications error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/notifications/:id/read - Mark notification as read
app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.session.userId;

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .eq('id', id)
            .eq('user_id', userId);

        if (error) {
            console.error('Mark notification as read error:', error);
            return res.status(500).json({ error: 'Failed to mark notification as read' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Mark notification as read error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// PUT /api/notifications/read-all - Mark all notifications as read
app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
    try {
        const userId = req.session.userId;

        const { error } = await supabaseAdmin
            .from('notifications')
            .update({ is_read: true })
            .eq('user_id', userId)
            .eq('is_read', false);

        if (error) {
            console.error('Mark all notifications as read error:', error);
            return res.status(500).json({ error: 'Failed to mark all notifications as read' });
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Mark all notifications as read error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// =====================================================
// AI ROUTES (Google Gemini 1.5 Flash — Free Tier)
// =====================================================

// ── Discord error notifier ───────────────────────────────────────────────
async function notifyDiscord(title, fields) {
    const url = process.env.DISCORD_ERROR_WEBHOOK;
    if (!url) return;
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                embeds: [{
                    title,
                    color: 0xe74c3c,
                    timestamp: new Date().toISOString(),
                    fields: fields.map(([name, value]) => ({
                        name,
                        value: String(value).slice(0, 1024),
                        inline: false
                    }))
                }]
            })
        });
    } catch (_) { /* never let Discord reporting break anything */ }
}

// ── AI Daily-limit helpers ────────────────────────────────────────────────
const AI_DAILY_LIMIT = 5; // max uses per type per UTC day

/**
 * Check whether userId has exceeded their daily AI limit for the given type.
 * Returns { allowed: true, used, limit } or { allowed: false, used, limit }.
 * Exempt users always get { allowed: true }.
 */
async function checkAiLimit(userId, usageType) {
    // 1) Is user exempt?
    const { data: userRow } = await supabaseAdmin
        .from('users')
        .select('ai_limit_exempt')
        .eq('id', userId)
        .single();
    if (userRow?.ai_limit_exempt) return { allowed: true, used: 0, limit: null, exempt: true };

    // 2) How many uses today?
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
    const { data: row } = await supabaseAdmin
        .from('ai_usage_log')
        .select('count')
        .eq('user_id', userId)
        .eq('usage_type', usageType)
        .eq('used_date', today)
        .maybeSingle();

    const used = row?.count ?? 0;
    return { allowed: used < AI_DAILY_LIMIT, used, limit: AI_DAILY_LIMIT, exempt: false };
}

/**
 * Increment the usage counter for userId/usageType today.
 * Uses an upsert so the first call creates the row.
 */
async function incrementAiUsage(userId, usageType) {
    const today = new Date().toISOString().slice(0, 10);
    // Try update first (most common path)
    const { data: existing } = await supabaseAdmin
        .from('ai_usage_log')
        .select('id, count')
        .eq('user_id', userId)
        .eq('usage_type', usageType)
        .eq('used_date', today)
        .maybeSingle();

    if (existing) {
        await supabaseAdmin
            .from('ai_usage_log')
            .update({ count: existing.count + 1 })
            .eq('id', existing.id);
    } else {
        await supabaseAdmin
            .from('ai_usage_log')
            .insert({ user_id: userId, usage_type: usageType, used_date: today, count: 1 });
    }
}
// ─────────────────────────────────────────────────────────────────────────

// Resolve effective MIME from file extension — mobile browsers (iOS, Android) frequently
// send wrong MIME types (application/octet-stream, application/zip for .docx, etc.).
// Extension is the reliable ground truth.
const EXT_TO_MIME = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt:  'text/plain',
    ppt:  'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg'
};
function resolveFileMime(originalname, fallbackMime) {
    const ext = (originalname || '').toLowerCase().split('.').pop();
    return EXT_TO_MIME[ext] || fallbackMime;
}

const AI_INLINE_FILE_BYTES = 8 * 1024 * 1024;
const AI_MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB — must match Vercel bodySizeLimit in vercel.json

function decodeXmlEntities(text) {
    return String(text || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCharCode(parseInt(code, 16)));
}

function isLikelyPptxMetadataText(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) return true;

    const exactBadPhrases = new Set([
        'text formatting properties',
        'paragraph formatting properties'
    ]);
    if (exactBadPhrases.has(normalized)) return true;

    return /^(language|font size|font weight|font style|kerning|capitalization|color|typeface|margins?|indent level|alignment|default tab size|line spacing|space before paragraph|space after paragraph|bullets|line breaks|hanging punctuation)\s*:/i.test(normalized);
}

// Legacy .ppt is not accepted as inline MIME by Gemini. Extract readable text
// from binary streams (ASCII + UTF-16LE) and feed that text to the model.
function extractTextFromLegacyPpt(buffer) {
    if (!buffer || !buffer.length) return '';

    const asciiChunks = (buffer.toString('latin1').match(/[A-Za-z0-9][A-Za-z0-9 .,;:()'"!?&%$#@/\\+\-=\[\]{}<>]{5,}/g) || [])
        .map(s => s.trim());

    const utf16Chunks = (buffer.toString('utf16le').replace(/[\u0000-\u001f]+/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9 .,;:()'"!?&%$#@/\\+\-=\[\]{}<>]{5,}/g) || [])
        .map(s => s.trim());

    const merged = [...asciiChunks, ...utf16Chunks];
    const deduped = [];
    const seen = new Set();
    for (const chunk of merged) {
        const normalized = chunk.toLowerCase();
        if (!seen.has(normalized)) {
            seen.add(normalized);
            deduped.push(chunk);
        }
    }

    return deduped.join('\n').slice(0, 50000);
}

async function extractTextFromPdf(buffer) {
    // Import the library entry directly; importing `pdf-parse` package root can
    // trigger its debug harness in some module-loading contexts.
    const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js');
    const pdfParse = pdfParseModule.default || pdfParseModule;
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || '').replace(/\s+/g, ' ').trim().slice(0, 50000);
}

async function extractTextFromPptx(buffer) {
    const jszipModule = await import('jszip');
    const JSZip = jszipModule.default || jszipModule;
    const zip = await JSZip.loadAsync(buffer);
    const fileNames = Object.keys(zip.files || {});
    const slidePaths = fileNames
        .filter(name => /^ppt\/slides\/slide\d+\.xml$/i.test(name))
        .sort((a, b) => {
            const aNum = parseInt((a.match(/slide(\d+)\.xml/i) || [,'0'])[1], 10);
            const bNum = parseInt((b.match(/slide(\d+)\.xml/i) || [,'0'])[1], 10);
            return aNum - bNum;
        });

    const collected = [];
    for (const path of slidePaths) {
        const file = zip.files[path];
        if (!file) continue;
        const xml = await file.async('string');
        const chunks = [];
        xml.replace(/<(?:a:)?t[^>]*>([\s\S]*?)<\/(?:a:)?t>/g, (_m, chunk) => {
            const clean = decodeXmlEntities(chunk).replace(/\s+/g, ' ').trim();
            if (clean && !isLikelyPptxMetadataText(clean)) chunks.push(clean);
            return _m;
        });
        if (chunks.length) collected.push(chunks.join(' '));
    }

    return collected.join('\n').replace(/\n{2,}/g, '\n').trim().slice(0, 50000);
}

function renderPdfBuffer(build) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 56, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        try {
            build(doc);
            doc.end();
        } catch (error) {
            reject(error);
        }
    });
}

async function createPdfFromTextContent(title, text) {
    const safeTitle = String(title || 'Uploaded File').slice(0, 200);
    const normalized = String(text || '')
        .replace(/\r/g, '')
        .replace(/\u0000/g, '')
        .replace(/[\t ]+\n/g, '\n')
        .trim();

    return renderPdfBuffer(doc => {
        doc.info.Title = safeTitle;
        doc.font('Helvetica-Bold').fontSize(18).text(safeTitle, { align: 'left' });
        doc.moveDown();
        doc.font('Helvetica').fontSize(11);

        const paragraphs = normalized.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
        if (!paragraphs.length) {
            doc.text('No readable text could be extracted from this file.');
            return;
        }

        for (const paragraph of paragraphs) {
            doc.text(paragraph, { align: 'left', paragraphGap: 6 });
            doc.moveDown(0.35);
        }
    });
}

async function createPdfFromImageContent(title, buffer) {
    const safeTitle = String(title || 'Uploaded Image').slice(0, 200);
    return renderPdfBuffer(doc => {
        doc.info.Title = safeTitle;
        doc.font('Helvetica-Bold').fontSize(16).text(safeTitle, { align: 'left' });
        doc.moveDown();

        const x = doc.page.margins.left;
        const y = doc.y;
        const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
        const height = doc.page.height - y - doc.page.margins.bottom;
        doc.image(buffer, x, y, { fit: [width, height], align: 'center', valign: 'center' });
    });
}

async function normalizeAiUploadToPdf({ buffer, effectiveMime, originalname }) {
    const fileTitle = String(originalname || 'Uploaded File');

    if (effectiveMime === 'application/pdf') {
        if (buffer.length > AI_INLINE_FILE_BYTES) {
            const textContent = await extractTextFromPdf(buffer);
            if (textContent && textContent.trim().length >= 40) {
                return {
                    pdfBuffer: await createPdfFromTextContent(fileTitle, textContent),
                    sourceDescription: 'uploaded PDF document converted to a compact PDF'
                };
            }
        }
        return { pdfBuffer: buffer, sourceDescription: 'uploaded PDF document' };
    }

    if (effectiveMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        const mammoth = (await import('mammoth')).default;
        const result = await mammoth.extractRawText({ buffer });
        const textContent = String(result.value || '').trim();
        if (textContent.length < 40) {
            throw new Error('This .docx file could not be reliably parsed. Please export/convert it to .pdf or .txt and try again.');
        }
        return {
            pdfBuffer: await createPdfFromTextContent(fileTitle, textContent),
            sourceDescription: 'uploaded Word (.docx) file converted to PDF'
        };
    }

    if (effectiveMime === 'application/vnd.ms-powerpoint') {
        const textContent = extractTextFromLegacyPpt(buffer);
        if (textContent.trim().length < 40) {
            throw new Error('This .ppt file could not be reliably parsed. Please export/convert it to .pptx, .pdf, or .txt and try again.');
        }
        return {
            pdfBuffer: await createPdfFromTextContent(fileTitle, textContent),
            sourceDescription: 'uploaded PowerPoint (.ppt) file converted to PDF'
        };
    }

    if (effectiveMime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
        const textContent = await extractTextFromPptx(buffer);
        if (textContent.trim().length < 40) {
            throw new Error('This .pptx file could not be reliably parsed. Please export/convert it to .pdf or .txt and try again.');
        }
        return {
            pdfBuffer: await createPdfFromTextContent(fileTitle, textContent),
            sourceDescription: 'uploaded PowerPoint (.pptx) file converted to PDF'
        };
    }

    if (effectiveMime === 'image/png' || effectiveMime === 'image/jpeg') {
        return {
            pdfBuffer: await createPdfFromImageContent(fileTitle, buffer),
            sourceDescription: 'uploaded image converted to PDF'
        };
    }

    const textContent = buffer.toString('utf-8').trim();
    if (textContent.length < 5) {
        throw new Error('This text file is empty or could not be read.');
    }
    return {
        pdfBuffer: await createPdfFromTextContent(fileTitle, textContent),
        sourceDescription: 'uploaded text file converted to PDF'
    };
}

const aiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AI_MAX_UPLOAD_BYTES },
    fileFilter: (_req, file, cb) => {
        // Always resolve by extension — mobile browsers send unreliable MIME types
        const effectiveMime = resolveFileMime(file.originalname, file.mimetype);
        const allowedMimes = Object.values(EXT_TO_MIME);
        if (allowedMimes.includes(effectiveMime)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, DOCX, TXT, PPT, PPTX, PNG, and JPG files are allowed'));
        }
    }
});

// ── Puter.js AI (used for content moderation) ─────────────────────────────
// Models in preference order; tries each until one succeeds.
const PUTER_MODERATION_MODELS = [
    'claude-haiku-4-5',
    'claude-sonnet-4-6',
];

async function callPuter(prompt, returnJson = true) {
    let lastError;
    for (const model of PUTER_MODERATION_MODELS) {
        try {
            const response = await puter.ai.chat(prompt, { model });

            // Try every known response shape from puter.js Node SDK + browser SDK
            let text = null;
            if (typeof response === 'string') {
                text = response;
            } else if (response?.message?.content?.[0]?.text) {
                text = response.message.content[0].text;
            } else if (typeof response?.message?.content === 'string') {
                text = response.message.content;
            } else if (typeof response?.message === 'string') {
                text = response.message;
            } else if (response?.content?.[0]?.text) {
                text = response.content[0].text;
            } else if (typeof response?.content === 'string') {
                text = response.content;
            } else if (response?.choices?.[0]?.message?.content) {
                text = response.choices[0].message.content;
            } else if (response?.text) {
                text = typeof response.text === 'string' ? response.text : null;
            } else if (response?.result) {
                text = typeof response.result === 'string' ? response.result : JSON.stringify(response.result);
            }

            if (!text) {
                // Log the raw shape so we can diagnose the actual format
                console.warn(`[AI] Puter model "${model}" returned empty text. Raw response:`,
                    JSON.stringify(response)?.slice(0, 400));
                lastError = new Error(`Empty response from Puter model "${model}"`);
                continue;
            }

            if (!returnJson) return text;

            let jsonText = text.trim();
            // Strip extended-thinking <thinking> blocks that Claude may prepend
            jsonText = jsonText.replace(/<thinking>[\s\S]*?<\/antml:thinking>/gi, '').trim();
            // Strip markdown code fences
            if (jsonText.startsWith('```')) {
                jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
            }
            let parsed = null;
            try { parsed = JSON.parse(jsonText); } catch (_) {}
            if (!parsed) {
                // Try extracting a JSON object
                const objMatch = jsonText.match(/\{[\s\S]*\}/);
                if (objMatch) try { parsed = JSON.parse(objMatch[0]); } catch (_) {}
            }
            if (!parsed) {
                // Try extracting a JSON array
                const arrMatch = jsonText.match(/\[[\s\S]*\]/);
                if (arrMatch) try { parsed = JSON.parse(arrMatch[0]); } catch (_) {}
            }
            if (parsed) return parsed;

            console.warn(`[AI] Puter model "${model}" returned unparseable JSON. Text snippet:`, jsonText.slice(0, 300));
            lastError = new Error(`Puter model "${model}" returned malformed JSON`);
        } catch (err) {
            lastError = err;
            console.warn(`[AI] Puter model "${model}" error: ${err.message}, trying next...`);
        }
    }
    throw lastError || new Error('All Puter AI models are currently unavailable.');
}
// ─────────────────────────────────────────────────────────────────────────────

// Ordered list of models to try — cycles through all before giving up
// Uses currently available API model identifiers; falls back down the list on any capacity/quota/not-found error
const GEMINI_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b'
];

// Returns true if the error should cause a fallback to the next model rather than an immediate failure
function isGeminiRetryableError(status, errMsg) {
    if (status === 429 || status === 503 || status === 500 || status === 502 || status === 504) return true;
    // Quota / token exhaustion messages that Google returns as 400
    const msg = (errMsg || '').toLowerCase();
    return msg.includes('quota') ||
           msg.includes('exhausted') ||
           msg.includes('resource_exhausted') ||
           msg.includes('rate limit') ||
           msg.includes('rate_limit') ||
           msg.includes('too many requests') ||
           msg.includes('token') ||
           msg.includes('limit exceeded') ||
           msg.includes('overloaded') ||
           msg.includes('unavailable') ||
           msg.includes('capacity') ||
           msg.includes('not found') ||
           msg.includes('not supported') ||
           msg.includes('does not exist') ||
           msg.includes('deprecated') ||
           msg.includes('no longer available');
}

// Parse comma-separated GEMINI_API_KEYS (falls back to legacy GEMINI_API_KEY)
function getGeminiApiKeys() {
    const multi = process.env.GEMINI_API_KEYS;
    if (multi) return multi.split(',').map(k => k.trim()).filter(Boolean);
    const single = process.env.GEMINI_API_KEY;
    return single ? [single] : [];
}

async function callGemini(prompt, sourceFile = null, returnJson = true) {
    const apiKeys = getGeminiApiKeys();
    if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');

    const parts = [];
    if (sourceFile) {
        if (typeof sourceFile === 'string') {
            // Backward-compatible path for existing PDF callers that pass base64 directly.
            parts.push({ inlineData: { mimeType: 'application/pdf', data: sourceFile } });
        } else if (sourceFile.data && sourceFile.mimeType) {
            parts.push({ inlineData: { mimeType: sourceFile.mimeType, data: sourceFile.data } });
        }
    }
    parts.push({ text: prompt });

    let lastError;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const MAX_RETRY_MS = 30000; // max wait for a Retry-After suggestion

    // Prefer trying models first; for each model try all API keys.
    for (const model of GEMINI_MODELS) {
        let suggestedRetryMs = null;

        for (const apiKey of apiKeys) {
            let resp;
            try {
                resp = await fetch(
                    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                    {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ parts }],
                            generationConfig: {
                                ...(returnJson ? { response_mime_type: 'application/json' } : {}),
                                temperature: 0.3,
                                maxOutputTokens: 65536
                            }
                        })
                    }
                );
            } catch (networkErr) {
                lastError = networkErr;
                console.warn(`[AI] Model "${model}" network error (key), trying next key...`, networkErr.message);
                continue;
            }

            if (!resp.ok) {
                const errBody = await resp.json().catch(() => ({}));
                const errMsg = errBody.error?.message || `Gemini API error: ${resp.status}`;

                if (resp.status === 401 || resp.status === 403) {
                    // Invalid/revoked key — try the next key for this model
                    lastError = new Error(errMsg);
                    console.warn(`[AI] API key rejected (${resp.status}) for model "${model}", trying next key...`);
                    continue;
                }

                if (resp.status === 429) {
                    // Record retry suggestion if present, then try next key
                    let retryMs = null;
                    try {
                        const ra = resp.headers && resp.headers.get ? resp.headers.get('Retry-After') : null;
                        if (ra) {
                            const raInt = parseInt(ra, 10);
                            if (!isNaN(raInt)) retryMs = raInt * 1000;
                            else {
                                const raDate = new Date(ra);
                                if (!isNaN(raDate.getTime())) retryMs = Math.max(0, raDate.getTime() - Date.now());
                            }
                        } else {
                            const m = (errMsg || '').match(/please retry in\s*([\d.]+)\s*s/i) || (errMsg || '').match(/retry in\s*([\d.]+)\s*s/i) || (errMsg || '').match(/retry in\s*([\d.]+)\s*seconds/i);
                            if (m) retryMs = Math.round(parseFloat(m[1]) * 1000);
                        }
                    } catch (_) { /* ignore */ }

                    if (retryMs) suggestedRetryMs = suggestedRetryMs === null ? retryMs : Math.min(suggestedRetryMs, retryMs);
                    lastError = new Error(errMsg);
                    console.warn(`[AI] Model "${model}" rate-limited (${resp.status}: ${errMsg}), trying next key...`);
                    continue;
                }

                if (isGeminiRetryableError(resp.status, errMsg)) {
                    lastError = new Error(errMsg);
                    console.warn(`[AI] Model "${model}" unavailable (${resp.status}: ${errMsg}), trying next key...`);
                    continue;
                }

                // Non-retryable error (e.g. 400 bad request) — fail immediately
                throw new Error(errMsg);
            }

            const data = await resp.json();
            const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

            // Empty/blocked response — try next key instead of hard-failing
            const finishReason = data.candidates?.[0]?.finishReason;
            if (!text) {
                const blockReason = data.promptFeedback?.blockReason;
                if (blockReason) {
                    throw new Error(`Request blocked by Gemini safety filters: ${blockReason}`);
                }
                lastError = new Error(`Empty response from model "${model}" (finishReason: ${finishReason || 'unknown'})`);
                console.warn(`[AI] Model "${model}" returned empty text, trying next key...`);
                continue;
            }

            // Truncated response — output was cut off at the token limit, JSON will be malformed
            if (finishReason === 'MAX_TOKENS') {
                lastError = new Error(`Response from model "${model}" was truncated (MAX_TOKENS) — JSON likely incomplete`);
                console.warn(`[AI] Model "${model}" hit MAX_TOKENS, trying next key...`);
                continue;
            }

            if (returnJson) {
                let jsonText = text.trim();
                // Strip markdown code fences that Gemini sometimes adds despite response_mime_type
                if (jsonText.startsWith('```')) {
                    jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
                }
                let parsed = null;
                // Attempt 1: direct parse
                try { parsed = JSON.parse(jsonText); } catch (_) {}
                // Attempt 2: extract outermost {...} or [...] in case there's surrounding prose
                if (!parsed) {
                    const objMatch = jsonText.match(/\{[\s\S]*\}/);
                    if (objMatch) try { parsed = JSON.parse(objMatch[0]); } catch (_) {}
                }
                if (!parsed) {
                    const arrMatch = jsonText.match(/\[[\s\S]*\]/);
                    if (arrMatch) try { parsed = JSON.parse(arrMatch[0]); } catch (_) {}
                }
                // Attempt 3: trim trailing incomplete property/comma and close open braces (handles real truncation)
                if (!parsed) {
                    try {
                        let s = jsonText.replace(/,\s*$/, '').replace(/[^}\]]+$/, '');
                        const stack = [];
                        for (const ch of s) {
                            if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
                            else if (ch === '}' || ch === ']') stack.pop();
                        }
                        s = s + stack.reverse().join('');
                        parsed = JSON.parse(s);
                    } catch (_) {}
                }
                if (parsed) return parsed;
                // All parse attempts failed — treat as retryable so the next model gets a shot
                lastError = new Error(`Model "${model}" returned malformed JSON (SyntaxError)`);
                console.warn(`[AI] Model "${model}" returned unparseable JSON, trying next key...`);
                continue;
            }
            return text;
        }

        // If one or more keys suggested a short retry, wait and attempt one more pass for this model
        if (suggestedRetryMs && suggestedRetryMs > 0 && suggestedRetryMs <= MAX_RETRY_MS) {
            const waitMs = Math.min(suggestedRetryMs, MAX_RETRY_MS);
            console.warn(`[AI] Waiting ${Math.round(waitMs/1000)}s to retry model "${model}" across API keys after rate-limit suggestion...`);
            await sleep(waitMs);

            for (const apiKey of apiKeys) {
                try {
                    const resp2 = await fetch(
                        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
                        {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ parts }],
                                generationConfig: {
                                    ...(returnJson ? { response_mime_type: 'application/json' } : {}),
                                    temperature: 0.3,
                                    maxOutputTokens: 65536
                                }
                            })
                        }
                    );
                    if (!resp2.ok) {
                        const errBody = await resp2.json().catch(() => ({}));
                        const errMsg = errBody.error?.message || `Gemini API error: ${resp2.status}`;
                        if (resp2.status === 401 || resp2.status === 403) {
                            lastError = new Error(errMsg);
                            continue;
                        }
                        lastError = new Error(errMsg);
                        continue;
                    }
                    const data2 = await resp2.json();
                    const text2 = data2.candidates?.[0]?.content?.parts?.[0]?.text;
                    const finishReason2 = data2.candidates?.[0]?.finishReason;
                    if (!text2) {
                        const blockReason = data2.promptFeedback?.blockReason;
                        if (blockReason) throw new Error(`Request blocked by Gemini safety filters: ${blockReason}`);
                        lastError = new Error(`Empty response from model "${model}" on retry`);
                        continue;
                    }
                    if (finishReason2 === 'MAX_TOKENS') {
                        lastError = new Error(`Response from model "${model}" was truncated (MAX_TOKENS) on retry`);
                        continue;
                    }
                    if (returnJson) {
                        let jsonText = text2.trim();
                        if (jsonText.startsWith('```')) {
                            jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
                        }
                        let parsed = null;
                        try { parsed = JSON.parse(jsonText); } catch (_) {}
                        if (!parsed) {
                            const objMatch = jsonText.match(/\{[\s\S]*\}/);
                            if (objMatch) try { parsed = JSON.parse(objMatch[0]); } catch (_) {}
                        }
                        if (!parsed) {
                            const arrMatch = jsonText.match(/\[[\s\S]*\]/);
                            if (arrMatch) try { parsed = JSON.parse(arrMatch[0]); } catch (_) {}
                        }
                        if (!parsed) {
                            try {
                                let s = jsonText.replace(/,\s*$/, '').replace(/[^}\]]+$/, '');
                                const stack = [];
                                for (const ch of s) {
                                    if (ch === '{' || ch === '[') stack.push(ch === '{' ? '}' : ']');
                                    else if (ch === '}' || ch === ']') stack.pop();
                                }
                                s = s + stack.reverse().join('');
                                parsed = JSON.parse(s);
                            } catch (_) {}
                        }
                        if (parsed) return parsed;
                        lastError = new Error(`Model "${model}" returned malformed JSON (SyntaxError) on retry`);
                        continue;
                    }
                    return text2;
                } catch (retryErr) {
                    lastError = retryErr;
                    continue;
                }
            }
        }
        // Nothing for this model worked — try next model
    }

    throw lastError || new Error('All Gemini models are currently unavailable. Please try again later.');
}

// POST /api/ai/generate-reviewer — upload a PDF/DOCX/TXT and generate a reviewer
app.post('/api/ai/generate-reviewer', (req, res, next) => {
    // Log auth failures with browser details so we can diagnose mobile cookie issues
    if (!req.session || !req.session.userId) {
        notifyDiscord('🟡 AI Generate — Auth Failed (No Session)', [
            ['User-Agent', req.headers['user-agent'] || 'n/a'],
            ['Cookie header present', req.headers.cookie ? 'yes' : 'no'],
            ['Origin', req.headers.origin || 'n/a'],
            ['Referer', req.headers.referer || 'n/a'],
            ['Time (UTC)', new Date().toISOString()]
        ]);
    }
    next();
}, requireAuth, (req, res, next) => {
    // Run multer manually so errors (file-type rejection, size, parse failures)
    // are caught here instead of bypassing the route's try/catch and Discord notifier.
    aiUpload.single('file')(req, res, (multerErr) => {
        if (multerErr) {
            const rawMime = req.headers['content-type'] || 'unknown';
            notifyDiscord('🔴 AI Generate — Multer/Upload Error', [
                ['Multer Error', multerErr.message || String(multerErr)],
                ['Content-Type header', rawMime],
                ['User', _userLink(req)],
                ['Time (UTC)', new Date().toISOString()]
            ]);
            return res.status(400).json({ error: multerErr.message || 'File upload failed.' });
        }
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file) {
            notifyDiscord('🔴 AI Generate — No File Received', [
                ['Content-Type header', req.headers['content-type'] || 'unknown'],
                ['Body keys', Object.keys(req.body || {}).join(', ') || 'none'],
                ['User', _userLink(req)],
                ['Time (UTC)', new Date().toISOString()]
            ]);
            return res.status(400).json({ error: 'No file uploaded' });
        }
        if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'Auto generation is not available right now. Please try again later.' });

        // ── Daily limit check ──
        const limitCheck = await checkAiLimit(req.session.userId, 'reviewer');
        if (!limitCheck.allowed) {
            return res.status(429).json({
                error: `Daily auto-generate limit reached (${limitCheck.limit}/day). Limit resets at midnight UTC.`,
                used: limitCheck.used,
                limit: limitCheck.limit
            });
        }

        const { mimetype, buffer, originalname } = req.file;
        const includeFlashcards = String(req.body?.includeFlashcards ?? 'true').toLowerCase() !== 'false';
        // Always resolve by extension — mobile browsers (iOS octet-stream, Android application/zip
        // for .docx, etc.) send unreliable MIME types.
        const effectiveMime = resolveFileMime(originalname, mimetype);

        let normalizedPdf;
        try {
            normalizedPdf = await normalizeAiUploadToPdf({ buffer, effectiveMime, originalname });
        } catch (normalizeError) {
            return res.status(400).json({ error: normalizeError.message || 'This file could not be converted to PDF for auto-generation.' });
        }

        const flashcardRulesBlock = includeFlashcards
            ? `- Create one flashcard for EVERY important term, concept, process, person, formula, and fact in the source.
    - Do NOT limit the count — aim for complete coverage of all material, not a short list.
    - front: the term or question (concise, plain text — no HTML, no Markdown)
    - back: a clear, complete explanation or answer (plain text — no HTML, no Markdown)`
            : `- For this request, do NOT generate flashcards yet.
    - Return "flashcards": [] exactly.`;

        const prompt = `You are an expert educator creating a student study reviewer from the ${normalizedPdf.sourceDescription} above.

Return ONLY a valid JSON object with this exact structure:
{
  "title": "concise specific title (5-10 words)",
  "content": "<HTML here>",
  "flashcards": [{"front": "term", "back": "explanation"}]
}

=== CONTENT RULES ===
- Cover the ENTIRE lesson/file by touching every major section and topic in the source. Do not skip any section, but compress details aggressively.
- Keep the reviewer VERY SHORT while still covering the full lesson/file end-to-end with no missing parts.
- Each bullet must be concise and focused while still conveying the key idea.
- Structure: use <h2> for major sections, <h3> for sub-sections.
- Format: use <ul><li> bullet lists as the PRIMARY format for all details. Minimize prose paragraphs.
- Emphasis: wrap key terms, names, formulas, and dates in <strong> tags ONLY. Do NOT use **asterisks** for bold — that is Markdown and will break the output.
- Do NOT use any Markdown formatting anywhere (no **, no *, no #, no -, no backticks outside code blocks).
- Bullets must be short, clear, and informative — not full sentences unless necessary.
- Do NOT include: introductions like "This reviewer covers...", filler sentences, meta-commentary, or redundant restatements.
- Only include factual content directly from the source: definitions, concepts, processes, relationships, examples, key facts.
- CODE BLOCKS: If the source contains any source code, commands, scripts, syntax examples, pseudocode, or technical expressions that should be displayed as code, wrap them in <pre><code>…</code></pre>. For short inline code references (variable names, function names, keywords, command snippets) inside text, wrap them in <code>…</code>. Never put code inside regular text or bullet points without these tags.

=== FLASHCARD RULES ===
${flashcardRulesBlock}

Return nothing outside the JSON object.`;

        const result = await callGemini(prompt, normalizedPdf.pdfBuffer.toString('base64'));

        if (!result.title || !result.content) {
            return res.status(500).json({ error: 'Generation returned incomplete data. Please try again.' });
        }

        // ── Increment usage counter (fire-and-forget; don't block response) ──
        incrementAiUsage(req.session.userId, 'reviewer').catch(e => console.warn('[AI] usage increment error', e));

        res.json({
            title: String(result.title).trim().slice(0, 200),
            content: String(result.content).trim(),
            flashcards: includeFlashcards && Array.isArray(result.flashcards)
                ? result.flashcards.slice(0, 200)
                    .map(f => ({
                        front: String(f.front || '').trim().slice(0, 300),
                        back:  String(f.back  || '').trim().slice(0, 500)
                    }))
                    .filter(f => f.front && f.back)
                : []
        });
    } catch (error) {
        console.error('Auto generate-reviewer error:', error);
        notifyDiscord('🔴 Auto Generate Reviewer Failed', [
            ['Error', error?.message || String(error)],
            ['Stack', error?.stack || 'n/a'],
            ['File', `${req.file?.originalname || 'n/a'} (${req.file?.mimetype || 'n/a'}, ${req.file?.size || 0} bytes)`],
            ['Effective MIME', resolveFileMime(req.file?.originalname, req.file?.mimetype)],
            ['User', _userLink(req)],
            ['Time (UTC)', new Date().toISOString()]
        ]);
        res.status(500).json({ error: 'Failed to generate reviewer. Please try again.' });
    }
});

    // In-memory temporary store for chat-uploaded files. Keys are UUIDs.
    const chatUploadedFiles = new Map();

    // POST /api/ai/upload-chat-file — upload a single file to reference in chat
    app.post('/api/ai/upload-chat-file', requireAuth, (req, res, next) => {
        // Run multer for a single file under field name 'file'
        aiUpload.single('file')(req, res, (multerErr) => {
            if (multerErr) return res.status(400).json({ error: multerErr.message || 'File upload failed.' });
            next();
        });
    }, async (req, res) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
            if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'File-based chat is not available right now.' });

            const { originalname, mimetype, buffer } = req.file;
            const effectiveMime = resolveFileMime(originalname, mimetype);
            let normalized;
            try {
                normalized = await normalizeAiUploadToPdf({ buffer, effectiveMime, originalname });
            } catch (e) {
                return res.status(400).json({ error: e.message || 'Could not process uploaded file' });
            }

            const id = crypto.randomUUID();
            const base64 = normalized.pdfBuffer.toString('base64');
            chatUploadedFiles.set(id, {
                id,
                owner: req.session.userId,
                base64,
                originalname,
                mimetype: 'application/pdf',
                size: normalized.pdfBuffer.length,
                sourceDescription: normalized.sourceDescription,
                createdAt: Date.now()
            });

            // Track uploaded file ids in the user's session for convenience
            req.session.chatFiles = req.session.chatFiles || [];
            req.session.chatFiles.push(id);

            res.json({ id, name: originalname, size: normalized.pdfBuffer.length, sourceDescription: normalized.sourceDescription });
        } catch (err) {
            console.error('upload-chat-file error:', err);
            res.status(500).json({ error: 'Upload failed' });
        }
    });

    // POST /api/ai/chat-with-files — ask a question referencing previously uploaded files
    app.post('/api/ai/chat-with-files', requireAuth, async (req, res) => {
        try {
            if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'File-based chat is not available right now.' });
            const { message, fileIds } = req.body || {};
            if (!message || String(message).trim().length === 0) return res.status(400).json({ error: 'No message provided' });

            const ids = Array.isArray(fileIds) && fileIds.length ? fileIds : (req.session.chatFiles || []);
            if (!ids || ids.length === 0) return res.status(400).json({ error: 'No file attached' });

            // Use the first provided file for now
            const fid = ids[0];
            const fileEntry = chatUploadedFiles.get(fid);
            if (!fileEntry || fileEntry.owner !== req.session.userId) return res.status(404).json({ error: 'File not found' });

            const prompt = `You have access to an uploaded document: ${fileEntry.sourceDescription}. Answer the user's question using the document as the primary source. Be concise and cite short excerpts when helpful.\n\nUser question: ${message}`;

            const resultText = await callGemini(prompt, fileEntry.base64, false);
            if (!resultText) return res.status(500).json({ error: 'No response from AI' });
            res.json({ text: String(resultText) });
        } catch (err) {
            console.error('chat-with-files error:', err);
            res.status(500).json({ error: 'Chat failed' });
        }
    });

// POST /api/ai/generate-flashcards — generate flashcards from a saved reviewer
app.post('/api/ai/generate-flashcards', requireAuth, async (req, res) => {
    try {
        if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'Auto generation is not available right now. Please try again later.' });

        const { reviewerId } = req.body;
        if (!reviewerId || !UUID_REGEX.test(reviewerId)) {
            return res.status(400).json({ error: 'Invalid reviewer ID' });
        }

        const { data: reviewer, error } = await supabaseAdmin
            .from('reviewers')
            .select('title, content')
            .eq('id', reviewerId)
            .eq('user_id', req.session.userId)
            .single();

        if (error || !reviewer) {
            return res.status(404).json({ error: 'Reviewer not found or access denied' });
        }

        const plainContent = (reviewer.content || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 30000);

        if (plainContent.length < 50) {
            return res.status(400).json({ error: 'Reviewer content is too short to generate flashcards.' });
        }

        const prompt = `You are an expert flashcard maker. Based on the reviewer below, generate flashcards that comprehensively cover EVERY topic, concept, definition, process, formula, and key fact.

Reviewer: ${reviewer.title}
Content:
"""
${plainContent}
"""

Return ONLY a valid JSON object with this exact structure:
{
  "flashcards": [
    { "front": "term or question", "back": "clear answer/explanation" }
  ]
}

Rules:
- Ensure complete coverage of all sections/subtopics from the reviewer.
- Do not include duplicates or near-duplicates.
- front and back must be plain text only (no HTML, no Markdown).
- front should be concise; back should be clear and complete.
- Return nothing outside the JSON object.`;

        const result = await callGemini(prompt, null, true);
        const cards = (Array.isArray(result?.flashcards) ? result.flashcards : [])
            .slice(0, 200)
            .map(fc => ({
                front: String(fc?.front || '').trim().slice(0, 300),
                back: String(fc?.back || '').trim().slice(0, 500)
            }))
            .filter(fc => fc.front && fc.back);

        if (!cards.length) {
            return res.status(500).json({ error: 'No flashcards could be generated. Please try again.' });
        }

        res.json({ flashcards: cards });
    } catch (error) {
        console.error('Auto generate-flashcards error:', error);
        notifyDiscord('🔴 Auto Generate Flashcards Failed', [
            ['Error', error?.message || String(error)],
            ['Stack', error?.stack || 'n/a'],
            ['User', _userLink(req)],
            ['Time (UTC)', new Date().toISOString()]
        ]);
        res.status(500).json({ error: 'Failed to generate flashcards. Please try again.' });
    }
});

// POST /api/ai/generate-quiz — generate quiz questions from a reviewer
app.post('/api/ai/generate-quiz', requireAuth, async (req, res) => {
    try {
        if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'Auto generation is not available right now. Please try again later.' });

        const { reviewerId, questionCount } = req.body;
        if (!reviewerId || !UUID_REGEX.test(reviewerId)) {
            return res.status(400).json({ error: 'Invalid reviewer ID' });
        }

        // ── Daily limit check (only for AI-auto generation; manual count is always allowed) ──
        const isAutoGenerate = questionCount === undefined;
        if (isAutoGenerate) {
            const limitCheck = await checkAiLimit(req.session.userId, 'quiz');
            if (!limitCheck.allowed) {
                return res.status(429).json({
                    error: `Daily auto-generate limit reached (${limitCheck.limit}/day). Limit resets at midnight UTC.`,
                    used: limitCheck.used,
                    limit: limitCheck.limit
                });
            }
        }

        // If a specific count is requested (manual quiz builder), honour it (3–100).
        // When count is omitted (auto-generation), let the AI decide based on topic coverage.
        const manualCount = questionCount !== undefined ? Math.min(Math.max(parseInt(questionCount, 10) || 10, 3), 100) : null;

        const { data: reviewer, error } = await supabaseAdmin
            .from('reviewers')
            .select('title, content')
            .eq('id', reviewerId)
            .eq('user_id', req.session.userId)
            .single();

        if (error || !reviewer) {
            return res.status(404).json({ error: 'Reviewer not found or access denied' });
        }

        const plainContent = (reviewer.content || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 30000);

        if (plainContent.length < 50) {
            return res.status(400).json({ error: 'Reviewer content is too short to generate a quiz.' });
        }

        const prompt = manualCount
            ? `You are an expert quiz maker. Based on the reviewer below, generate exactly ${manualCount} multiple-choice questions that comprehensively test the most important topics, concepts, definitions, and facts covered.

Reviewer: ${reviewer.title}
Content:
"""
${plainContent}
"""

Output ONLY plain text questions in this EXACT format. Each question block must be separated by a blank line:

1. Question text?
A. Option A
*B. Correct option (put * directly before the letter of the correct answer)
C. Option C
D. Option D

Rules:
- Generate exactly ${manualCount} questions.
- Every question must have exactly 4 options labeled A, B, C, D.
- Mark the correct answer by placing * directly before its letter (e.g., *B. Paris).
- Vary which letter (A/B/C/D) is correct — do not put the correct answer in the same position every time.
- Wrong options must be plausible and related to the topic, but clearly incorrect.
- Questions must test understanding and application, not just recognition of words.
- Do NOT repeat the same concept twice.
- Do NOT use any Markdown formatting (no **, no *, except for the correct-answer marker before the option letter).
- Do NOT include any explanation, commentary, or text outside the question blocks.
- Output nothing except the numbered question blocks.`
            : `You are an expert quiz maker. Based on the reviewer below, generate a multiple-choice quiz that comprehensively covers EVERY topic, concept, definition, process, and fact in the reviewer. Let the depth and breadth of the content determine how many questions are needed. A short reviewer should produce fewer questions, while a long detailed reviewer should produce more. Make sure every section and subtopic is included, with no part left behind.

Reviewer: ${reviewer.title}
Content:
"""
${plainContent}
"""

Output ONLY plain text questions in this EXACT format. Each question block must be separated by a blank line:

1. Question text?
A. Option A
*B. Correct option (put * directly before the letter of the correct answer)
C. Option C
D. Option D

Rules:
- Every question must have exactly 4 options labeled A, B, C, D.
- Mark the correct answer by placing * directly before its letter (e.g., *B. Paris).
- Vary which letter (A/B/C/D) is correct — do not put the correct answer in the same position every time.
- Wrong options must be plausible and related to the topic, but clearly incorrect.
- Questions must test understanding and application, not just recognition of words.
- Do NOT repeat the same concept twice.
- Cover every section and subtopic — do not skip or skim any part of the reviewer.
- Do NOT use any Markdown formatting (no **, no *, except for the correct-answer marker before the option letter).
- Do NOT include any explanation, commentary, or text outside the question blocks.
- Output nothing except the numbered question blocks.`;

        const rawText = await callGemini(prompt, null, false);

        // Parse the plain-text paste format into structured questions
        function parsePasteFormat(text) {
            const questions = [];
            const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
            for (const block of blocks) {
                const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
                if (lines.length < 3) continue;
                const questionLine = lines[0].replace(/^\d+[.):]\s*/, '').trim();
                if (!questionLine) continue;
                const options = [];
                let correct = 0;
                let answerLetter = null;
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i];
                    const answerMatch = line.match(/^[Aa]nswer\s*:\s*([A-Da-d])/);
                    if (answerMatch) { answerLetter = answerMatch[1].toUpperCase(); continue; }
                    const isCorrect = line.startsWith('*');
                    const optMatch = (isCorrect ? line.slice(1) : line).match(/^([A-Da-d])[.):]\s*(.+)/);
                    if (optMatch) {
                        if (isCorrect) correct = options.length;
                        options.push(optMatch[2].trim());
                    }
                }
                if (answerLetter) {
                    const idx = answerLetter.charCodeAt(0) - 65;
                    if (idx >= 0 && idx < options.length) correct = idx;
                }
                if (options.length >= 2) {
                    questions.push({
                        id: crypto.randomUUID(),
                        question: questionLine,
                        options,
                        correct
                    });
                }
            }
            return questions;
        }

        const questions = parsePasteFormat(rawText);

        if (!Array.isArray(questions) || questions.length === 0) {
            return res.status(500).json({ error: 'No questions could be generated. Please try again.' });
        }

        // ── Increment usage counter for auto-generates only ──
        if (isAutoGenerate) {
            incrementAiUsage(req.session.userId, 'quiz').catch(e => console.warn('[AI] usage increment error', e));
        }

        res.json({ questions });
    } catch (error) {
        console.error('Auto generate-quiz error:', error);
        notifyDiscord('🔴 Auto Generate Quiz Failed', [
            ['Error', error?.message || String(error)],
            ['Stack', error?.stack || 'n/a'],
            ['Reviewer ID', req.body?.reviewerId || 'n/a'],
            ['User', _userLink(req)],
            ['Time (UTC)', new Date().toISOString()]
        ]);
        res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
    }
});

// GET /api/ai/usage — return today's AI usage counts for the current user
app.get('/api/ai/usage', requireAuth, async (req, res) => {
    try {
        const { data: userRow } = await supabaseAdmin
            .from('users')
            .select('ai_limit_exempt')
            .eq('id', req.session.userId)
            .single();

        if (userRow?.ai_limit_exempt) {
            return res.json({ exempt: true, limit: null, reviewer: 0, quiz: 0 });
        }

        const today = new Date().toISOString().slice(0, 10);
        const { data: rows } = await supabaseAdmin
            .from('ai_usage_log')
            .select('usage_type, count')
            .eq('user_id', req.session.userId)
            .eq('used_date', today);

        const usage = { reviewer: 0, quiz: 0 };
        (rows || []).forEach(r => { if (r.usage_type in usage) usage[r.usage_type] = r.count; });

        res.json({ exempt: false, limit: AI_DAILY_LIMIT, reviewer: usage.reviewer, quiz: usage.quiz });
    } catch (err) {
        console.error('AI usage fetch error:', err);
        res.status(500).json({ error: 'Failed to fetch usage' });
    }
});

// POST /api/ai/motivational-quote — generate a short study motivational quote
app.post('/api/ai/motivational-quote', requireAuth, async (req, res) => {
    try {
        if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'AI unavailable' });
        const prompt = `Generate one short, uplifting and cute motivational quote (1-2 sentences) about studying, learning, or academic growth. 
Make it warm, encouraging and positive. Do not use quotation marks. Return ONLY the quote text, nothing else.`;
        const quote = await callGemini(prompt, null, false);
        res.json({ quote: quote.trim() });
    } catch (err) {
        console.error('Motivational quote error:', err);
        res.status(500).json({ error: 'Failed to generate quote' });
    }
});

// ──────────────────────────────────────────────────────────────────────────
// renderRichHtml — render Quill HTML content into a pdfkit document
// Supports: bold, italic, underline, strike, colour, h1-h6, p, ul, ol,
//           blockquote, pre/code, table (simplified), br, hr
// ──────────────────────────────────────────────────────────────────────────
function renderRichHtml(doc, html, { left, pageWidth, BODY, BLACK, GRAY }) {
    if (!html) return;

    const VOIDS = new Set(['br','hr','img','input','col','area','base','link','meta','param','source','track','wbr']);
    const BLOCK_TAGS = new Set(['p','h1','h2','h3','h4','h5','h6','ul','ol','li','table','thead','tbody','tfoot','tr','td','th','blockquote','pre','div','section','article','header','footer','nav','figure','figcaption','hr','br']);

    function decodeEntities(s) {
        return s
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"')
            .replace(/&ldquo;/g, '\u201c').replace(/&rdquo;/g, '\u201d')
            .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
            .replace(/&#39;/g, "'").replace(/&hellip;/g, '\u2026')
            .replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
    }

    function tokenize(raw) {
        const tokens = [];
        const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)\s*>/g;
        let last = 0, m;
        while ((m = re.exec(raw)) !== null) {
            if (m.index > last) {
                const t = decodeEntities(raw.slice(last, m.index));
                if (t) tokens.push({ kind: 'text', val: t });
            }
            const [, slash, tag, attrStr, selfClose] = m;
            const lTag = tag.toLowerCase();
            const attrs = {};
            let am;
            const ar = /\s+([\w\-:]+)(?:=(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
            while ((am = ar.exec(attrStr)) !== null) {
                attrs[am[1].toLowerCase()] = am[2] ?? am[3] ?? am[4] ?? '';
            }
            if (slash) tokens.push({ kind: 'close', tag: lTag });
            else if (selfClose || VOIDS.has(lTag)) tokens.push({ kind: 'void', tag: lTag, attrs });
            else tokens.push({ kind: 'open', tag: lTag, attrs });
            last = re.lastIndex;
        }
        if (last < raw.length) {
            const t = decodeEntities(raw.slice(last));
            if (t) tokens.push({ kind: 'text', val: t });
        }
        return tokens;
    }

    function buildTree(tokens) {
        const root = { tag: 'root', attrs: {}, ch: [] };
        const stack = [root];
        for (const tok of tokens) {
            const cur = stack[stack.length - 1];
            if (tok.kind === 'text') {
                if (tok.val) cur.ch.push({ tag: '#text', text: tok.val, ch: [] });
            } else if (tok.kind === 'open') {
                const node = { tag: tok.tag, attrs: tok.attrs, ch: [] };
                cur.ch.push(node);
                stack.push(node);
            } else if (tok.kind === 'void') {
                cur.ch.push({ tag: tok.tag, attrs: tok.attrs, ch: [] });
            } else if (tok.kind === 'close') {
                while (stack.length > 1 && stack[stack.length - 1].tag !== tok.tag) stack.pop();
                if (stack.length > 1) stack.pop();
            }
        }
        return root;
    }

    function fontFor(bold, italic, mono) {
        if (mono) return 'Courier';
        if (bold && italic) return 'Helvetica-BoldOblique';
        if (bold) return 'Helvetica-Bold';
        if (italic) return 'Helvetica-Oblique';
        return 'Helvetica';
    }

    // Collect flat list of { text, bold, italic, underline, strike, color, mono } from inline nodes
    function collectSegs(node, style) {
        const out = [];
        if (node.tag === '#text') {
            if (node.text) out.push({ text: node.text, ...style });
            return out;
        }
        if (node.tag === 'br') { out.push({ text: '\n', ...style }); return out; }
        if (BLOCK_TAGS.has(node.tag)) return out; // don't descend into nested blocks inline
        const s = { ...style };
        switch (node.tag) {
            case 'strong': case 'b': s.bold = true; break;
            case 'em': case 'i': s.italic = true; break;
            case 'u': s.underline = true; break;
            case 's': case 'del': case 'strike': s.strike = true; break;
            case 'code': s.mono = true; break;
        }
        if (node.attrs && node.attrs.style) {
            const cm = node.attrs.style.match(/\bcolor\s*:\s*([^;]+)/i);
            if (cm) s.color = cm[1].trim();
        }
        for (const c of (node.ch || [])) out.push(...collectSegs(c, s));
        return out;
    }

    // Render flat inline segments using pdfkit continued-text
    function renderSegs(segs, baseSize, baseColor) {
        if (!segs.length) return;
        if (!segs.map(s => s.text).join('').trim()) return;
        for (let i = 0; i < segs.length; i++) {
            const s = segs[i];
            if (!s.text) continue;
            const isLast = i === segs.length - 1;
            doc.font(fontFor(s.bold, s.italic, s.mono))
               .fontSize(baseSize)
               .fillColor(s.color || baseColor);
            doc.text(s.text, { continued: !isLast, underline: !!s.underline, strike: !!s.strike, lineGap: 3 });
        }
    }

    function renderList(node, depth, ordered) {
        let idx = 0;
        for (const child of (node.ch || [])) {
            if (child.tag !== 'li') continue;
            idx++;
            const bullet = ordered ? `${idx}. ` : '\u2022 ';
            const ix = left + depth * 14;
            const w = pageWidth - depth * 14;
            const inlineSegs = [];
            const subLists = [];
            for (const c of (child.ch || [])) {
                if (c.tag === 'ul' || c.tag === 'ol') subLists.push(c);
                else inlineSegs.push(...collectSegs(c, {}));
            }
            const lineText = bullet + inlineSegs.map(s => s.text).join('').replace(/\n/g, ' ').trim();
            doc.moveDown(0.06).font('Helvetica').fontSize(12).fillColor(BODY)
               .text(lineText, ix, doc.y, { width: w, lineGap: 2 });
            for (const sl of subLists) renderList(sl, depth + 1, sl.tag === 'ol');
        }
    }

    function renderTable(node) {
        const rows = [];
        (function collect(n) {
            if (n.tag === 'tr') rows.push(n);
            for (const c of (n.ch || [])) collect(c);
        })(node);
        for (const row of rows) {
            const cells = (row.ch || []).filter(c => c.tag === 'td' || c.tag === 'th');
            const isHeader = cells.some(c => c.tag === 'th');
            const texts = cells.map(c => collectSegs(c, {}).map(s => s.text).join('').replace(/\n/g, ' ').trim());
            doc.moveDown(0.1).font(isHeader ? 'Helvetica-Bold' : 'Helvetica')
               .fontSize(11).fillColor(BODY).text(texts.join('  |  '), { lineGap: 2 });
        }
    }

    function renderBlock(node) {
        switch (node.tag) {
            case 'root': case 'div': case 'section': case 'article':
            case 'nav': case 'aside': case 'body': case 'figure': case 'figcaption':
                for (const c of (node.ch || [])) renderBlock(c);
                break;
            case 'h1': {
                const segs = collectSegs(node, { bold: true });
                if (!segs.map(s => s.text).join('').trim()) break;
                doc.moveDown(0.5);
                renderSegs(segs, 20, BLACK);
                doc.font('Helvetica').fontSize(12).fillColor(BODY);
                break;
            }
            case 'h2': {
                const segs = collectSegs(node, { bold: true });
                if (!segs.map(s => s.text).join('').trim()) break;
                doc.moveDown(0.4);
                renderSegs(segs, 17, BLACK);
                doc.font('Helvetica').fontSize(12).fillColor(BODY);
                break;
            }
            case 'h3': case 'h4': case 'h5': case 'h6': {
                const segs = collectSegs(node, { bold: true });
                if (!segs.map(s => s.text).join('').trim()) break;
                doc.moveDown(0.3);
                renderSegs(segs, 14, BLACK);
                doc.font('Helvetica').fontSize(12).fillColor(BODY);
                break;
            }
            case 'p': {
                const segs = collectSegs(node, {});
                if (!segs.map(s => s.text).join('').trim()) { doc.moveDown(0.3); break; }
                doc.moveDown(0.2);
                renderSegs(segs, 12, BODY);
                break;
            }
            case 'ul':
                doc.moveDown(0.2);
                renderList(node, 0, false);
                break;
            case 'ol':
                doc.moveDown(0.2);
                renderList(node, 0, true);
                break;
            case 'blockquote': {
                const segs = collectSegs(node, { italic: true });
                const txt = segs.map(s => s.text).join('').replace(/\n/g, ' ').trim();
                if (!txt) break;
                doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(12).fillColor(GRAY)
                   .text('\u258C ' + txt, left + 12, doc.y, { width: pageWidth - 12, lineGap: 3 });
                doc.font('Helvetica').fontSize(12).fillColor(BODY);
                break;
            }
            case 'pre': {
                const segs = collectSegs(node, {});
                const txt = segs.map(s => s.text).join('').trim();
                if (!txt) break;
                doc.moveDown(0.3).font('Courier').fontSize(10).fillColor('#333333')
                   .text(txt, left, doc.y, { width: pageWidth, lineGap: 2 });
                doc.font('Helvetica').fontSize(12).fillColor(BODY);
                break;
            }
            case 'table':
                doc.moveDown(0.3);
                renderTable(node);
                break;
            case 'hr': {
                doc.moveDown(0.4);
                const ry = doc.y;
                doc.moveTo(left, ry).lineTo(left + pageWidth, ry).strokeColor(GRAY).lineWidth(0.5).stroke();
                doc.moveDown(0.4);
                break;
            }
            case 'br':
                doc.moveDown(0.3);
                break;
            case '#text': {
                const t = (node.text || '').trim();
                if (t) doc.font('Helvetica').fontSize(12).fillColor(BODY).text(t, { lineGap: 3 });
                break;
            }
            default: {
                const segs = collectSegs(node, {});
                const txt = segs.map(s => s.text).join('').trim();
                if (txt) { doc.moveDown(0.1); renderSegs(segs, 12, BODY); }
                else { for (const c of (node.ch || [])) renderBlock(c); }
                break;
            }
        }
    }

    doc.font('Helvetica').fontSize(12).fillColor(BODY);
    renderBlock(buildTree(tokenize(html)));
}

// GET /api/reviewers/:id/pdf — generate and download reviewer as PDF
app.get('/api/reviewers/:id/pdf', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;
        if (!UUID_REGEX.test(id)) return res.status(400).json({ error: 'Invalid reviewer ID' });

        const { data: reviewer, error } = await supabaseAdmin
            .from('reviewers')
            .select('id, title, content, created_at, user_id, is_public, subjects:subject_id (name)')
            .eq('id', id)
            .single();

        if (error) {
            console.error('PDF endpoint Supabase error:', error);
            return res.status(500).json({ error: 'Failed to fetch reviewer' });
        }
        if (!reviewer) return res.status(404).json({ error: 'Reviewer not found' });

        // Private reviewers: only owner can download
        if (!reviewer.is_public && reviewer.user_id !== req.session.userId) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const subject = reviewer.subjects?.name || '';

        // Generate motivational quote
        const fallbackQuotes = [
            'Every page you read today is a step closer to the person you want to become.',
            'Small progress is still progress. Keep going — you are doing amazing!',
            'Your future self will thank you for every hour you study today.',
            'Learning is a gift. Even when it is hard, it is worth it.',
            'You are capable of more than you know. Trust the process.',
            'Consistency beats perfection. Show up, even on the hard days.',
            'The more you learn, the more doors open for you. Keep going!',
            'Every expert was once a beginner. You are exactly where you need to be.',
            'Believe in your ability to grow — because you absolutely can.',
            'Study with heart, rest with intention, and bloom at your own pace.'
        ];
        let quote = fallbackQuotes[Math.floor(Math.random() * fallbackQuotes.length)];
        try {
            if (process.env.GEMINI_API_KEY) {
                const prompt = `Generate one short, uplifting and cute motivational quote (1-2 sentences) about studying, learning, or academic growth. Make it warm, encouraging and positive. Do not use quotation marks. Return ONLY the quote text, nothing else.`;
                const aiQuote = await callGemini(prompt, null, false);
                if (aiQuote && aiQuote.trim()) quote = aiQuote.trim();
            }
        } catch (_) {}

        const doc = new PDFDocument({ margin: 60, size: 'A4', bufferPages: true });
        const safeFilename = (reviewer.title || 'reviewer').replace(/[^a-z0-9_\-]/gi, '_');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}.pdf"`);
        doc.pipe(res);

        const PINK       = '#e91e8c';
        const DARK_PINK  = '#880e4f';
        const LIGHT_PINK = '#fce4ec';
        const GRAY       = '#888888';
        const BLACK      = '#111111';
        const BODY       = '#222222';
        const pageWidth  = doc.page.width - 120; // content width with margins

        // ── Header ──
        doc.fontSize(22).fillColor(BLACK).font('Helvetica-Bold').text(reviewer.title || 'Reviewer', { align: 'left' });
        if (subject) {
            doc.moveDown(0.2).fontSize(10).fillColor(PINK).font('Helvetica-Bold')
               .text(subject.toUpperCase(), { characterSpacing: 1 });
        }
        const dateStr = reviewer.created_at
            ? new Date(reviewer.created_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
            : '';
        if (dateStr) {
            doc.moveDown(0.2).fontSize(10).fillColor(GRAY).font('Helvetica').text(dateStr);
        }

        // Pink divider line
        doc.moveDown(0.6);
        const lineY = doc.y;
        doc.moveTo(60, lineY).lineTo(60 + pageWidth, lineY).strokeColor(PINK).lineWidth(1.5).stroke();
        doc.moveDown(1);

        // ── Body content ──
        renderRichHtml(doc, reviewer.content, { left: 60, pageWidth, BODY, BLACK, GRAY });

        // ── Motivational footer ──
        doc.moveDown(2);
        doc.fontSize(12).fillColor(DARK_PINK).font('Helvetica-Oblique')
           .text(quote, { width: pageWidth, align: 'center', lineGap: 3 });

        doc.end();
    } catch (err) {
        console.error('PDF generation error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF' });
    }
});

// =====================================================
// ERROR HANDLING
// =====================================================

// One-time terminal auth tokens (expire in 30s)
const _termTokens = new Map();
app.post('/api/compiler/terminal-token', requireAuth, (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    _termTokens.set(token, { expiresAt: Date.now() + 30_000 });
    setTimeout(() => _termTokens.delete(token), 30_000);
    res.json({ token });
});

// One-time WebSocket tokens for chat (short-lived, default 5 minutes)
const _wsTokens = new Map();
app.post('/api/ws/chat-token', requireAuth, (req, res) => {
    const token = crypto.randomBytes(32).toString('hex');
    _wsTokens.set(token, { userId: req.session.userId, expiresAt: Date.now() + (5 * 60 * 1000) });
    // Auto-delete after expiry
    setTimeout(() => _wsTokens.delete(token), 5 * 60 * 1000);
    res.json({ token });
});

// 404 handler - distinguish between API and page requests
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    // For page requests, serve index or redirect to login
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global Express error handler — catches any error passed via next(err)
app.use((err, req, res, next) => {
    const isProd = process.env.NODE_ENV === 'production';
    console.error('Unhandled route error:', err.message || err, err.stack || '');
    // Discord — include request context
    _discord('🔴 Unhandled Route Error', [
        ['Error', err?.message || String(err)],
        ['Stack', (err?.stack || 'n/a').slice(0, 1000)],
        ['Route', `${req.method} ${req.path}`],
        ['User-Agent', req.headers?.['user-agent'] || 'n/a'],
        ['User', _userLink(req)],
        ['Time (UTC)', new Date().toISOString()]
    ]);
    if (res.headersSent) return next(err);
    const statusCode = err.status || err.statusCode || 500;
    const message = isProd ? 'Internal server error' : (err.message || 'Internal server error');
    res.status(statusCode).json({ error: message });
});

// =====================================================
// NOTIFICATION CLEANUP JOB
// =====================================================

// Function to clean up notifications older than 30 days
async function cleanupOldNotifications() {
    try {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const { data, error } = await supabaseAdmin
            .from('notifications')
            .delete()
            .lt('created_at', thirtyDaysAgo.toISOString());

        if (error) {
            console.error('Failed to cleanup old notifications:', error);
        } else {
            console.log('✓ Cleaned up old notifications');
        }
    } catch (err) {
        console.error('Notification cleanup error:', err);
    }
}

// Run cleanup every 24 hours
setInterval(cleanupOldNotifications, 24 * 60 * 60 * 1000);

// Run cleanup on startup
cleanupOldNotifications();

// =====================================================
// STARTUP MIGRATIONS
// =====================================================

// Ensure the notifications.type CHECK constraint includes 'follow'.
// This is idempotent — if the constraint already includes 'follow' it
// performs no change. Runs asynchronously so it never blocks startup.
async function applyStartupMigrations() {
    const migrationPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
        max: 1,
        connectionTimeoutMillis: 8000,
        idleTimeoutMillis: 5000,
    });
    let client = null;
    try {
        client = await migrationPool.connect();
        await client.query(`
            DO $$
            DECLARE
                v_name TEXT;
            BEGIN
                SELECT conname INTO v_name
                FROM pg_constraint
                WHERE conrelid = 'notifications'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%type%'
                  AND pg_get_constraintdef(oid) NOT LIKE '%follow%';

                IF v_name IS NOT NULL THEN
                    EXECUTE format('ALTER TABLE notifications DROP CONSTRAINT %I', v_name);
                    EXECUTE 'ALTER TABLE notifications
                        ADD CONSTRAINT notifications_type_check
                        CHECK (type IN (''reaction'', ''comment'', ''message'', ''reply'', ''follow'', ''new_reviewer'', ''school_request''))';
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS user_login_activity (
                id BIGSERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                session_sid VARCHAR NOT NULL UNIQUE,
                device_hash VARCHAR(128) NOT NULL,
                device_label TEXT,
                device_model TEXT,
                ip_address TEXT,
                country_code VARCHAR(8),
                location_text TEXT,
                user_agent TEXT,
                is_unfamiliar BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
                revoked_at TIMESTAMPTZ NULL
            );

            ALTER TABLE user_login_activity ADD COLUMN IF NOT EXISTS device_model TEXT;
            ALTER TABLE user_login_activity ADD COLUMN IF NOT EXISTS country_code VARCHAR(8);
            ALTER TABLE user_login_activity ADD COLUMN IF NOT EXISTS location_text TEXT;

            CREATE INDEX IF NOT EXISTS idx_user_login_activity_user_last_seen
            ON user_login_activity (user_id, last_seen_at DESC);

            CREATE INDEX IF NOT EXISTS idx_user_login_activity_user_device
            ON user_login_activity (user_id, device_hash);

            CREATE TABLE IF NOT EXISTS login_activity_access_codes (
                id BIGSERIAL PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                code VARCHAR(6) NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );

            CREATE INDEX IF NOT EXISTS idx_login_activity_codes_user_created
            ON login_activity_access_codes (user_id, created_at DESC);
        `);
        console.log('\u2713 Startup migrations applied');
    } catch (err) {
        console.warn('Startup migration warning (non-fatal):', err.message || err);
    } finally {
        if (client) client.release();
        migrationPool.end().catch(() => {});
    }
}

// ─── Interactive compiler (xterm.js + WebSocket + child_process) ──────────────

const _httpServer = http.createServer(app);
const _wss = new WebSocketServer({ server: _httpServer, path: '/ws/compiler' });

// Chat WebSocket server (real-time message pushes)
const _chatWss = new WebSocketServer({ server: _httpServer, path: '/ws/chat' });
// Map of userId -> Set of WebSocket connections for that user
const _wsClientsByUserId = new Map();

_chatWss.on('connection', (socket, req) => {
    // Token passed as query param: ?token=<hex>
    const qs = req.url && req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const token = new URLSearchParams(qs).get('token');
    const tokenData = token ? _wsTokens.get(token) : null;
    if (!tokenData || Date.now() > tokenData.expiresAt) { socket.close(1008, 'Unauthorized'); return; }
    // Remove token so it can't be reused
    _wsTokens.delete(token);

    const userId = String(tokenData.userId);
    socket.__chatUserId = userId;

    let set = _wsClientsByUserId.get(userId);
    if (!set) { set = new Set(); _wsClientsByUserId.set(userId, set); }
    set.add(socket);

    // Acknowledge
    try { socket.send(JSON.stringify({ type: 'connected', userId })); } catch (_) {}

    socket.on('close', () => {
        try {
            const s = _wsClientsByUserId.get(userId);
            if (s) {
                s.delete(socket);
                if (s.size === 0) _wsClientsByUserId.delete(userId);
            }
        } catch (_) {}
    });

    socket.on('message', (raw) => {
        // Currently only support pings from client (keep-alive). Expect JSON {type:'ping'}
        try {
            const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
            if (m && m.type === 'ping') {
                try { socket.send(JSON.stringify({ type: 'pong', ts: Date.now() })); } catch (_) {}
            }
        } catch (_) {}
    });
});

const _LANG_EXT = { cpp: '.cpp', c: '.c', python: '.py', javascript: '.js', typescript: '.ts', java: '.java', go: '.go', rust: '.rs', php: '.php', ruby: '.rb' };
// Prepend to C/C++ source to disable stdout/stderr buffering without needing a PTY
const _CPP_UNBUF = '#include<cstdio>\nstruct __UnbufInit{__UnbufInit(){setvbuf(stdout,0,_IONBF,0);setvbuf(stderr,0,_IONBF,0);}}__unbuf_init;\n';
const _isWin = process.platform === 'win32';

function _getRunConfig(language, srcFile) {
    const outFile = srcFile + (_isWin ? '.exe' : '.out');
    switch (language) {
        case 'cpp':        return { compile: ['g++',    ['-o', outFile, srcFile]], run: [outFile, []] };
        case 'c':          return { compile: ['gcc',    ['-o', outFile, srcFile]], run: [outFile, []] };
        case 'python':     return { run: [_isWin ? 'python' : 'python3', ['-u', srcFile]] };
        case 'javascript': return { run: ['node', [srcFile]] };
        case 'typescript': return { run: ['npx', ['ts-node', '--skipProject', srcFile]] };
        case 'java':       return { compile: ['javac', [srcFile]], run: ['java', ['-cp', path.dirname(srcFile), 'Main']] };
        case 'go':         return { run: ['go', ['run', srcFile]] };
        case 'rust':       return { compile: ['rustc', ['-o', outFile, srcFile]], run: [outFile, []] };
        case 'php':        return { run: ['php',  [srcFile]] };
        case 'ruby':       return { run: ['ruby', [srcFile]] };
        default: return null;
    }
}

_wss.on('connection', (socket, req) => {
    // Validate one-time token
    const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
    const token = new URLSearchParams(qs).get('token');
    const tokenData = _termTokens.get(token);
    if (!tokenData || Date.now() > tokenData.expiresAt) { socket.close(1008, 'Unauthorized'); return; }
    _termTokens.delete(token);

    let child = null;
    const tmpFiles = [];
    // Hard kill after 60s to prevent runaway processes
    const killTimeout = setTimeout(() => { if (child) { child.kill(); socket.send('\r\n\x1b[33m[Timed out after 60s]\x1b[0m\r\n'); } }, 60_000);

    const write = (s) => { if (socket.readyState === socket.OPEN) socket.send(s); };

    socket.on('message', async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type === 'start') {
            const { language, code } = msg;
            if (!language || !code) return;
            const ext = _LANG_EXT[language] || '.txt';
            const base = path.join(tmpdir(), `thinky_${crypto.randomBytes(8).toString('hex')}`);
            // Java class must be named Main
            const srcFile = language === 'java' ? path.join(tmpdir(), `Main_${Date.now()}.java`) : base + ext;
            const finalCode = (language === 'cpp' || language === 'c') ? _CPP_UNBUF + code : code;
            tmpFiles.push(srcFile);
            try { await writeFile(srcFile, finalCode, 'utf8'); } catch {
                write('\r\n\x1b[31mFailed to write source file.\x1b[0m\r\n'); return;
            }

            const config = _getRunConfig(language, srcFile);
            if (!config) { write(`\r\n\x1b[31mUnsupported language: ${language}\x1b[0m\r\n`); return; }
            const outFile = srcFile + (_isWin ? '.exe' : '.out');

            const norm = (s) => s.replace(/(?<!\r)\n/g, '\r\n');
            const startRun = () => {
                const [cmd, args] = config.run;
                child = spawn(cmd, args, { stdio: 'pipe', env: { ...process.env } });
                child.stdout.on('data', d => write(norm(d.toString())));
                child.stderr.on('data', d => write(norm(d.toString())));
                child.on('close', code => {
                    write(`\r\n\x1b[90m[Process exited with code ${code ?? '?'}]\x1b[0m\r\n`);
                    child = null;
                    tmpFiles.forEach(f => unlink(f).catch(() => {}));
                    unlink(outFile).catch(() => {});
                });
                child.on('error', e => write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
            };

            if (config.compile) {
                const [cc, ca] = config.compile;
                write(`\x1b[90mCompiling…\x1b[0m\r\n`);
                const compiler = spawn(cc, ca, { stdio: 'pipe' });
                let compileOut = '';
                compiler.stdout.on('data', d => { compileOut += d; });
                compiler.stderr.on('data', d => { compileOut += d; });
                compiler.on('close', c => {
                    if (c !== 0) {
                        write(norm(compileOut || 'Compilation failed.') + `\r\n\x1b[90m[exited with code 1]\x1b[0m\r\n`);
                        tmpFiles.forEach(f => unlink(f).catch(() => {}));
                    } else {
                        tmpFiles.push(outFile);
                        startRun();
                    }
                });
                compiler.on('error', () => write(`\r\n\x1b[31mCompiler not found: ${cc}\r\nMake sure it is installed and on your PATH.\x1b[0m\r\n`));
            } else {
                startRun();
            }

        } else if (msg.type === 'input') {
            if (child?.stdin && !child.stdin.destroyed) child.stdin.write(msg.data);
        } else if (msg.type === 'kill') {
            if (child) child.kill();
        }
    });

    socket.on('close', () => {
        clearTimeout(killTimeout);
        if (child) child.kill();
        tmpFiles.forEach(f => unlink(f).catch(() => {}));
    });
});

applyStartupMigrations();

// ─── Process-level error handlers ────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('UNCAUGHT EXCEPTION:', err);
    _discord('🚨 Uncaught Exception', [
        ['Error', err?.message || String(err)],
        ['Stack', (err?.stack || 'n/a').slice(0, 1000)],
        ['Time (UTC)', new Date().toISOString()]
    ]);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? (reason.stack || 'n/a') : 'n/a';
    console.error('UNHANDLED REJECTION:', reason);
    _discord('🚨 Unhandled Promise Rejection', [
        ['Reason', msg.slice(0, 1000)],
        ['Stack', stack.slice(0, 1000)],
        ['Time (UTC)', new Date().toISOString()]
    ]);
});

// If this file is run directly, start a standalone server (for local dev).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    _httpServer.listen(PORT, () => {
        console.log(`🚀 Reviewer App running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}

// Export the app for serverless wrappers or tests
export default app;
