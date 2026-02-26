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
// Domain availability check — RDAP routing table (Layer 1)
// ---------------------------------------------------------------------------

// Privacy: domain names are never logged, stored, or transmitted beyond the RDAP/WHOIS lookup.

/** Builds an Identity Digital RDAP URL. */
const _idUrl = (d) => `https://rdap.identitydigital.services/rdap/domain/${d}`;

/** Builds a CentralNic RDAP URL (TLD is part of the path). */
const _cnUrl = (tld) => (d) => `https://rdap.centralnic.com/${tld}/domain/${d}`;

/**
 * RDAP_ROUTES maps each supported TLD (without the dot) to a function that
 * takes the full domain and returns the RDAP lookup URL.
 *
 * Source of truth: references/rdap-endpoints.md
 */
const RDAP_ROUTES = {
  // --- Verisign (3 TLDs) ---
  com:  (d) => `https://rdap.verisign.com/com/v1/domain/${d}`,
  net:  (d) => `https://rdap.verisign.com/net/v1/domain/${d}`,
  cc:   (d) => `https://tld-rdap.verisign.com/cc/v1/domain/${d}`,

  // --- Google (2 TLDs) ---
  dev: (d) => `https://pubapi.registry.google/rdap/domain/${d}`,
  app: (d) => `https://pubapi.registry.google/rdap/domain/${d}`,

  // --- Identity Digital (34 TLDs; .io, .me, .sh are unofficial but verified working) ---
  ai:          _idUrl,
  io:          _idUrl,
  me:          _idUrl,
  sh:          _idUrl,
  tools:       _idUrl,
  codes:       _idUrl,
  run:         _idUrl,
  studio:      _idUrl,
  gallery:     _idUrl,
  media:       _idUrl,
  chat:        _idUrl,
  coffee:      _idUrl,
  cafe:        _idUrl,
  ventures:    _idUrl,
  supply:      _idUrl,
  agency:      _idUrl,
  capital:     _idUrl,
  community:   _idUrl,
  social:      _idUrl,
  group:       _idUrl,
  team:        _idUrl,
  market:      _idUrl,
  deals:       _idUrl,
  academy:     _idUrl,
  school:      _idUrl,
  training:    _idUrl,
  care:        _idUrl,
  clinic:      _idUrl,
  band:        _idUrl,
  money:       _idUrl,
  finance:     _idUrl,
  fund:        _idUrl,
  tax:         _idUrl,
  investments: _idUrl,

  // --- CentralNic (10 TLDs; TLD is included in path) ---
  xyz:   _cnUrl('xyz'),
  build: _cnUrl('build'),
  art:   _cnUrl('art'),
  game:  _cnUrl('game'),
  quest: _cnUrl('quest'),
  lol:   _cnUrl('lol'),
  inc:   _cnUrl('inc'),
  store: _cnUrl('store'),
  audio: _cnUrl('audio'),
  fm:    _cnUrl('fm'),

  // --- Dedicated NICs (9 TLDs) ---
  design:  (d) => `https://rdap.nic.design/domain/${d}`,
  ink:     (d) => `https://rdap.nic.ink/domain/${d}`,
  menu:    (d) => `https://rdap.nic.menu/domain/${d}`,
  club:    (d) => `https://rdap.nic.club/domain/${d}`,
  courses: (d) => `https://rdap.nic.courses/domain/${d}`,
  health:  (d) => `https://rdap.nic.health/domain/${d}`,
  fit:     (d) => `https://rdap.nic.fit/domain/${d}`,
  music:   (d) => `https://rdap.registryservices.music/rdap/domain/${d}`,
  shop:    (d) => `https://rdap.gmoregistry.net/rdap/domain/${d}`,

  // --- ccTLDs with IANA RDAP (6 TLDs) ---
  ly: (d) => `https://rdap.nic.ly/domain/${d}`,
  is: (d) => `https://rdap.isnic.is/rdap/domain/${d}`,
  to: (d) => `https://rdap.tonicregistry.to/rdap/domain/${d}`,
  in: (d) => `https://rdap.nixiregistry.in/rdap/domain/${d}`,
  re: (d) => `https://rdap.nic.re/domain/${d}`,
  no: (d) => `https://rdap.norid.no/domain/${d}`,
};

/**
 * TLDs handled by the existing whoisLookup() function.
 * These are the 12 ccTLDs with no RDAP, routed through the WHOIS proxy.
 */
const WHOIS_TLDS = new Set(['co', 'it', 'de', 'be', 'at', 'se', 'gg', 'st', 'pt', 'my', 'nu', 'am']);

/**
 * TLDs where availability checking is unreliable and should be skipped.
 * .es requires IP-based authentication — always returns unknown.
 */
const SKIP_TLDS = new Set(['es']);

/** Per-domain RDAP fetch timeout in milliseconds. */
const RDAP_TIMEOUT_MS = 8000;

/**
 * Fetches an RDAP URL with a timeout and returns the HTTP status code.
 * Returns null on network failure or timeout.
 */
async function fetchRdapStatus(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/rdap+json' },
    });
    return response.status;
  } catch {
    return null; // Network error or timeout
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps an RDAP HTTP status code to a domain availability status string.
 * 200 → taken, 404 → available, anything else → unknown.
 */
function mapRdapStatus(httpStatus) {
  if (httpStatus === 200) return 'taken';
  if (httpStatus === 404) return 'available';
  return 'unknown';
}

/**
 * Checks a single domain via RDAP with one retry for non-definitive responses.
 * Non-definitive: null (error/timeout), 429, or 5xx.
 *
 * Returns { status, reason? }.
 */
async function checkDomainRdap(domain, tld) {
  const urlFn = RDAP_ROUTES[tld];
  const url = urlFn(domain);

  let httpStatus = await fetchRdapStatus(url);

  // Retry once for non-definitive results (timeout=null, 429, 5xx)
  const isNonDefinitive = httpStatus === null || httpStatus === 429 || (httpStatus >= 500 && httpStatus < 600);
  if (isNonDefinitive) {
    // Wait 2 seconds then retry
    await new Promise(resolve => setTimeout(resolve, 2000));
    httpStatus = await fetchRdapStatus(url);
  }

  const status = httpStatus !== null ? mapRdapStatus(httpStatus) : 'unknown';
  if (status === 'unknown') {
    return { status, reason: httpStatus === null ? 'timeout' : `http_${httpStatus}` };
  }
  return { status };
}

/**
 * Checks a single domain via the existing WHOIS infrastructure.
 * Calls whoisLookup() directly — does not make an HTTP request to /v1/whois-check.
 *
 * Returns { status, reason? }.
 */
async function checkDomainWhois(domain, tld) {
  const server = WHOIS_SERVERS[tld];
  if (!server) return { status: 'unknown', reason: 'no_whois_server' };

  try {
    const raw = await whoisLookup(domain, server);
    const status = parseWhoisResponse(raw, server);
    if (status === 'unknown') return { status, reason: 'whois_inconclusive' };
    return { status };
  } catch {
    return { status: 'unknown', reason: 'whois_error' };
  }
}

/**
 * Determines the availability of a single domain by routing to RDAP, WHOIS,
 * or returning a skip/unknown result based on TLD.
 *
 * Returns { status, reason? }.
 */
async function checkSingleDomain(domain, tld) {
  if (SKIP_TLDS.has(tld)) {
    return { status: 'skip', reason: 'tld_not_supported' };
  }
  if (WHOIS_TLDS.has(tld)) {
    return checkDomainWhois(domain, tld);
  }
  if (RDAP_ROUTES[tld]) {
    return checkDomainRdap(domain, tld);
  }
  // No RDAP and not in WHOIS list — unknown TLD, no rdap.org fallback
  return { status: 'unknown', reason: 'tld_not_supported' };
}

/**
 * Handles POST /v1/check.
 *
 * Privacy: domain names are never logged, stored, or transmitted beyond the RDAP/WHOIS lookup.
 *
 * Accepts: { domains: string[] }  (1–20 elements, valid domain format)
 * Returns: { version, results, meta }
 */
async function handleDomainCheck(request, env, ctx) {
  // Per-IP burst rate limit (10/min — same default as other endpoints)
  const clientIP = getClientIP(request);
  const { limited } = await checkRateLimit(env, clientIP, 10);
  if (limited) {
    return errorResponse(429, 'rate_limited', 'Too many requests. Please wait a moment.');
  }

  // Enforce Content-Type: application/json
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.includes('application/json')) {
    return errorResponse(400, 'bad_request', 'Content-Type must be application/json');
  }

  // Reject oversized payloads (8KB — larger than other endpoints due to array input)
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > 8192) {
    return errorResponse(413, 'payload_too_large', 'Request body too large');
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse(400, 'bad_request', 'Request body is not valid JSON');
  }

  // Validate domains field
  if (!body || !('domains' in body)) {
    return errorResponse(400, 'bad_request', 'Missing required field: domains');
  }
  if (!Array.isArray(body.domains)) {
    return errorResponse(400, 'bad_request', 'Field "domains" must be an array');
  }
  if (body.domains.length === 0) {
    return errorResponse(400, 'bad_request', 'Field "domains" must not be empty');
  }
  if (body.domains.length > 20) {
    return errorResponse(400, 'bad_request', 'Field "domains" exceeds the maximum of 20 domains per request');
  }

  // Validate each element
  for (const item of body.domains) {
    if (typeof item !== 'string') {
      return errorResponse(400, 'bad_request', 'Each element in "domains" must be a string');
    }
  }

  // Normalise to lowercase, then deduplicate
  const normalised = body.domains.map(d => d.toLowerCase());
  const unique = [...new Set(normalised)];

  // Validate domain formats
  for (const domain of unique) {
    if (!isValidDomain(domain)) {
      return errorResponse(400, 'bad_request', `Invalid domain format: ${domain}`);
    }
  }

  const startMs = Date.now();

  // Check all domains in parallel
  const settledResults = await Promise.allSettled(
    unique.map(async (domain) => {
      const tld = domain.split('.').pop();
      const result = await checkSingleDomain(domain, tld);
      return { domain, result };
    })
  );

  const durationMs = Date.now() - startMs;

  // Build results map
  const results = {};
  let completed = 0;
  let incomplete = 0;

  for (const settled of settledResults) {
    if (settled.status === 'fulfilled') {
      const { domain, result } = settled.value;
      results[domain] = result;
      if (result.status !== 'unknown') {
        completed++;
      } else {
        incomplete++;
      }
    } else {
      // Promise itself rejected (should not happen — checkSingleDomain catches internally)
      // We don't know which domain this was, so this is a safety path only.
      incomplete++;
    }
  }

  return jsonResponse({
    version: '1',
    results,
    meta: {
      checked: unique.length,
      completed,
      incomplete,
      duration_ms: durationMs,
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

      // Route: POST /v1/check
      if (request.method === 'POST' && url.pathname === '/v1/check') {
        return await handleDomainCheck(request, env, ctx);
      }

      // All other routes → 404
      return errorResponse(404, 'not_found', 'Endpoint not found');
    } catch {
      // Catch-all: never expose internals
      return errorResponse(500, 'internal_error');
    }
  },
};
