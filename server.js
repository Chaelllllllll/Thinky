/**
 * REVIEWER APP - MAIN SERVER
 * Full-featured reviewer web application with Node.js, Bootstrap, and Supabase
 */

import 'dotenv/config';
import express from 'express';
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
import nodemailer from 'nodemailer';
import compression from 'compression';

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
const scriptSrcArray = ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.quilljs.com"];
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
            connectSrc: ["'self'", "https://cdn.jsdelivr.net", process.env.SUPABASE_URL].filter(Boolean),
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://cdn.quilljs.com"],
            scriptSrc: scriptSrcArray,
            scriptSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "https:"],
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
async function sendTemplatedEmail({ to, subject, template = 'default', variables = {} }) {
        const from = process.env.SMTP_FROM || `no-reply@${process.env.DOMAIN || 'localhost'}`;
        const html = renderEmailTemplate(template, variables);
        const text = variables.plainText || (typeof variables.message === 'string' ? variables.message : subject || '');

        if (!mailTransporter) {
                console.warn('No mail transporter configured; email not sent.');
                console.log('Email preview — to:', to, 'subject:', subject, 'html:', html);
                return { ok: false, info: 'no-transporter' };
        }

        try {
                const info = await mailTransporter.sendMail({ from, to, subject, html, text });
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
            console.warn('Verification code stored but email send failed', sent.error || sent.info);
            return res.status(202).json({ message: 'Verification code stored but failed to send email. Check server logs or contact support.' });
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

        // Optionally enforce a single active session per user. When enabled
        // via env var `SINGLE_SESSION_PER_USER=true` we'll delete other
        // rows in the `session` table that reference this user. This helps
        // avoid multiple session rows for the same user (duplicate `sess`
        // payloads) which can arise from changing cookie attributes or
        // migrations between stores.
        try {
            if (process.env.SINGLE_SESSION_PER_USER === 'true' && typeof createSessionPool === 'function') {
                try {
                    const pool = createSessionPool();
                    const currentSid = req.sessionID || null;
                    if (pool && currentSid) {
                        const delSql = `DELETE FROM session WHERE (sess::json->>'userId') = $1 AND sid <> $2`;
                        // Use non-blocking, backoff-enabled pool runner to avoid pool saturation errors.
                        runSessionPoolQueryAsync(delSql, [String(user.id), String(currentSid)]);
                        console.info('Scheduled single-session cleanup for user', user.id);
                    }
                } catch (e) {
                    console.warn('Failed to schedule single-session cleanup:', e && e.message ? e.message : e);
                }
            }
        } catch (e) {
            // non-fatal
        }

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
        // Remove from online users (use admin client server-side)
        await supabaseAdmin
            .from('online_users')
            .delete()
            .eq('user_id', req.session.userId);

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
app.get('/api/subjects', requireAuth, async (req, res) => {
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
app.get('/api/schools', requireAuth, async (req, res) => {
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
app.get('/api/subjects/:subjectId/reviewers', requireAuth, async (req, res) => {
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
app.get('/api/reviewers/public', requireAuth, async (req, res) => {
    try {
        const { search, student } = req.query;

        let query = supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (username, email, profile_picture_url),
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
app.get('/api/reviewers/public-guest', async (req, res) => {
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
                users:user_id (username, email, profile_picture_url),
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
app.get('/api/subjects/public', async (req, res) => {
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

        const { subject_id, title, content, is_public, flashcards, compiler_language } = req.body;

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
            is_public: is_public !== false,
            compiler_language: compiler_language || null
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

        // Notify followers about new reviewer (async, don't block response)
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
                    
                    // Send emails to followers
                    for (const follower of followers) {
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
                                            <a href="${process.env.PRODUCTION_URL || 'http://localhost:3000'}/reviewer.html?id=${reviewer.id}" 
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

        res.json({ reviewer });
    } catch (error) {
        console.error('Create reviewer error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get a single reviewer with user and subject info
app.get('/api/reviewers/:id', requireAuth, async (req, res) => {
    try {
        const { id } = req.params;

        const { data: reviewers, error } = await supabase
            .from('reviewers')
            .select(`
                *,
                users:user_id (username, email),
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
    } catch (err) {
        console.error('Report reviewer error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Public: get basic user info by id
app.get('/api/users/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { data: user, error } = await supabase
            .from('users')
            .select('id, username, display_name, profile_picture_url, created_at, is_dev, follower_count, following_count')
            .eq('id', id)
            .maybeSingle();

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
        const { id } = req.params;
        const limit = Math.min(parseInt(req.query.limit) || 10, 200);
        const offset = Math.max(parseInt(req.query.offset) || 0, 0);
        const start = offset;
        const end = offset + limit - 1;
        const search = (req.query.search || '').trim();

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
        const { id } = req.params;
        const followerId = req.session.userId;

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
        const { id } = req.params;
        const followerId = req.session.userId;

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
        const { id } = req.params;
        const followerId = req.session.userId;

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
        const { title, content, is_public, flashcards, compiler_language } = req.body;

        const updateObj = { title, content, is_public: is_public !== false, compiler_language: compiler_language || null };

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

        // Mark report resolved
        const actionTakenAt = new Date().toISOString();
        const update = {
            status: action === 'dismiss' ? 'dismissed' : 'resolved',
            action_taken_by: adminId,
            action_taken: action + (note ? (' - ' + note) : ''),
            action_taken_at: actionTakenAt,
            resolved_at: actionTakenAt
        };

        await supabaseAdmin.from(reportTable).update(update).eq('id', reportId);

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
            return res.json({ messages: msgs });
        } catch (e) {
            return res.json({ messages: filteredMessages.reverse() });
        }
    } catch (error) {
        console.error('Get private-inbox messages error:', error);
        res.status(500).json({ error: 'Server error' });
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

// Send message
app.post('/api/messages', requireAuth, messageLimiter, async (req, res) => {
    try {
        const { message, chat_type } = req.body;
        const recipient_id = req.body.recipient_id || null;
        const reply_to = req.body.reply_to || null;

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
            username: req.session.username,
            message: cleanMessage,
            chat_type
        };
        if (chat_type === 'private') insertObj.recipient_id = recipient_id;
        if (reply_to) insertObj.reply_to = reply_to;

        const { data: newMessage, error } = await supabaseAdmin
            .from('messages')
            .insert([insertObj])
            .select()
            .single();

        if (error) {
            console.error('Send message error:', error);
            return res.status(500).json({ error: 'Failed to send message' });
        }

        // Create notification for private messages
        if (chat_type === 'private' && recipient_id && recipient_id !== req.session.userId) {
            try {
                await createNotification({
                    userId: recipient_id,
                    type: 'message',
                    title: 'New Message',
                    message: `${req.session.username} sent you a message`,
                    link: `/chat.html?with=${req.session.userId}`,
                    relatedUserId: req.session.userId,
                    relatedItemId: newMessage.id
                });
            } catch (notifErr) {
                console.error('Failed to create message notification:', notifErr);
                // Don't fail the request if notification creation fails
            }
        }

        try { console.debug('New message inserted:', newMessage && newMessage.id ? { id: newMessage.id, user_id: newMessage.user_id, chat_type: newMessage.chat_type } : newMessage); } catch (e) {}
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

            const { data, error } = await supabaseAdmin
                .from('chat_reports')
                .insert([{ message_id: messageId, reporter_id: reporterId, report_type, details }]);

            if (error) {
                console.error('Failed to create chat report:', error);
                return res.status(500).json({ error: 'Failed to submit report' });
            }

            res.json({ ok: true, report: data && data[0] });
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
        await supabase
            .from('online_users')
            .upsert({
                user_id: req.session.userId,
                username: req.session.username,
                last_seen: new Date().toISOString()
            });

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
        const { data: analytics, error } = await supabase
            .from('admin_analytics')
            .select('*')
            .single();

        if (error) {
            console.error('Get analytics error:', error);
            return res.status(500).json({ error: 'Failed to fetch analytics' });
        }

        res.json({ analytics });
    } catch (error) {
        console.error('Get analytics error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get all users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, email, username, role, is_verified, created_at')
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

        const { data: user, error } = await supabaseAdmin
            .from('users')
            .update(update)
            .eq('id', id)
            .select('id, email, username, role, display_name, is_verified')
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
app.get('/api/policies', async (req, res) => {
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
app.get('/api/policies/last-updated', async (req, res) => {
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

// Helper function to create a notification
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
}

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

const aiUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
    fileFilter: (_req, file, cb) => {
        const allowed = [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'text/plain'
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only PDF, DOCX, and TXT files are allowed'));
        }
    }
});

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

async function callGemini(prompt, pdfBase64 = null, returnJson = true) {
    const apiKeys = getGeminiApiKeys();
    if (apiKeys.length === 0) throw new Error('No Gemini API keys configured');

    const parts = [];
    if (pdfBase64) {
        parts.push({ inlineData: { mimeType: 'application/pdf', data: pdfBase64 } });
    }
    parts.push({ text: prompt });

    let lastError;
    for (const apiKey of apiKeys) {
    for (const model of GEMINI_MODELS) {
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
            // Network-level failure — try next model
            lastError = networkErr;
            console.warn(`[AI] Model "${model}" network error, trying next model...`, networkErr.message);
            continue;
        }

        if (!resp.ok) {
            const errBody = await resp.json().catch(() => ({}));
            const errMsg = errBody.error?.message || `Gemini API error: ${resp.status}`;
            if (resp.status === 401 || resp.status === 403) {
                // Invalid/revoked key — skip remaining models for this key
                lastError = new Error(errMsg);
                console.warn(`[AI] API key rejected (${resp.status}), trying next key...`);
                break;
            }
            if (isGeminiRetryableError(resp.status, errMsg)) {
                lastError = new Error(errMsg);
                console.warn(`[AI] Model "${model}" unavailable (${resp.status}: ${errMsg}), trying next model...`);
                continue;
            }
            // Non-retryable error (e.g. 400 bad request) — fail immediately
            throw new Error(errMsg);
        }

        const data = await resp.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

        // Empty/blocked response — try next model instead of hard-failing
        const finishReason = data.candidates?.[0]?.finishReason;
        if (!text) {
            const blockReason = data.promptFeedback?.blockReason;
            if (blockReason) {
                // Content blocked — not a capacity issue, fail immediately
                throw new Error(`Request blocked by Gemini safety filters: ${blockReason}`);
            }
            lastError = new Error(`Empty response from model "${model}" (finishReason: ${finishReason || 'unknown'})`);
            console.warn(`[AI] Model "${model}" returned empty text, trying next model...`);
            continue;
        }

        // Truncated response — output was cut off at the token limit, JSON will be malformed
        if (finishReason === 'MAX_TOKENS') {
            lastError = new Error(`Response from model "${model}" was truncated (MAX_TOKENS) — JSON likely incomplete`);
            console.warn(`[AI] Model "${model}" hit MAX_TOKENS, trying next model...`);
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
                    // Remove everything from the last complete comma-terminated value onward,
                    // then close all open braces/brackets to form valid JSON.
                    let s = jsonText.replace(/,\s*$/, '').replace(/[^}\]]+$/, '');
                    // Count unclosed braces
                    let open = 0;
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
            console.warn(`[AI] Model "${model}" returned unparseable JSON, trying next model...`);
            continue;
        }
        return text;
    }
    } // end key loop

    throw lastError || new Error('All Gemini models are currently unavailable. Please try again later.');
}

// POST /api/ai/generate-reviewer — upload a PDF/DOCX/TXT and generate a reviewer
app.post('/api/ai/generate-reviewer', requireAuth, aiUpload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        if (getGeminiApiKeys().length === 0) return res.status(503).json({ error: 'Auto generation is not available right now. Please try again later.' });

        const { mimetype, buffer } = req.file;
        let pdfBase64 = null;
        let textContent = null;

        if (mimetype === 'application/pdf') {
            // Gemini natively reads PDFs — send as base64 inline data
            pdfBase64 = buffer.toString('base64');
        } else if (mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
            const mammoth = (await import('mammoth')).default;
            const result = await mammoth.extractRawText({ buffer });
            textContent = result.value;
        } else {
            textContent = buffer.toString('utf-8');
        }

        const textSection = textContent
            ? `Document text:\n"""\n${textContent.slice(0, 50000)}\n"""\n\n`
            : '';

        const prompt = `${textSection}You are an expert educator creating a student study reviewer from the ${pdfBase64 ? 'PDF document' : 'text'} above.

Return ONLY a valid JSON object with this exact structure:
{
  "title": "concise specific title (5-10 words)",
  "content": "<HTML here>",
  "flashcards": [{"front": "term", "back": "explanation"}]
}

=== CONTENT RULES ===
- Cover EVERY topic, concept, definition, process, formula, person, and detail in the source — nothing may be skipped.
- Structure: use <h2> for major sections, <h3> for sub-sections.
- Format: use <ul><li> bullet lists as the PRIMARY format for all details. Minimize prose paragraphs.
- Emphasis: wrap key terms, names, formulas, and dates in <strong> tags ONLY. Do NOT use **asterisks** for bold — that is Markdown and will break the output.
- Do NOT use any Markdown formatting anywhere (no **, no *, no #, no -, no backticks outside code blocks).
- Bullets must be short, clear, and informative — not full sentences unless necessary.
- Do NOT include: introductions like "This reviewer covers...", filler sentences, meta-commentary, or redundant restatements.
- Only include factual content directly from the source: definitions, concepts, processes, relationships, examples, key facts.
- CODE BLOCKS: If the source contains any source code, commands, scripts, syntax examples, pseudocode, or technical expressions that should be displayed as code, wrap them in <pre><code>…</code></pre>. For short inline code references (variable names, function names, keywords, command snippets) inside text, wrap them in <code>…</code>. Never put code inside regular text or bullet points without these tags.

=== FLASHCARD RULES ===
- Create one flashcard for EVERY important term, concept, process, person, formula, and fact in the source.
- Do NOT limit the count — aim for complete coverage of all material, not a short list.
- front: the term or question (concise, plain text — no HTML, no Markdown)
- back: a clear, complete explanation or answer (plain text — no HTML, no Markdown)

Return nothing outside the JSON object.`;

        const result = await callGemini(prompt, pdfBase64);

        if (!result.title || !result.content) {
            return res.status(500).json({ error: 'Generation returned incomplete data. Please try again.' });
        }

        res.json({
            title: String(result.title).trim().slice(0, 200),
            content: String(result.content).trim(),
            flashcards: Array.isArray(result.flashcards)
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
        res.status(500).json({ error: 'Failed to generate reviewer. Please try again.' });
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

        // If a specific count is requested (manual quiz builder), honour it (3–100).
        // When count is omitted (auto-generation), let the AI decide — just enforce the 100 hard cap later.
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
            : `You are an expert quiz maker. Based on the reviewer below, generate as many multiple-choice questions as needed to comprehensively test EVERY topic, concept, definition, process, person, date, and fact covered — do not stop early and do not skip anything. There is no minimum or maximum you have to hit; generate however many questions are required to fully cover all the material (up to 100).

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

        res.json({ questions: questions.slice(0, 100) });
    } catch (error) {
        console.error('Auto generate-quiz error:', error);
        res.status(500).json({ error: 'Failed to generate questions. Please try again.' });
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

// 404 handler - distinguish between API and page requests
app.use((req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'API endpoint not found' });
    }
    // For page requests, serve index or redirect to login
    res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler with better logging
app.use((err, req, res, next) => {
    // Log error details (but not in production to avoid leaking info)
    const isProd = process.env.NODE_ENV === 'production';
    if (!isProd) {
        console.error('Server error:', {
            message: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method
        });
    } else {
        console.error('Server error:', err.message || err);
    }
    
    // If headers have already been sent, delegate to default handler
    if (res.headersSent) {
        return next(err);
    }
    
    // Don't expose error details in production
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
                        CHECK (type IN (''reaction'', ''comment'', ''message'', ''reply'', ''follow''))';
                END IF;
            END $$;
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

// If this file is run directly, start a standalone server (for local dev).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    _httpServer.listen(PORT, () => {
        console.log(`🚀 Reviewer App running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}

// Export the app for serverless wrappers or tests
export default app;
