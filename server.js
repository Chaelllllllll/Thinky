/**
 * REVIEWER APP - MAIN SERVER
 * Full-featured reviewer web application with Node.js, Bootstrap, and Supabase
 */

import 'dotenv/config';
import express from 'express';
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
import nodemailer from 'nodemailer';
import crypto from 'crypto';

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
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com", "https://cdn.quilljs.com"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://cdn.quilljs.com"],
            scriptSrcAttr: ["'unsafe-inline'"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://cdn.jsdelivr.net"],
            imgSrc: ["'self'", "data:", "https:"],
        },
    },
}));

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
    max: 100, // limit each IP to 100 requests per windowMs
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
    const tlsOptions = {};
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
        tls: Object.keys(tlsOptions).length ? tlsOptions : undefined
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
                            const reportedUser = vars.reportedUser || '';
                            const reviewerTitle = vars.reviewerTitle || '';
                            const reporter = vars.reporter || '';
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
                                                <p style="margin:0 0 12px 0;">Hello ${escapeHtml(reporter) || 'there'},</p>
                                                <p style="margin:0 0 12px 0;color:#444;">Thank you for reporting content on Thinky. Our moderation team has reviewed the report you submitted.</p>
                                                <table style="width:100%;margin:12px 0;background:#fafafa;padding:12px;border-radius:6px;border:1px solid #eee;">
                                                    <tr><td style="font-weight:600;width:160px;padding:6px 8px;">Outcome</td><td style="padding:6px 8px;">${escapeHtml(decision)}</td></tr>
                                                    ${reportedUser ? `<tr><td style="font-weight:600;padding:6px 8px;">Reported user</td><td style="padding:6px 8px;">${escapeHtml(reportedUser)}</td></tr>` : ''}
                                                    ${reviewerTitle ? `<tr><td style="font-weight:600;padding:6px 8px;">Reviewer</td><td style="padding:6px 8px;">${escapeHtml(reviewerTitle)}</td></tr>` : ''}
                                                    ${reason ? `<tr><td style="font-weight:600;padding:6px 8px;">Reason</td><td style="padding:6px 8px;">${escapeHtml(reason)}</td></tr>` : ''}
                                                    ${actionTakenAt ? `<tr><td style="font-weight:600;padding:6px 8px;">Date</td><td style="padding:6px 8px;">${escapeHtml(actionTakenAt)}</td></tr>` : ''}
                                                </table>
                                                <p style="margin:12px 0 0 0;color:#444;">If you have further information or evidence, you can reply to this email and our team will re-evaluate. Thank you for helping keep Thinky safe.</p>
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

        // Check if user exists (use admin client to bypass RLS for server-side check)
        const { data: existingUser, error: existingErr } = await supabaseAdmin
            .from('users')
            .select('id, is_verified')
            .or(`email.eq.${lcEmail},username.eq.${username}`)
            .maybeSingle();

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
app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
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

        // Ensure the session cookie is sent to the client. Some deployments
        // (proxies, mismatched cookie attributes, or client behavior) can
        // prevent the `Set-Cookie` header from being delivered. As a
        // defensive measure set the cookie explicitly using the same options
        // we configured for the session middleware.
        try {
            const baseCookie = (sessionOptions && sessionOptions.cookie) ? sessionOptions.cookie : {};
            // Derive whether the cookie should be marked `secure` from the
            // actual incoming request (req.session cookie flag, req.secure,
            // x-forwarded-proto or origin) so that local HTTP requests don't
            // accidentally get a `secure` cookie which browsers will ignore.
            let secureFlag;
            if (req && req.session && req.session.cookie && typeof req.session.cookie.secure !== 'undefined') {
                secureFlag = !!req.session.cookie.secure;
            } else if (req && req.secure) {
                secureFlag = true;
            } else {
                const xfpHeader = (req && req.headers) ? (req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'] || '') : '';
                const xfp = String(xfpHeader || '').split(',')[0].trim().toLowerCase();
                secureFlag = xfp === 'https';
                if (!secureFlag && req && req.headers && req.headers.origin) {
                    try {
                        secureFlag = String(req.headers.origin).toLowerCase().startsWith('https://');
                    } catch (err) {
                        // ignore
                    }
                }
            }
            if (typeof secureFlag === 'undefined') secureFlag = !!baseCookie.secure;

            const cookieOpts = {
                httpOnly: !!baseCookie.httpOnly,
                secure: !!secureFlag,
                sameSite: baseCookie.sameSite || undefined,
                maxAge: baseCookie.maxAge || undefined
            };
            if (sessionOptions && sessionOptions.cookie && sessionOptions.cookie.domain) {
                cookieOpts.domain = sessionOptions.cookie.domain;
            }
            res.cookie('connect.sid', req.sessionID, cookieOpts);
            console.info('Explicitly set connect.sid cookie on login response', { cookieOpts });
        } catch (e) {
            console.warn('Failed to explicitly set session cookie on login response:', e && e.message ? e.message : e);
        }

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
                    .select('id, email, username, role, display_name, profile_picture_url, created_at, is_dev')
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
            query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
        }

        if (student) {
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
            .select('id, username, display_name, profile_picture_url, created_at, is_dev')
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

// -------------------------
// Admin moderation endpoints
// -------------------------

// Get open/all reports for moderation
app.get('/api/admin/moderation', requireAdmin, async (req, res) => {
    try {
        const { data: reports, error } = await supabaseAdmin
            .from('reviewer_reports')
            .select(
                '*, reviewers(id,title,user_id,subject_id), ' +
                "reporter:users!reviewer_reports_reporter_id_fkey(id,username,email), " +
                "action_user:users!reviewer_reports_action_taken_by_fkey(id,username,email)"
            )
            // Only return open or unresolved reports by default
            .or('status.eq.open,status.is.null')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Failed to load reports:', error);
            return res.status(500).json({ error: 'Failed to load reports' });
        }

        res.json({ reports });
    } catch (err) {
        console.error('Admin moderation list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

// Take action on a report
app.put('/api/admin/moderation/:id/action', requireAdmin, async (req, res) => {
    try {
        const reportId = req.params.id;
        const adminId = req.session.userId;
        const { action, until, note } = req.body; // action: ban|restrict|delete_user|dismiss

        // Load report (use admin client to bypass RLS)
        const { data: rdata, error: rerr } = await supabaseAdmin
            .from('reviewer_reports')
            .select('*')
            .eq('id', reportId)
            .single();

        if (rerr || !rdata) return res.status(404).json({ error: 'Report not found' });

        // Load reviewer to find the reported user (use admin client)
        const { data: rev, error: revErr } = await supabaseAdmin
            .from('reviewers')
            .select('*')
            .eq('id', rdata.reviewer_id)
            .single();

        if (revErr || !rev) return res.status(404).json({ error: 'Reviewer not found' });

        const reportedUserId = rev.user_id;

        // Perform actions
        // Interpret empty/undefined/blank 'until' as permanent (far-future) for ban/restrict
        const farFuture = new Date(); farFuture.setFullYear(farFuture.getFullYear() + 100);
        let effectiveUntil = null;
        if (action === 'ban' || action === 'restrict') {
            if (typeof until === 'string' && until.trim() !== '') {
                effectiveUntil = until;
            } else {
                // treat blank/undefined/null as permanent
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

        if (action === 'ban') {
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

        await supabaseAdmin.from('reviewer_reports').update(update).eq('id', reportId);

        // Notify reporter and reported user by email (best-effort)
        try {
            const reporter = rdata.reporter_id;
            // fetch emails (use admin client)
            const { data: reportedUser } = await supabaseAdmin.from('users').select('email,username').eq('id', reportedUserId).single();
            const { data: reporterUser } = await supabaseAdmin.from('users').select('email,username').eq('id', rdata.reporter_id).single();

            const reason = note || '';
            let decision = 'No action taken';
            if (action === 'dismiss') {
                decision = 'Dismissed';
            } else if (action === 'delete_user') {
                decision = 'User account deleted';
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
                sendTemplatedEmail({
                    to: reporterUser.email,
                    subject: 'Update on your report to Thinky moderation',
                    template: 'moderation_decision_reporter',
                    variables: {
                        decision,
                        reason,
                        reportedUser: reportedUser ? (reportedUser.username || '') : '',
                        reviewerTitle: rev ? (rev.title || '') : '',
                        reporter: reporterUser.username || '',
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

// Get messages
app.get('/api/messages/:chatType', requireAuth, async (req, res) => {
    try {
        const { chatType } = req.params;
        const limit = parseInt(req.query.limit) || 100;

        let query;
        if (chatType === 'private') {
            const other = req.query.with;
            if (!other) return res.status(400).json({ error: 'Missing "with" query param for private chat' });

            // Fetch messages between current user and the other user using admin client
            const { data: messages, error } = await supabaseAdmin
                .from('messages')
                .select('*, users:user_id (username, profile_picture_url)')
                .or(
                    `and(user_id.eq.${req.session.userId},recipient_id.eq.${other}),and(user_id.eq.${other},recipient_id.eq.${req.session.userId})`
                )
                .order('created_at', { ascending: false })
                .limit(limit);

                if (error) {
                    console.error('Get messages error:', error);
                    return res.status(500).json({ error: 'Failed to fetch messages' });
                }

                try { console.debug('Get messages:', chatType, 'count=', (messages && messages.length) ? messages.length : 0); } catch (e) {}
                return res.json({ messages: messages.reverse() });
        } else {
                const { data: messages, error } = await supabaseAdmin
                .from('messages')
                .select('*, users:user_id (username, profile_picture_url)')
                .eq('chat_type', chatType)
                .order('created_at', { ascending: false })
                .limit(limit);

            if (error) {
                console.error('Get messages error:', error);
                return res.status(500).json({ error: 'Failed to fetch messages' });
            }

            try { console.debug('Get messages:', chatType, 'count=', (messages && messages.length) ? messages.length : 0); } catch (e) {}
            return res.json({ messages: messages.reverse() });
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

// Send message
app.post('/api/messages', requireAuth, async (req, res) => {
    try {
        const { message, chat_type } = req.body;
        const recipient_id = req.body.recipient_id || null;

        if (!message || !chat_type) {
            return res.status(400).json({ error: 'Message and chat type are required' });
        }

        const insertObj = {
            user_id: req.session.userId,
            username: req.session.username,
            message,
            chat_type
        };
        if (chat_type === 'private') insertObj.recipient_id = recipient_id;

        const { data: newMessage, error } = await supabaseAdmin
            .from('messages')
            .insert([insertObj])
            .select()
            .single();

        if (error) {
            console.error('Send message error:', error);
            return res.status(500).json({ error: 'Failed to send message' });
        }

        try { console.debug('New message inserted:', newMessage && newMessage.id ? { id: newMessage.id, user_id: newMessage.user_id, chat_type: newMessage.chat_type } : newMessage); } catch (e) {}
        res.json({ message: newMessage });
    } catch (error) {
        console.error('Send message error:', error);
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

// Update current user's profile (username / display_name)
app.put('/api/auth/me', requireAuth, async (req, res) => {
    try {
        const { username, display_name } = req.body;

        const updates = {};
        if (username) updates.username = username;
        if (display_name !== undefined) updates.display_name = display_name;

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

        if (!['student', 'admin'].includes(role)) {
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

// Delete user
app.delete('/api/admin/users/:id', requireAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Prevent self-deletion
        if (id === req.session.userId) {
            return res.status(400).json({ error: 'Cannot delete your own account' });
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

// Profile and Settings (protected)
app.get('/profile', (req, res) => {
    if (!req.session.userId) return res.redirect('/login');
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});


// =====================================================
// ERROR HANDLING
// =====================================================

// 404 handler
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    // If headers have already been sent (response partially handled), delegate to
    // the default Express error handler to avoid "Cannot set headers after they are sent".
    if (res.headersSent) {
        return next(err);
    }
    res.status(500).json({ error: 'Internal server error' });
});

// =====================================================
// START SERVER
// =====================================================

// If this file is run directly, start a standalone server (for local dev).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    app.listen(PORT, () => {
        console.log(`🚀 Reviewer App running on http://localhost:${PORT}`);
        console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
}

// Export the app for serverless wrappers or tests
export default app;
