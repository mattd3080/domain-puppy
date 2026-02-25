import { connect } from 'cloudflare:sockets';

/**
 * Domain Puppy — Cloudflare Worker Proxy
 * Premium domain lookup via Fastly Domain Research API (Domainr)
 *
 * Privacy: domain names are never logged. Only aggregate metrics are tracked.
 * Security: FASTLY_API_TOKEN lives in Cloudflare secrets, never in responses.
 */

const RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

function isValidDomain(domain) {
  if (!domain || typeof domain !== 'string') return false;
  if (domain.length > 253) return false;
  const labels = domain.toLowerCase().split('.');
  if (labels.length < 2) return false;
  if (!labels.every(label => {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return /^[a-z0-9-]+$/.test(label);
  })) return false;
  const tld = labels[labels.length - 1];
  if (/^\d+$/.test(tld)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Domainr status mapping
// ---------------------------------------------------------------------------

/**
 * Maps Domainr space-separated status tokens to our simplified status string.
 *
 * Domainr returns status as a space-separated string of tokens, e.g.:
 *   "undelegated inactive", "active", "marketed", "priced", "parked"
 *
 * We split and check for key terms in priority order.
 */
function mapDomainrStatus(domainrStatusString) {
  if (!domainrStatusString || typeof domainrStatusString !== 'string') {
    return 'unknown';
  }

  const tokens = domainrStatusString.toLowerCase().split(/\s+/);

  // "marketed" or "for sale" → aftermarket listing
  if (tokens.includes('marketed') || tokens.includes('forsale') || domainrStatusString.toLowerCase().includes('for sale')) {
    return 'for_sale';
  }

  // "priced" → registry premium
  if (tokens.includes('priced')) {
    return 'premium';
  }

  // "parked" → registered but parked
  if (tokens.includes('parked')) {
    return 'parked';
  }

  // "active" present → domain is registered/taken
  if (tokens.includes('active')) {
    return 'taken';
  }

  // "inactive" → available for standard registration
  if (tokens.includes('inactive')) {
    return 'available';
  }

  return 'unknown';
}

/**
 * Parses the Domainr API response body and extracts our simplified status.
 * Domainr returns: { "status": [ { "domain": "...", "status": "...", ... } ] }
 */
function parseDomainrResponse(data, requestedDomain) {
  if (!data || !Array.isArray(data.status) || data.status.length === 0) {
    return 'unknown';
  }

  // Prefer the entry that matches our exact domain, fall back to first entry
  const normalizedRequest = requestedDomain.toLowerCase();
  const entry =
    data.status.find(s => s.domain && s.domain.toLowerCase() === normalizedRequest) ||
    data.status[0];

  return mapDomainrStatus(entry.status || entry.summary || '');
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: RESPONSE_HEADERS,
  });
}

function errorResponse(status, errorCode, message) {
  const body = { error: errorCode };
  if (message) body.message = message;
  return jsonResponse(body, status);
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** Returns current UTC month as "YYYY-MM". */
function getCurrentMonth() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

// ---------------------------------------------------------------------------
// Client IP extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the client IP from the Cloudflare-provided header.
 * Falls back to a safe sentinel if the header is absent (local dev).
 */
function getClientIP(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// ---------------------------------------------------------------------------
// IP quota tracking
// ---------------------------------------------------------------------------

/**
 * Checks the quota for a client IP without incrementing.
 *
 * KV key: ip:{clientIP}:{YYYY-MM}
 * KV value: { "checksUsed": N }
 *
 * Returns { allowed: bool, checksUsed: number, remaining: number }.
 * Fails open if KV is unavailable (allows the request through).
 */
async function checkQuota(env, clientIP, freeChecksPerIP) {
  if (!env.QUOTA_KV) {
    // KV not configured — fail open
    return { allowed: true, checksUsed: 0, remaining: freeChecksPerIP };
  }

  try {
    const key = `ip:${clientIP}:${getCurrentMonth()}`;
    const raw = await env.QUOTA_KV.get(key);
    const checksUsed = raw ? (JSON.parse(raw).checksUsed || 0) : 0;
    const allowed = checksUsed < freeChecksPerIP;
    const remaining = Math.max(0, freeChecksPerIP - checksUsed);
    return { allowed, checksUsed, remaining };
  } catch {
    // KV read failure — fail open
    return { allowed: true, checksUsed: 0, remaining: freeChecksPerIP };
  }
}

/**
 * Increments the quota counter for a client IP in KV.
 * Called only AFTER a successful API response to avoid charging for failures.
 * TTL: 60 days (5184000 seconds).
 */
async function incrementQuota(env, clientIP, checksUsed) {
  if (!env.QUOTA_KV) return;

  try {
    const key = `ip:${clientIP}:${getCurrentMonth()}`;
    const newValue = JSON.stringify({ checksUsed: checksUsed + 1 });
    await env.QUOTA_KV.put(key, newValue, { expirationTtl: 5184000 });
  } catch {
    // KV write failure — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Global circuit breaker (monthly)
// ---------------------------------------------------------------------------

/**
 * Checks whether the global monthly circuit breaker is open (tripped).
 *
 * KV key: circuit:monthly:{YYYY-MM}
 * KV value: { "requestCount": N }
 *
 * Trips when total monthly requests reach MONTHLY_QUOTA_LIMIT (default 8000).
 *
 * Returns { open: bool, requestCount: number }.
 * Fails open if KV is unavailable.
 */
async function checkCircuitBreaker(env, monthlyQuotaLimit) {
  if (!env.QUOTA_KV) {
    return { open: false, requestCount: 0 };
  }

  try {
    const key = `circuit:monthly:${getCurrentMonth()}`;
    const raw = await env.QUOTA_KV.get(key);
    const requestCount = raw ? (JSON.parse(raw).requestCount || 0) : 0;
    return { open: requestCount >= monthlyQuotaLimit, requestCount };
  } catch {
    // KV read failure — fail open
    return { open: false, requestCount: 0 };
  }
}

/**
 * Increments the global monthly request counter in KV.
 * TTL: 60 days (5184000 seconds) — covers the current month plus buffer.
 *
 * If the new count hits the monthly limit, fires a one-time webhook alert
 * (via ALERT_WEBHOOK env var) so the operator knows the breaker has tripped.
 */
async function incrementMonthlyCount(env, monthlyQuotaLimit) {
  if (!env.QUOTA_KV) return;

  try {
    const month = getCurrentMonth();
    const key = `circuit:monthly:${month}`;
    const raw = await env.QUOTA_KV.get(key);
    const requestCount = raw ? (JSON.parse(raw).requestCount || 0) : 0;
    const newCount = requestCount + 1;
    await env.QUOTA_KV.put(key, JSON.stringify({ requestCount: newCount }), { expirationTtl: 5184000 });

    // Fire alert webhook exactly once when the breaker trips
    if (newCount >= monthlyQuotaLimit && requestCount < monthlyQuotaLimit) {
      await sendBreakerAlert(env, month, newCount, monthlyQuotaLimit);
    }
  } catch {
    // KV write failure — non-fatal
  }
}

/**
 * Sends a one-time webhook alert when the circuit breaker trips.
 * Requires ALERT_WEBHOOK env var (e.g., Discord/Slack webhook URL).
 * Silently no-ops if ALERT_WEBHOOK is not configured.
 */
async function sendBreakerAlert(env, month, count, limit) {
  if (!env.ALERT_WEBHOOK) return;

  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `Domain Puppy circuit breaker tripped for ${month}. ${count}/${limit} requests used. Premium search is now disabled until next month.`,
        content: `Domain Puppy circuit breaker tripped for ${month}. ${count}/${limit} requests used. Premium search is now disabled until next month.`,
      }),
    });
  } catch {
    // Alert delivery failure — non-fatal
  }
}


// ---------------------------------------------------------------------------
// Per-IP burst rate limiter
// ---------------------------------------------------------------------------

/**
 * Checks whether a client IP has exceeded the per-minute burst rate limit.
 *
 * KV key: ratelimit:{clientIP}:{minute}
 * TTL: 120 seconds (covers the current minute plus one).
 *
 * Returns { limited: bool }.
 * Fails open if KV is unavailable.
 */
async function checkRateLimit(env, clientIP, maxPerMinute = 10) {
  if (!env.QUOTA_KV) return { limited: false };

  try {
    const minute = Math.floor(Date.now() / 60000);
    const key = `ratelimit:${clientIP}:${minute}`;
    const raw = await env.QUOTA_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    if (count >= maxPerMinute) return { limited: true };
    await env.QUOTA_KV.put(key, String(count + 1), { expirationTtl: 120 });
    return { limited: false };
  } catch {
    return { limited: false }; // fail open
  }
}

// ---------------------------------------------------------------------------
// Analytics helpers
// ---------------------------------------------------------------------------

/** Returns current UTC date as "YYYY-MM-DD". */
function getCurrentDay() {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Hashes an IP address with a salt using SHA-256, returning the first 12
 * hex characters. Used to track unique users without storing raw IPs.
 */
async function hashIPForWindow(ip, salt) {
  const input = `${ip}:${salt}`;
  const encoded = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.slice(0, 12);
}

/**
 * Tracks a unique user in a KV-backed set for a given time window.
 * Reads a JSON array, appends the hashedIP if not already present,
 * and writes back with the given TTL. Fails silently on any error.
 */
async function trackUniqueUser(env, key, hashedIP, ttl) {
  if (!env.QUOTA_KV) return;

  try {
    const raw = await env.QUOTA_KV.get(key);
    const set = raw ? JSON.parse(raw) : [];
    if (set.includes(hashedIP)) return;
    set.push(hashedIP);
    await env.QUOTA_KV.put(key, JSON.stringify(set), { expirationTtl: ttl });
  } catch {
    // KV failure — non-fatal
  }
}

/**
 * Increments an integer counter in KV.
 * Reads the current value, increments by 1, and writes back.
 * Pass null for ttl to write without an expiration. Fails silently on any error.
 */
async function incrementCounter(env, key, ttl) {
  if (!env.QUOTA_KV) return;

  try {
    const raw = await env.QUOTA_KV.get(key);
    const count = raw ? parseInt(raw, 10) : 0;
    const options = ttl !== null ? { expirationTtl: ttl } : undefined;
    await env.QUOTA_KV.put(key, String(count + 1), options);
  } catch {
    // KV failure — non-fatal
  }
}

// ---------------------------------------------------------------------------
// Version check handler
// ---------------------------------------------------------------------------

/**
 * Handles GET /v1/version.
 * Returns the current skill version and records non-blocking analytics
 * (DAU, MAU, monthly check count, all-time check count) via waitUntil.
 */
async function handleVersionCheck(request, env) {
  const clientIP = getClientIP(request);

  // Per-IP burst rate limit (30/min for version endpoint)
  const { limited } = await checkRateLimit(env, clientIP, 30);
  if (limited) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Please wait a moment.');
  }

  const day = getCurrentDay();
  const month = getCurrentMonth();

  const [dayHash, monthHash] = await Promise.all([
    hashIPForWindow(clientIP, `dau:${day}`),
    hashIPForWindow(clientIP, `mau:${month}`),
  ]);

  // Fire analytics in the background — does not block the response
  const analyticsPromise = Promise.all([
    trackUniqueUser(env, `version:dau:${day}`, dayHash, 3024000),   // 35d TTL
    trackUniqueUser(env, `version:mau:${month}`, monthHash, 5184000), // 60d TTL
    incrementCounter(env, `version:checks:${month}`, 5184000),       // monthly total
    incrementCounter(env, 'version:total', null),                    // all-time
  ]);

  if (env.ctx) {
    env.ctx.waitUntil(analyticsPromise);
  }

  // Return version without CORS headers and with no-store cache control
  return new Response(JSON.stringify({ version: env.SKILL_VERSION }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

// ---------------------------------------------------------------------------
// WHOIS availability checking (Layer 2 — 13 ccTLDs without RDAP)
// ---------------------------------------------------------------------------

const WHOIS_SERVERS = {
  co: 'whois.registry.co',
  it: 'whois.nic.it',
  de: 'whois.denic.de',
  be: 'whois.dns.be',
  at: 'whois.nic.at',
  se: 'whois.iis.se',
  gg: 'whois.gg',
  st: 'whois.nic.st',
  pt: 'whois.dns.pt',
  my: 'whois.mynic.my',
  nu: 'whois.iis.nu',
  am: 'whois.amnic.net',
  es: 'whois.nic.es',
};

const SUPPORTED_WHOIS_TLDS = new Set(Object.keys(WHOIS_SERVERS));

// Most WHOIS servers accept plain "domain\r\n". Exceptions listed here.
const WHOIS_QUERY_FORMATS = {
  'whois.denic.de': (domain) => `-T dn,ace ${domain}\r\n`,
};

function buildWhoisQuery(domain, server) {
  const safeDomain = domain.replace(/[^a-z0-9.-]/gi, '');
  const formatter = WHOIS_QUERY_FORMATS[server];
  return formatter ? formatter(safeDomain) : `${safeDomain}\r\n`;
}

const WHOIS_PARSERS = {
  'whois.registry.co': (r) => {
    if (/DOMAIN NOT FOUND/i.test(r)) return 'available';
    if (/Domain Name:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.nic.it': (r) => {
    if (/AVAILABLE/i.test(r) || /Status:\s*AVAILABLE/i.test(r)) return 'available';
    if (/Domain:/i.test(r) && /Status:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.denic.de': (r) => {
    if (/^Status:\s*free/im.test(r)) return 'available';
    if (/^Domain:/im.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.dns.be': (r) => {
    if (/Status:\s*NOT\s+AVAILABLE/i.test(r)) return 'taken';
    if (/Status:\s*AVAILABLE/i.test(r)) return 'available';
    if (/Registered:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.nic.at': (r) => {
    if (/nothing found/i.test(r)) return 'available';
    if (/domain:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.iis.se': (r) => {
    if (/not found/i.test(r)) return 'available';
    if (/domain:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.gg': (r) => {
    if (/NOT FOUND/i.test(r)) return 'available';
    if (/Domain:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.nic.st': (r) => {
    if (!/Domain Name:/i.test(r)) return 'available';
    if (/Domain Name:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.dns.pt': (r) => {
    if (/not found/i.test(r) || !/Domain:/i.test(r)) return 'available';
    if (/Domain:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.mynic.my': (r) => {
    if (!/Domain Name:/i.test(r)) return 'available';
    if (/Domain Name:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.iis.nu': (r) => {
    if (/not found/i.test(r)) return 'available';
    if (/domain:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.amnic.net': (r) => {
    if (/No match/i.test(r)) return 'available';
    if (/Domain Name:/i.test(r)) return 'taken';
    return 'unknown';
  },
  'whois.nic.es': (r) => {
    // .es WHOIS requires IP authorization — most queries will fail
    if (/LIBRE/i.test(r) || /no encontrado/i.test(r)) return 'available';
    if (/Nombre de dominio:/i.test(r) || /Domain Name:/i.test(r)) return 'taken';
    return 'unknown';
  },
};

function parseWhoisResponse(response, server) {
  if (!response || response.trim().length === 0) return 'unknown';
  const parser = WHOIS_PARSERS[server];
  return parser ? parser(response) : 'unknown';
}

const MAX_WHOIS_RESPONSE = 10 * 1024; // 10KB guard
const WHOIS_TIMEOUT_MS = 5000; // 5-second timeout

async function whoisLookup(domain, server) {
  const query = buildWhoisQuery(domain, server);
  let socket;
  try {
    socket = connect({ hostname: server, port: 43 });

    // Write query — release lock without closing to keep socket open for reading
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(query));
    writer.releaseLock();

    // Read response with timeout and size guard
    const reader = socket.readable.getReader();
    let response = '';
    const deadline = Date.now() + WHOIS_TIMEOUT_MS;

    try {
      while (true) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;

        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), remaining)
        );

        let result;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } catch {
          break; // Timeout
        }

        const { done, value } = result;
        if (done) break;
        if (response.length + value.byteLength > MAX_WHOIS_RESPONSE) break; // Size guard
        response += new TextDecoder().decode(value);
      }
    } finally {
      reader.releaseLock();
    }

    return response;
  } catch {
    return ''; // Connection failure
  } finally {
    if (socket) {
      try { socket.close(); } catch { /* ignore */ }
    }
  }
}

async function handleWhoisCheck(request, env) {
  // Per-IP burst rate limit (protects against abuse even though WHOIS has no API cost)
  const clientIP = getClientIP(request);
  const { limited } = await checkRateLimit(env, clientIP);
  if (limited) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Please wait a moment.');
  }

  // Request body size limit
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > 4096) {
    return errorResponse(413, 'payload_too_large', 'Request body too large');
  }

  // Enforce Content-Type
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return errorResponse(400, 'bad_request', 'Content-Type must be application/json');
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Request body is not valid JSON');
  }

  const { domain } = body;

  // Validate domain
  if (!domain) {
    return errorResponse(400, 'bad_request', 'Missing required field: domain');
  }
  if (typeof domain !== 'string') {
    return errorResponse(400, 'bad_request', 'Field "domain" must be a string');
  }
  if (!isValidDomain(domain)) {
    return errorResponse(400, 'bad_request', 'Invalid domain format');
  }

  // TLD whitelist — only accept the 13 supported WHOIS TLDs
  const tld = domain.split('.').pop().toLowerCase();
  if (!SUPPORTED_WHOIS_TLDS.has(tld)) {
    return errorResponse(400, 'unsupported_tld', `TLD .${tld} is not supported by WHOIS check. Use RDAP instead.`);
  }

  const server = WHOIS_SERVERS[tld];
  if (!server) {
    return errorResponse(400, 'unsupported_tld', `No WHOIS server configured for .${tld}`);
  }

  // Perform WHOIS lookup — domain name is used only for the query, never logged
  const whoisResponse = await whoisLookup(domain, server);
  const status = parseWhoisResponse(whoisResponse, server);

  return jsonResponse({ status });
}

// ---------------------------------------------------------------------------
// Request handler
// ---------------------------------------------------------------------------

async function handlePremiumCheck(request, env) {
  const freeChecksPerIP = parseInt(env.FREE_CHECKS_PER_IP, 10) || 5;
  const monthlyQuotaLimit = parseInt(env.MONTHLY_QUOTA_LIMIT, 10) || 8000;

  // Extract client IP first — needed for quota and rate limit checks
  const clientIP = getClientIP(request);

  // --- Per-IP burst rate limit ---
  const { limited } = await checkRateLimit(env, clientIP);
  if (limited) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Please wait a moment.');
  }

  // --- Global circuit breaker check ---
  const { open } = await checkCircuitBreaker(env, monthlyQuotaLimit);
  if (open) {
    return errorResponse(503, 'service_unavailable');
  }

  // --- IP quota check ---
  const { allowed, checksUsed } = await checkQuota(env, clientIP, freeChecksPerIP);
  if (!allowed) {
    return jsonResponse({ error: 'quota_exceeded', remainingChecks: 0 }, 429);
  }

  // Request body size limit
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > 4096) {
    return errorResponse(413, 'payload_too_large', 'Request body too large');
  }

  // Enforce Content-Type
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return errorResponse(400, 'bad_request', 'Content-Type must be application/json');
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Request body is not valid JSON');
  }

  const { domain } = body;

  // Validate domain field
  if (!domain) {
    return errorResponse(400, 'bad_request', 'Missing required field: domain');
  }
  if (typeof domain !== 'string') {
    return errorResponse(400, 'bad_request', 'Field "domain" must be a string');
  }
  if (!isValidDomain(domain)) {
    return errorResponse(400, 'bad_request', 'Invalid domain format');
  }

  // Guard: FASTLY_API_TOKEN must be configured
  if (!env.FASTLY_API_TOKEN) {
    return errorResponse(503, 'service_unavailable');
  }

  // Forward to Fastly Domain Research API (Domainr)
  let domainrResponse;
  try {
    domainrResponse = await fetch(
      `https://api.domainr.com/v2/status?domain=${encodeURIComponent(domain)}`,
      {
        headers: {
          'Fastly-Key': env.FASTLY_API_TOKEN,
        },
      }
    );
  } catch {
    // Network-level failure reaching the upstream API
    return errorResponse(503, 'service_unavailable');
  }

  // Handle upstream quota errors
  if (domainrResponse.status === 429) {
    return jsonResponse({ error: 'quota_exceeded', remainingChecks: 0 }, 429);
  }

  // Handle other upstream errors
  if (!domainrResponse.ok) {
    return errorResponse(503, 'service_unavailable');
  }

  // Parse upstream response
  let domainrData;
  try {
    domainrData = await domainrResponse.json();
  } catch {
    return errorResponse(503, 'service_unavailable');
  }

  // Map status — domain name is used only for matching, never logged
  const status = parseDomainrResponse(domainrData, domain);

  // API call succeeded — increment both IP quota and global monthly counter
  await Promise.all([
    incrementQuota(env, clientIP, checksUsed),
    incrementMonthlyCount(env, monthlyQuotaLimit),
  ]);

  const remainingChecks = Math.max(0, freeChecksPerIP - (checksUsed + 1));

  return jsonResponse({
    status,
    remainingChecks,
  });
}

// ---------------------------------------------------------------------------
// Worker entry point (ES module syntax)
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle OPTIONS preflight for all routes
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {} });
    }

    try {
      // Route: GET /v1/version
      if (request.method === 'GET' && url.pathname === '/v1/version') {
        return await handleVersionCheck(request, { ...env, ctx });
      }

      // Route: POST /v1/premium-check
      if (request.method === 'POST' && url.pathname === '/v1/premium-check') {
        return await handlePremiumCheck(request, env);
      }

      // Route: POST /v1/whois-check
      if (request.method === 'POST' && url.pathname === '/v1/whois-check') {
        return await handleWhoisCheck(request, env);
      }

      // All other routes → 404
      return errorResponse(404, 'not_found', 'Endpoint not found');
    } catch {
      // Catch-all: never expose internals
      return errorResponse(500, 'internal_error');
    }
  },
};
