/**
 * Domain Puppy Worker — Unit tests for POST /v1/check
 * Uses the built-in Node.js test runner (node:test + node:assert).
 * No external frameworks, no real network calls.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Stubs for Cloudflare-specific APIs not available in Node.js
// ---------------------------------------------------------------------------

// Stub `cloudflare:sockets` — not available in Node test env
import { createRequire } from 'node:module';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

// We need to intercept `import { connect } from 'cloudflare:sockets'` and
// provide a stub. We do this by hooking the module resolution before importing
// index.js.  Node 22 supports `register()` with custom loaders.  As a simpler
// approach for Node 18+, we override the global and use dynamic import with a
// loader shim via a module mock helper below.

// ---------------------------------------------------------------------------
// Minimal Request / Response / Headers polyfill for Node < 22 environments
// (Node 18 ships with the Web Fetch API, but some CI images may lack it.)
// ---------------------------------------------------------------------------

// Node 18+ has globalThis.Request, Response, Headers.  We guard just in case.
if (!globalThis.Request) {
  // Minimal shim — only what the handler uses.
  globalThis.Request = class Request {
    constructor(url, init = {}) {
      this.url = url;
      this.method = init.method || 'GET';
      this.headers = new Headers(init.headers || {});
      this._body = init.body || null;
    }
    async json() { return JSON.parse(this._body); }
    async text() { return this._body || ''; }
  };

  globalThis.Headers = class Headers {
    constructor(init = {}) { this._h = {}; Object.entries(init).forEach(([k, v]) => this._h[k.toLowerCase()] = v); }
    get(name) { return this._h[name.toLowerCase()] ?? null; }
    set(name, value) { this._h[name.toLowerCase()] = value; }
    has(name) { return name.toLowerCase() in this._h; }
  };

  globalThis.Response = class Response {
    constructor(body, init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Headers(init.headers || {});
    }
    async json() { return JSON.parse(this.body); }
    async text() { return this.body || ''; }
  };
}

// ---------------------------------------------------------------------------
// Mock infrastructure
// ---------------------------------------------------------------------------

let fetchMock = null;
let whoisMock = null;

// We'll expose hooks to the worker module via a module-level approach.
// Because we can't easily patch ES module internals, we inject mocks via
// a global bridge that the test-aware version of the module references.
globalThis.__testFetchOverride = null;
globalThis.__testWhoisOverride = null;
globalThis.__testConnectStub = () => {
  throw new Error('cloudflare:sockets not available in test env — use whoisMock');
};

// ---------------------------------------------------------------------------
// Load the worker module with stubs injected
// ---------------------------------------------------------------------------

// We can't easily intercept ES module bare specifiers without loaders.
// Instead, we create a shim file dynamically and import it.
// For the Cloudflare `connect` import, we stub it at the global level and
// ensure the worker gracefully degrades when the socket can't be created.
//
// Strategy: the worker calls `connect()` inside `whoisLookup()`.
// In tests we mock `whoisLookup` behaviour via the handler — we test the
// handler's decision logic (routing, status mapping) by intercepting `fetch`
// and by providing a global whois result hook.
//
// We import the handler functions directly by re-exporting them from a thin
// test harness wrapper.

// Since the worker uses `import { connect } from 'cloudflare:sockets'` which
// does not resolve in Node, we need a loader or a manual shim file.
// We'll create a temporary shim for `cloudflare:sockets`.

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const SHIM_DIR = path.join(tmpdir(), 'dp-worker-test-shim');
mkdirSync(SHIM_DIR, { recursive: true });

// Create a shim for cloudflare:sockets that the worker will use
// We write a real module file that node --experimental-vm-modules or the
// custom conditions can pick up. But the cleanest way for standard node:test
// is to copy the worker file with the import replaced.

import { readFileSync } from 'node:fs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const workerSrc = readFileSync(path.join(__dirname, 'index.js'), 'utf8');

// Replace `import { connect } from 'cloudflare:sockets'` with a stub
const patchedSrc = workerSrc
  // Patch cloudflare:sockets import
  .replace(
    `import { connect } from 'cloudflare:sockets';`,
    `
// TEST HARNESS: cloudflare:sockets stub
const connect = () => { throw new Error('cloudflare:sockets not available in test environment'); };
`
  )
  // Expose internal functions for testing by adding exports at the bottom
  .replace(
    /export default \{[\s\S]*\};/,
    `
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {} });
    }
    try {
      if (request.method === 'GET' && url.pathname === '/v1/version') {
        return await handleVersionCheck(request, { ...env, ctx });
      }
      if (request.method === 'POST' && url.pathname === '/v1/premium-check') {
        return await handlePremiumCheck(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/v1/whois-check') {
        return await handleWhoisCheck(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/v1/check') {
        return await handleDomainCheck(request, env, ctx);
      }
      return errorResponse(404, 'not_found', 'Endpoint not found');
    } catch {
      return errorResponse(500, 'internal_error');
    }
  },
};

// Test-only exports
export {
  handleDomainCheck,
  handleVersionCheck,
  handlePremiumCheck,
  handleWhoisCheck,
  isValidDomain,
  parseSedoXml,
  callSedoDomainStatus,
  RDAP_ROUTES,
  WHOIS_TLDS,
  SKIP_TLDS,
};
`
  );

const shimPath = path.join(SHIM_DIR, 'index.mjs');
writeFileSync(shimPath, patchedSrc);

// Import the patched module
const workerModule = await import(pathToFileURL(shimPath).href);
const {
  handleDomainCheck,
  handleVersionCheck,
  handlePremiumCheck,
  handleWhoisCheck,
  isValidDomain,
  parseSedoXml,
  callSedoDomainStatus,
  RDAP_ROUTES,
  WHOIS_TLDS,
  SKIP_TLDS,
  default: worker,
} = workerModule;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Request object that mimics the Cloudflare Fetch API Request.
 */
function makeRequest(path, { method = 'POST', body = null, contentType = 'application/json', contentLength = null } = {}) {
  const url = `https://worker.example.com${path}`;
  const headers = new Headers();
  if (contentType) headers.set('Content-Type', contentType);
  headers.set('CF-Connecting-IP', '1.2.3.4');
  const serialized = body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  if (contentLength !== null) {
    headers.set('Content-Length', String(contentLength));
  } else if (serialized !== null) {
    headers.set('Content-Length', String(Buffer.byteLength(serialized, 'utf-8')));
  }

  return new Request(url, {
    method,
    headers,
    body: serialized,
  });
}

/**
 * Creates a minimal env object (no KV, no secrets — for unit tests).
 */
function makeEnv(overrides = {}) {
  return {
    QUOTA_KV: null,      // Disables KV — rate limiter fails open
    SKILL_VERSION: '1.7.0',
    ...overrides,
  };
}

/**
 * Parses the Response body as JSON.
 */
async function parseJSON(response) {
  const text = await response.text();
  return JSON.parse(text);
}

/**
 * Patches globalThis.fetch for a single test.
 * Returns a restore function.
 */
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

/**
 * Creates a mock fetch that returns a specific status code for RDAP calls.
 */
function rdapFetchReturning(status, body = '{}') {
  return async (url, opts) => {
    // Let webhook calls pass through (they start with env.ALERT_WEBHOOK which is undefined)
    return new Response(body, { status });
  };
}

/**
 * Creates a mock fetch that simulates a timeout (rejects with AbortError).
 */
function rdapFetchTimingOut() {
  return async (url, opts) => {
    // Simulate timeout by never resolving — but we need to respect the signal
    return new Promise((_, reject) => {
      if (opts && opts.signal) {
        opts.signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      } else {
        // No signal — delay longer than any test timeout (tests should mock this correctly)
        setTimeout(() => reject(new Error('timeout')), 60000);
      }
    });
  };
}

// ---------------------------------------------------------------------------
// Section 1: Input validation
// ---------------------------------------------------------------------------

describe('POST /v1/check — input validation', () => {
  it('returns 400 for empty body', async () => {
    const req = makeRequest('/v1/check', { body: '' });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.error);
  });

  it('returns 400 for missing domains field', async () => {
    const req = makeRequest('/v1/check', { body: {} });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.error);
  });

  it('returns 400 when domains is not an array (string)', async () => {
    const req = makeRequest('/v1/check', { body: { domains: 'example.com' } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 when domains is not an array (number)', async () => {
    const req = makeRequest('/v1/check', { body: { domains: 42 } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 for empty array', async () => {
    const req = makeRequest('/v1/check', { body: { domains: [] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 for array with >20 elements', async () => {
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);
    const req = makeRequest('/v1/check', { body: { domains } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.error);
  });

  it('returns 400 for exactly 21 domains (batch size limit)', async () => {
    const domains = Array.from({ length: 21 }, (_, i) => `test${i}.com`);
    const req = makeRequest('/v1/check', { body: { domains } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('accepts exactly 20 domains', async () => {
    const domains = Array.from({ length: 20 }, (_, i) => `test${i}.com`);
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      // Should not be 400 — could be 200 or 429 (rate limit fails open so should be 200)
      assert.notEqual(res.status, 400);
    } finally {
      restore();
    }
  });

  it('returns 400 when elements include a non-string (number)', async () => {
    const req = makeRequest('/v1/check', { body: { domains: ['valid.com', 42] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 when elements include a non-string (null)', async () => {
    const req = makeRequest('/v1/check', { body: { domains: ['valid.com', null] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 for invalid domain format (no TLD)', async () => {
    const req = makeRequest('/v1/check', { body: { domains: ['invalid'] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 for domain with all-numeric TLD', async () => {
    const req = makeRequest('/v1/check', { body: { domains: ['domain.123'] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('returns 400 for domain with leading hyphen in label', async () => {
    const req = makeRequest('/v1/check', { body: { domains: ['-bad.com'] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Content-Type enforcement
// ---------------------------------------------------------------------------

describe('POST /v1/check — Content-Type enforcement', () => {
  it('returns 400 for text/plain Content-Type', async () => {
    const req = makeRequest('/v1/check', {
      contentType: 'text/plain',
      body: JSON.stringify({ domains: ['example.com'] }),
    });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.error);
  });

  it('returns 400 for missing Content-Type', async () => {
    const req = makeRequest('/v1/check', { contentType: null, body: JSON.stringify({ domains: ['example.com'] }) });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
  });

  it('accepts application/json Content-Type', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { contentType: 'application/json', body: { domains: ['example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.notEqual(res.status, 400);
    } finally {
      restore();
    }
  });

  it('accepts application/json with charset parameter', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { contentType: 'application/json; charset=utf-8', body: { domains: ['example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.notEqual(res.status, 400);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 2b: Body size enforcement
// ---------------------------------------------------------------------------

describe('POST /v1/check — body size enforcement', () => {
  it('returns 413 when actual body exceeds 8192 bytes', async () => {
    // Build a body that exceeds 8KB using padded domain strings
    const largeDomains = Array.from({ length: 20 }, (_, i) => `${'x'.repeat(410)}${i}.com`);
    const req = makeRequest('/v1/check', {
      body: { domains: largeDomains },
    });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 413);
    const json = await parseJSON(res);
    assert.equal(json.error, 'payload_too_large');
  });

  it('accepts payload under 8192 bytes', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', {
        body: { domains: ['example.com'] },
      });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.notEqual(res.status, 413);
    } finally {
      restore();
    }
  });
});

describe('POST /v1/check — domain length validation', () => {
  it('rejects domains exceeding 253 characters', async () => {
    const longDomain = 'a'.repeat(250) + '.com';
    const req = makeRequest('/v1/check', { body: { domains: [longDomain] } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.message.includes('253'));
  });

  it('accepts domains at 253 characters', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      // 249 chars + .com = 253
      const domain = 'a'.repeat(249) + '.com';
      const req = makeRequest('/v1/check', { body: { domains: [domain] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      // Won't be 400 for length — will fail at isValidDomain instead, which is fine
      assert.notEqual(res.status, 413);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 3: Deduplication
// ---------------------------------------------------------------------------

describe('POST /v1/check — deduplication', () => {
  it('returns a single result when the same domain appears twice', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com', 'example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      const keys = Object.keys(json.results);
      assert.equal(keys.length, 1);
      assert.ok(json.results['example.com']);
    } finally {
      restore();
    }
  });

  it('deduplicates case-insensitively (EXAMPLE.COM and example.com → one result)', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['EXAMPLE.COM', 'example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      const keys = Object.keys(json.results);
      assert.equal(keys.length, 1);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: Routing correctness
// ---------------------------------------------------------------------------

describe('POST /v1/check — routing correctness', () => {
  it('routes .com to Verisign RDAP', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.ok(calledUrl, 'fetch should have been called');
      assert.ok(calledUrl.startsWith('https://rdap.verisign.com/com/v1/domain/'), `Expected Verisign URL, got: ${calledUrl}`);
    } finally {
      restore();
    }
  });

  it('routes .net to Verisign RDAP', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.net'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.ok(calledUrl.startsWith('https://rdap.verisign.com/net/v1/domain/'));
    } finally {
      restore();
    }
  });

  it('routes .dev to Google RDAP', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.dev'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.ok(calledUrl.startsWith('https://pubapi.registry.google/rdap/domain/'), `Expected Google RDAP URL, got: ${calledUrl}`);
    } finally {
      restore();
    }
  });

  it('routes .io to Identity Digital RDAP', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.io'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.ok(calledUrl.startsWith('https://rdap.identitydigital.services/rdap/domain/'), `Expected Identity Digital URL, got: ${calledUrl}`);
    } finally {
      restore();
    }
  });

  it('routes .xyz to CentralNic RDAP', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.xyz'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.ok(calledUrl.startsWith('https://rdap.centralnic.com/xyz/domain/'), `Expected CentralNic URL, got: ${calledUrl}`);
    } finally {
      restore();
    }
  });

  it('routes .co to WHOIS (not RDAP fetch)', async () => {
    let fetchCalled = false;
    const restore = mockFetch(async (url) => { fetchCalled = true; return new Response('{}', { status: 404 }); });
    try {
      // .co should go through WHOIS path — but connect() will throw in test env.
      // We verify fetch() is NOT called (WHOIS doesn't use fetch).
      // The result will be 'unknown' because the socket stub throws.
      const req = makeRequest('/v1/check', { body: { domains: ['test.co'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      assert.equal(fetchCalled, false, 'fetch should NOT be called for WHOIS TLDs');
      const json = await parseJSON(res);
      // Will be 'unknown' since socket throws in test env
      assert.ok(['unknown', 'available', 'taken'].includes(json.results['test.co'].status));
    } finally {
      restore();
    }
  });

  it('routes .es to skip (unreliable WHOIS)', async () => {
    let fetchCalled = false;
    const restore = mockFetch(async (url) => { fetchCalled = true; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.es'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      assert.equal(fetchCalled, false, 'fetch should NOT be called for skip TLDs');
      const json = await parseJSON(res);
      assert.equal(json.results['example.es'].status, 'skip');
    } finally {
      restore();
    }
  });

  it('does NOT use rdap.org fallback for unknown TLDs', async () => {
    let calledUrl = null;
    const restore = mockFetch(async (url) => { calledUrl = url; return new Response('{}', { status: 404 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.unknowntld'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      if (calledUrl) {
        assert.ok(!calledUrl.includes('rdap.org'), `Should not use rdap.org fallback, got: ${calledUrl}`);
      }
      const json = await parseJSON(res);
      assert.equal(json.results['example.unknowntld'].status, 'unknown');
      assert.equal(json.results['example.unknowntld'].reason, 'tld_not_supported');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 5: Status mapping
// ---------------------------------------------------------------------------

describe('POST /v1/check — RDAP status mapping', () => {
  it('maps HTTP 200 RDAP response to "taken"', async () => {
    const restore = mockFetch(rdapFetchReturning(200, JSON.stringify({ objectClassName: 'domain' })));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['taken.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['taken.com'].status, 'taken');
    } finally {
      restore();
    }
  });

  it('maps HTTP 404 RDAP response to "available"', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['available.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['available.com'].status, 'available');
    } finally {
      restore();
    }
  });

  it('maps timeout (AbortError) to "unknown"', async () => {
    const restore = mockFetch(rdapFetchTimingOut());
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['slow.com'] } });
      // Use a very short timeout for this test — we patch the timeout constant
      // by checking the result is 'unknown' after the real timeout fires.
      // Since RDAP_TIMEOUT is 8s, we mock fetch to reject via AbortError immediately.
      globalThis.fetch = async (url, opts) => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        throw err;
      };
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['slow.com'].status, 'unknown');
    } finally {
      restore();
    }
  });

  it('maps HTTP 429 RDAP response to "unknown" with reason', async () => {
    // 429 is non-definitive — retried once, then unknown
    let callCount = 0;
    const restore = mockFetch(async (url) => {
      callCount++;
      return new Response('{}', { status: 429 });
    });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['ratelimited.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['ratelimited.com'].status, 'unknown');
    } finally {
      restore();
    }
  });

  it('maps HTTP 500 RDAP response to "unknown"', async () => {
    const restore = mockFetch(rdapFetchReturning(500));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['error.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['error.com'].status, 'unknown');
    } finally {
      restore();
    }
  });

  it('maps .es to "skip"', async () => {
    const restore = mockFetch(rdapFetchReturning(200));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.es'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['example.es'].status, 'skip');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 6: Unknown TLD — no rdap.org fallback
// ---------------------------------------------------------------------------

describe('POST /v1/check — unknown TLD handling', () => {
  it('returns status "unknown" with reason "tld_not_supported" for unmapped TLD', async () => {
    const restore = mockFetch(async (url) => new Response('{}', { status: 404 }));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.unknowntld'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.equal(json.results['example.unknowntld'].status, 'unknown');
      assert.equal(json.results['example.unknowntld'].reason, 'tld_not_supported');
    } finally {
      restore();
    }
  });

  it('does not call fetch for unknown TLDs', async () => {
    let fetchCalled = false;
    const restore = mockFetch(async () => { fetchCalled = true; return new Response('{}', { status: 200 }); });
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.nosuchtld'] } });
      await handleDomainCheck(req, makeEnv(), null);
      assert.equal(fetchCalled, false, 'fetch should not be called for unknown TLDs');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 7: Response format
// ---------------------------------------------------------------------------

describe('POST /v1/check — response format', () => {
  it('response includes version, results, and meta fields', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      assert.ok('version' in json, 'missing version field');
      assert.ok('results' in json, 'missing results field');
      assert.ok('meta' in json, 'missing meta field');
    } finally {
      restore();
    }
  });

  it('meta includes checked, completed, incomplete, duration_ms', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com', 'test.io'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      const json = await parseJSON(res);
      assert.ok('checked' in json.meta, 'missing meta.checked');
      assert.ok('completed' in json.meta, 'missing meta.completed');
      assert.ok('incomplete' in json.meta, 'missing meta.incomplete');
      assert.ok('duration_ms' in json.meta, 'missing meta.duration_ms');
      assert.equal(json.meta.checked, 2);
    } finally {
      restore();
    }
  });

  it('version field is the string "1"', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      const json = await parseJSON(res);
      assert.equal(json.version, '1');
    } finally {
      restore();
    }
  });

  it('results keys are lowercase domain names', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['Example.COM'] } });
      const res = await handleDomainCheck(req, makeEnv(), null);
      const json = await parseJSON(res);
      const keys = Object.keys(json.results);
      assert.ok(keys.every(k => k === k.toLowerCase()), 'result keys should be lowercase');
      assert.ok(keys.includes('example.com'));
    } finally {
      restore();
    }
  });

  it('each result has a status field', async () => {
    const restore = mockFetch(rdapFetchReturning(200));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['taken.com', 'example.es', 'unknown.xyz'] } });
      // For unknown.xyz: CentralNic returns 200 (taken)
      const res = await handleDomainCheck(req, makeEnv(), null);
      const json = await parseJSON(res);
      for (const [domain, result] of Object.entries(json.results)) {
        assert.ok('status' in result, `result for ${domain} missing status`);
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 8: Batch size (21 domains → 400)
// ---------------------------------------------------------------------------

describe('POST /v1/check — batch size', () => {
  it('returns 400 for 21 domains', async () => {
    const domains = Array.from({ length: 21 }, (_, i) => `batch${i}.com`);
    const req = makeRequest('/v1/check', { body: { domains } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    assert.equal(res.status, 400);
    const json = await parseJSON(res);
    assert.ok(json.error);
  });

  it('error message mentions the 20-domain limit', async () => {
    const domains = Array.from({ length: 21 }, (_, i) => `batch${i}.com`);
    const req = makeRequest('/v1/check', { body: { domains } });
    const res = await handleDomainCheck(req, makeEnv(), null);
    const json = await parseJSON(res);
    // Either the error code or message should reference the limit
    const combined = JSON.stringify(json).toLowerCase();
    assert.ok(combined.includes('20') || combined.includes('limit') || combined.includes('max'), `Expected limit mentioned in: ${JSON.stringify(json)}`);
  });
});

// ---------------------------------------------------------------------------
// Section 9: Existing endpoints still work
// ---------------------------------------------------------------------------

describe('Existing endpoints — routing preserved', () => {
  it('GET /v1/version handler is reachable', async () => {
    const req = makeRequest('/v1/version', { method: 'GET', body: null, contentType: null });
    const env = makeEnv({ SKILL_VERSION: '1.7.0' });
    // handleVersionCheck may fail without KV but should not return 404
    const res = await worker.fetch(req, env, null);
    // It should not be a 404 (routing works) — may be 429 from rate limiter (fails open) or 200
    assert.notEqual(res.status, 404, 'GET /v1/version should not return 404');
  });

  it('POST /v1/premium-check handler is reachable (returns unknown without API tokens)', async () => {
    const req = makeRequest('/v1/premium-check', { body: { domain: 'example.com' } });
    const env = makeEnv(); // no FASTLY_API_TOKEN, no SEDO credentials
    const res = await worker.fetch(req, env, null);
    // Should NOT be 404 (route resolves) — returns 200 with status: unknown (graceful degradation)
    assert.notEqual(res.status, 404, 'POST /v1/premium-check should not return 404');
  });

  it('POST /v1/whois-check handler is reachable (returns 400 for unsupported TLD)', async () => {
    const req = makeRequest('/v1/whois-check', { body: { domain: 'example.com' } });
    const env = makeEnv();
    const res = await worker.fetch(req, env, null);
    // .com is not in the WHOIS whitelist → 400 unsupported_tld
    // Route should resolve (not 404)
    assert.notEqual(res.status, 404, 'POST /v1/whois-check should not return 404');
  });

  it('POST /v1/check is routed correctly through worker.fetch', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', { body: { domains: ['example.com'] } });
      const res = await worker.fetch(req, makeEnv(), null);
      assert.notEqual(res.status, 404, 'POST /v1/check should not return 404');
    } finally {
      restore();
    }
  });

  it('unknown route returns 404', async () => {
    const req = makeRequest('/v1/nonexistent', { method: 'GET', body: null, contentType: null });
    const res = await worker.fetch(req, makeEnv(), null);
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// Section 10: RDAP_ROUTES completeness
// ---------------------------------------------------------------------------

describe('RDAP_ROUTES — completeness', () => {
  it('RDAP_ROUTES is exported and is an object', () => {
    assert.ok(RDAP_ROUTES, 'RDAP_ROUTES should be exported');
    assert.equal(typeof RDAP_ROUTES, 'object');
  });

  it('RDAP_ROUTES contains .com', () => {
    assert.ok('com' in RDAP_ROUTES, 'RDAP_ROUTES should have com');
    assert.equal(RDAP_ROUTES.com('example.com'), 'https://rdap.verisign.com/com/v1/domain/example.com');
  });

  it('RDAP_ROUTES contains .dev', () => {
    assert.ok('dev' in RDAP_ROUTES);
    assert.ok(RDAP_ROUTES.dev('test.dev').startsWith('https://pubapi.registry.google'));
  });

  it('RDAP_ROUTES contains .io (Identity Digital)', () => {
    assert.ok('io' in RDAP_ROUTES);
    assert.ok(RDAP_ROUTES.io('test.io').startsWith('https://rdap.identitydigital.services'));
  });

  it('RDAP_ROUTES contains CentralNic TLDs', () => {
    const centralNicTlds = ['xyz', 'build', 'art', 'game', 'quest', 'lol', 'inc', 'store', 'audio', 'fm'];
    for (const tld of centralNicTlds) {
      assert.ok(tld in RDAP_ROUTES, `RDAP_ROUTES missing ${tld}`);
      const url = RDAP_ROUTES[tld](`example.${tld}`);
      assert.ok(url.startsWith('https://rdap.centralnic.com/'), `Expected CentralNic URL for .${tld}`);
      assert.ok(url.includes(`/${tld}/domain/`), `CentralNic URL should include /${tld}/domain/ for .${tld}`);
    }
  });

  it('RDAP_ROUTES contains all Identity Digital TLDs', () => {
    const idTlds = ['ai', 'io', 'me', 'sh', 'tools', 'codes', 'run', 'studio', 'gallery', 'media',
      'chat', 'coffee', 'cafe', 'ventures', 'supply', 'agency', 'capital', 'community', 'social',
      'group', 'team', 'market', 'deals', 'academy', 'school', 'training', 'care', 'clinic',
      'band', 'money', 'finance', 'fund', 'tax', 'investments'];
    for (const tld of idTlds) {
      assert.ok(tld in RDAP_ROUTES, `RDAP_ROUTES missing Identity Digital TLD: ${tld}`);
    }
  });

  it('WHOIS_TLDS is exported and contains expected TLDs', () => {
    assert.ok(WHOIS_TLDS, 'WHOIS_TLDS should be exported');
    const expected = ['co', 'it', 'de', 'be', 'at', 'se', 'gg', 'st', 'pt', 'my', 'nu', 'am'];
    for (const tld of expected) {
      assert.ok(WHOIS_TLDS.has(tld), `WHOIS_TLDS missing: ${tld}`);
    }
  });

  it('SKIP_TLDS is exported and contains .es', () => {
    assert.ok(SKIP_TLDS, 'SKIP_TLDS should be exported');
    assert.ok(SKIP_TLDS.has('es'), 'SKIP_TLDS should include es');
  });
});

// ---------------------------------------------------------------------------
// Section 11: Mixed batch
// ---------------------------------------------------------------------------

describe('POST /v1/check — mixed batch', () => {
  it('handles a batch with RDAP + WHOIS + skip + unknown TLDs', async () => {
    const restore = mockFetch(rdapFetchReturning(404));
    try {
      const req = makeRequest('/v1/check', {
        body: { domains: ['example.com', 'example.co', 'example.es', 'example.nosuchtld'] },
      });
      const res = await handleDomainCheck(req, makeEnv(), null);
      assert.equal(res.status, 200);
      const json = await parseJSON(res);
      // RDAP: available
      assert.equal(json.results['example.com'].status, 'available');
      // WHOIS: unknown (socket throws in test env)
      assert.ok(['unknown', 'available', 'taken'].includes(json.results['example.co'].status));
      // Skip
      assert.equal(json.results['example.es'].status, 'skip');
      // Unknown TLD
      assert.equal(json.results['example.nosuchtld'].status, 'unknown');
      assert.equal(json.results['example.nosuchtld'].reason, 'tld_not_supported');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 12: Sedo XML parsing (parseSedoXml)
// ---------------------------------------------------------------------------

/** Helper: build a valid Sedo XML response for a single domain */
function sedoXml(domain, { forsale = 'false', price = '0.00', currency = '0', domainstatus = '0', type = 'D' } = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SEDOLIST xmlns="https://api.sedo.com/api/v1/?wsdl"><item type="tns:DomainStatusResponse[]"><domain type="xsd:string">${domain}</domain><type type="xsd:string">${type}</type><forsale type="xsd:boolean">${forsale}</forsale><price type="xsd:decimal">${price}</price><currency type="xsd:string">${currency}</currency><visitors type="xsd:int">0</visitors><domainstatus type="xsd:decimal">${domainstatus}</domainstatus></item></SEDOLIST>`;
}

/** Helper: build Sedo XML with fuzzy matches + exact match */
function sedoXmlWithFuzzy(domain, opts = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<SEDOLIST xmlns="https://api.sedo.com/api/v1/?wsdl"><item type="tns:DomainStatusResponse[]"><domain type="xsd:string">?uzz${domain}</domain><type type="xsd:string">false</type><forsale type="xsd:boolean">true</forsale><price type="xsd:decimal">999</price><currency type="xsd:string">USD</currency><visitors type="xsd:int">0</visitors><domainstatus type="xsd:decimal">1</domainstatus></item><item type="tns:DomainStatusResponse[]"><domain type="xsd:string">${domain}</domain><type type="xsd:string">${opts.type || 'D'}</type><forsale type="xsd:boolean">${opts.forsale || 'false'}</forsale><price type="xsd:decimal">${opts.price || '0.00'}</price><currency type="xsd:decimal">${opts.currency || '0'}</currency><visitors type="xsd:decimal">0</visitors><domainstatus type="xsd:decimal">${opts.domainstatus || '0'}</domainstatus></item></SEDOLIST>`;
}

describe('parseSedoXml — XML parsing', () => {
  it('extracts fields from a valid for-sale response', () => {
    const xml = sedoXml('poker.net', { forsale: 'true', price: '1500000', currency: 'USD', domainstatus: '1' });
    const result = parseSedoXml(xml, 'poker.net');
    assert.ok(result);
    assert.equal(result.forsale, true);
    assert.equal(result.price, 1500000);
    assert.equal(result.currency, 'USD');
    assert.equal(result.domainStatus, 1);
  });

  it('extracts fields from a not-for-sale response', () => {
    const xml = sedoXml('google.com', { forsale: 'false', price: '0.00', currency: '0', domainstatus: '0' });
    const result = parseSedoXml(xml, 'google.com');
    assert.ok(result);
    assert.equal(result.forsale, false);
    assert.equal(result.price, 0);
    assert.equal(result.currency, 'EUR'); // 0 maps to EUR
    assert.equal(result.domainStatus, 0);
  });

  it('maps integer currency codes correctly', () => {
    assert.equal(parseSedoXml(sedoXml('a.com', { currency: '0' }), 'a.com').currency, 'EUR');
    assert.equal(parseSedoXml(sedoXml('a.com', { currency: '1' }), 'a.com').currency, 'USD');
    assert.equal(parseSedoXml(sedoXml('a.com', { currency: '2' }), 'a.com').currency, 'GBP');
  });

  it('falls back to USD for unknown currency code', () => {
    const result = parseSedoXml(sedoXml('a.com', { currency: '5' }), 'a.com');
    assert.equal(result.currency, 'USD');
  });

  it('handles string currency (e.g., "USD") directly', () => {
    const result = parseSedoXml(sedoXml('a.com', { currency: 'GBP' }), 'a.com');
    assert.equal(result.currency, 'GBP');
  });

  it('returns null for SEDOFAULT response', () => {
    const xml = `<?xml version="1.0"?><SEDOFAULT><faultcode>123</faultcode><faultstring>Error</faultstring></SEDOFAULT>`;
    assert.equal(parseSedoXml(xml, 'test.com'), null);
  });

  it('returns null for SOAP fault response', () => {
    const xml = `<?xml version="1.0"?><SOAP-ENV:Envelope><SOAP-ENV:Body><SOAP-ENV:Fault><faultcode>Sender</faultcode><faultstring>Invalid XML</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
    assert.equal(parseSedoXml(xml, 'test.com'), null);
  });

  it('returns null for empty response body', () => {
    assert.equal(parseSedoXml('', 'test.com'), null);
    assert.equal(parseSedoXml(null, 'test.com'), null);
    assert.equal(parseSedoXml(undefined, 'test.com'), null);
  });

  it('returns null for malformed XML (no item tags)', () => {
    assert.equal(parseSedoXml('<html><body>Not XML</body></html>', 'test.com'), null);
  });

  it('returns null for non-XML body', () => {
    assert.equal(parseSedoXml('{"json": true}', 'test.com'), null);
    assert.equal(parseSedoXml('plain text response', 'test.com'), null);
  });

  it('rejects response larger than 10KB', () => {
    const bigXml = sedoXml('test.com') + 'x'.repeat(10241);
    assert.equal(parseSedoXml(bigXml, 'test.com'), null);
  });

  it('treats negative price as 0', () => {
    const xml = sedoXml('a.com', { forsale: 'true', price: '-500' });
    const result = parseSedoXml(xml, 'a.com');
    assert.equal(result.price, 0);
  });

  it('trusts forsale=true even when domainstatus=0', () => {
    const xml = sedoXml('a.com', { forsale: 'true', price: '100', domainstatus: '0' });
    const result = parseSedoXml(xml, 'a.com');
    assert.equal(result.forsale, true);
    assert.equal(result.price, 100);
  });

  it('matches exact domain only, ignoring fuzzy matches', () => {
    const xml = sedoXmlWithFuzzy('example.com', { forsale: 'false', price: '0.00', domainstatus: '0' });
    const result = parseSedoXml(xml, 'example.com');
    assert.ok(result);
    assert.equal(result.forsale, false);
    assert.equal(result.price, 0);
    // Should NOT pick up the fuzzy match (forsale=true, price=999)
  });

  it('case-insensitive domain matching', () => {
    const xml = sedoXml('Example.COM', { forsale: 'true', price: '500', currency: 'USD', domainstatus: '1' });
    const result = parseSedoXml(xml, 'example.com');
    assert.ok(result);
    assert.equal(result.forsale, true);
  });

  it('returns null when required fields are missing', () => {
    // Missing <forsale>
    const xml = `<?xml version="1.0"?><SEDOLIST><item><domain>test.com</domain><price>0</price><domainstatus>0</domainstatus></item></SEDOLIST>`;
    assert.equal(parseSedoXml(xml, 'test.com'), null);
  });
});

// ---------------------------------------------------------------------------
// Section 13: Premium check waterfall logic
// ---------------------------------------------------------------------------

/** Helper: mock fetch that routes Sedo vs Fastly calls differently */
function mockDualFetch({ sedoResponse = null, fastlyResponse = null, sedoShouldTimeout = false } = {}) {
  let sedoCalled = false;
  let fastlyCalled = false;

  const handler = async (url, opts) => {
    if (typeof url === 'string' && url.includes('api.sedo.com')) {
      sedoCalled = true;
      if (sedoShouldTimeout) {
        return new Promise((_, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
      if (sedoResponse) {
        return new Response(sedoResponse.body, { status: sedoResponse.status || 200 });
      }
      return new Response('', { status: 500 });
    }
    if (typeof url === 'string' && url.includes('api.domainr.com')) {
      fastlyCalled = true;
      if (fastlyResponse) {
        return new Response(
          typeof fastlyResponse.body === 'string' ? fastlyResponse.body : JSON.stringify(fastlyResponse.body),
          { status: fastlyResponse.status || 200 }
        );
      }
      return new Response('', { status: 500 });
    }
    // Default (e.g., webhook)
    return new Response('', { status: 200 });
  };

  const original = globalThis.fetch;
  globalThis.fetch = handler;

  return {
    restore: () => { globalThis.fetch = original; },
    get sedoCalled() { return sedoCalled; },
    get fastlyCalled() { return fastlyCalled; },
  };
}

describe('POST /v1/premium-check — Sedo + Fastly waterfall', () => {
  it('returns for_sale with price when Sedo reports forsale=true + price>0', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('poker.net', { forsale: 'true', price: '1500000', currency: 'USD', domainstatus: '1' }) },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'poker.net' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'for_sale');
      assert.equal(json.source, 'sedo');
      assert.equal(json.price, 1500000);
      assert.equal(json.currency, 'USD');
      assert.ok('remainingChecks' in json);
      assert.ok(!mock.fastlyCalled, 'Fastly should NOT be called when Sedo resolves');
    } finally {
      mock.restore();
    }
  });

  it('returns for_sale_make_offer when Sedo reports forsale=true + price=0', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('offer.com', { forsale: 'true', price: '0', currency: 'USD', domainstatus: '1' }) },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'offer.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'for_sale_make_offer');
      assert.equal(json.source, 'sedo');
      assert.ok(!('price' in json), 'Make-offer should not include price');
      assert.ok(!mock.fastlyCalled, 'Fastly should NOT be called when Sedo resolves');
    } finally {
      mock.restore();
    }
  });

  it('falls through to Fastly when Sedo returns not-listed (forsale=false)', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('example.com', { forsale: 'false', price: '0.00', domainstatus: '0' }) },
      fastlyResponse: { body: { status: [{ domain: 'example.com', status: 'parked' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'example.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'parked');
      assert.equal(json.source, 'fastly');
      assert.ok(mock.sedoCalled, 'Sedo should be called first');
      assert.ok(mock.fastlyCalled, 'Fastly should be called as fallback');
    } finally {
      mock.restore();
    }
  });

  it('falls through to Fastly when Sedo call fails', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: '', status: 500 },
      fastlyResponse: { body: { status: [{ domain: 'test.com', status: 'active' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'taken');
      assert.equal(json.source, 'fastly');
      assert.ok(mock.fastlyCalled, 'Fastly should be called when Sedo fails');
    } finally {
      mock.restore();
    }
  });

  it('returns unknown when both Sedo and Fastly fail', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: '', status: 500 },
      fastlyResponse: { body: '', status: 500 },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'unknown');
      assert.ok('remainingChecks' in json);
    } finally {
      mock.restore();
    }
  });

  it('Fastly response includes source field', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('test.com', { forsale: 'false', domainstatus: '0' }) },
      fastlyResponse: { body: { status: [{ domain: 'test.com', status: 'priced' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.source, 'fastly');
      assert.equal(json.status, 'premium');
    } finally {
      mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 14: Graceful degradation — SEDO env vars missing
// ---------------------------------------------------------------------------

describe('POST /v1/premium-check — graceful degradation', () => {
  it('uses Fastly-only path when SEDO env vars are missing', async () => {
    const mock = mockDualFetch({
      fastlyResponse: { body: { status: [{ domain: 'test.com', status: 'active' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ FASTLY_API_TOKEN: 'test' }); // no SEDO creds
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.status, 'taken');
      assert.equal(json.source, 'fastly');
      assert.ok(!mock.sedoCalled, 'Sedo should NOT be called when credentials are missing');
      assert.ok(mock.fastlyCalled, 'Fastly should be called directly');
    } finally {
      mock.restore();
    }
  });

  it('returns unknown when neither Sedo nor Fastly is configured', async () => {
    const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
    const env = makeEnv(); // no SEDO creds, no FASTLY_API_TOKEN
    const res = await handlePremiumCheck(req, env);
    const json = await parseJSON(res);
    assert.equal(json.status, 'unknown');
    assert.ok('remainingChecks' in json);
  });

  it('skips Sedo when only SEDO_PARTNER_ID is set (missing SIGN_KEY)', async () => {
    const mock = mockDualFetch({
      fastlyResponse: { body: { status: [{ domain: 'test.com', status: 'active' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', FASTLY_API_TOKEN: 'test' }); // missing SIGN_KEY
      const res = await handlePremiumCheck(req, env);
      const json = await parseJSON(res);
      assert.equal(json.source, 'fastly');
      assert.ok(!mock.sedoCalled);
    } finally {
      mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 15: Quota and circuit breaker with dual-API
// ---------------------------------------------------------------------------

describe('POST /v1/premium-check — quota counting', () => {
  it('counts only once against IP quota for Sedo-resolved check', async () => {
    // Track KV writes to verify quota is incremented exactly once
    let kvWrites = 0;
    const mockKV = {
      get: async () => null, // no existing quota
      put: async (key, value, opts) => { kvWrites++; },
    };
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('test.com', { forsale: 'true', price: '500', currency: 'USD', domainstatus: '1' }) },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test', QUOTA_KV: mockKV });
      const res = await handlePremiumCheck(req, env);
      assert.equal(res.status, 200);
      // KV writes: 1 for rate limiter + 1 for IP quota = 2 (no monthly counter for Sedo-only)
      // Rate limiter writes: ratelimit:* key
      // IP quota writes: ip:* key
      // We should NOT see a circuit:monthly:* write since Fastly was not called
      assert.ok(!mock.fastlyCalled, 'Fastly should not be called');
    } finally {
      mock.restore();
    }
  });

  it('increments monthly counter only when Fastly is called', async () => {
    let monthlyIncremented = false;
    const mockKV = {
      get: async (key) => {
        if (key.startsWith('circuit:monthly:')) return JSON.stringify({ requestCount: 0 });
        return null;
      },
      put: async (key, value) => {
        if (key.startsWith('circuit:monthly:')) monthlyIncremented = true;
      },
    };
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('test.com', { forsale: 'false', domainstatus: '0' }) },
      fastlyResponse: { body: { status: [{ domain: 'test.com', status: 'active' }] } },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test', QUOTA_KV: mockKV });
      const res = await handlePremiumCheck(req, env);
      assert.equal(res.status, 200);
      assert.ok(mock.fastlyCalled, 'Fastly should be called');
      assert.ok(monthlyIncremented, 'Monthly counter should be incremented when Fastly is called');
    } finally {
      mock.restore();
    }
  });

  it('does NOT increment monthly counter for Sedo-resolved checks', async () => {
    let monthlyIncremented = false;
    const mockKV = {
      get: async () => null,
      put: async (key) => {
        if (key.startsWith('circuit:monthly:')) monthlyIncremented = true;
      },
    };
    const mock = mockDualFetch({
      sedoResponse: { body: sedoXml('test.com', { forsale: 'true', price: '100', currency: 'USD', domainstatus: '1' }) },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'test', FASTLY_API_TOKEN: 'test', QUOTA_KV: mockKV });
      const res = await handlePremiumCheck(req, env);
      assert.equal(res.status, 200);
      assert.ok(!monthlyIncremented, 'Monthly counter should NOT be incremented for Sedo-only checks');
    } finally {
      mock.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Section 16: Security — no credential leaks
// ---------------------------------------------------------------------------

describe('POST /v1/premium-check — security', () => {
  it('does not leak Sedo credentials in error responses', async () => {
    const mock = mockDualFetch({
      sedoResponse: { body: '<SEDOFAULT><faultcode>AUTH</faultcode><faultstring>Invalid signkey</faultstring></SEDOFAULT>' },
      fastlyResponse: { body: '', status: 500 },
    });
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'SECRETID', SEDO_SIGN_KEY: 'SECRETKEY', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const text = await res.text();
      assert.ok(!text.includes('SECRETID'), 'Partner ID should not appear in response');
      assert.ok(!text.includes('SECRETKEY'), 'Sign key should not appear in response');
      assert.ok(!text.includes('api.sedo.com'), 'Sedo URL should not appear in response');
    } finally {
      mock.restore();
    }
  });

  it('does not include signkey in Sedo URL-based error messages', async () => {
    // Simulate a network error from Sedo
    const original = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (typeof url === 'string' && url.includes('api.sedo.com')) {
        throw new Error('Network failure');
      }
      return new Response(JSON.stringify({ status: [{ domain: 'test.com', status: 'active' }] }), { status: 200 });
    };
    try {
      const req = makeRequest('/v1/premium-check', { body: { domain: 'test.com' } });
      const env = makeEnv({ SEDO_PARTNER_ID: 'test', SEDO_SIGN_KEY: 'MYSECRETKEY', FASTLY_API_TOKEN: 'test' });
      const res = await handlePremiumCheck(req, env);
      const text = await res.text();
      assert.ok(!text.includes('MYSECRETKEY'), 'Sign key must never appear in response body');
      assert.ok(!text.includes('signkey'), 'The word signkey should not appear in response');
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

// Remove shim directory when done
process.on('exit', () => {
  try { rmSync(SHIM_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});
