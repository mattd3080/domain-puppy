/**
 * Domain Puppy MCP — handler unit tests
 *
 * Tests the handler functions directly (no MCP SDK initialization needed).
 * Mocks globalThis.fetch before each test and restores it after.
 */

import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { handleCheck, handlePremiumCheck } from "./handlers.js";

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

let originalFetch;

before(() => {
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Sets globalThis.fetch to a mock for the duration of a test.
 * Call the returned restore() in afterEach or the test's finally block.
 */
function mockFetch(handler) {
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

/**
 * Creates a fake Response-like object that json() resolves to the given data.
 */
function fakeResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// check — happy path
// ---------------------------------------------------------------------------

describe("handleCheck — valid input", () => {
  it("returns results when worker responds successfully", async () => {
    const workerPayload = {
      version: "1",
      results: { "example.com": { status: "available" } },
      meta: { checked: 1, completed: 1, incomplete: 0, duration_ms: 42 },
    };

    const restore = mockFetch(async () => fakeResponse(workerPayload));
    try {
      const result = await handleCheck({ domains: ["example.com"] });
      assert.ok(!result.isError, "should not be an error");
      assert.ok(Array.isArray(result.content), "content should be an array");
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.version, "1");
      assert.ok(parsed.results["example.com"]);
      assert.equal(parsed.results["example.com"].status, "available");
      assert.ok(parsed.meta);
    } finally {
      restore();
    }
  });

  it("forwards all domains to the worker", async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return fakeResponse({
        version: "1",
        results: {
          "foo.com": { status: "available" },
          "bar.io": { status: "taken" },
        },
        meta: { checked: 2, completed: 2, incomplete: 0, duration_ms: 10 },
      });
    });
    try {
      await handleCheck({ domains: ["foo.com", "bar.io"] });
      assert.deepEqual(capturedBody.domains, ["foo.com", "bar.io"]);
    } finally {
      restore();
    }
  });

  it("POSTs to the correct worker URL", async () => {
    let calledUrl;
    const restore = mockFetch(async (url) => {
      calledUrl = url;
      return fakeResponse({ version: "1", results: {}, meta: {} });
    });
    try {
      await handleCheck({ domains: ["example.com"] });
      assert.equal(
        calledUrl,
        "https://domain-puppy-proxy.mattjdalley.workers.dev/v1/check"
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// check — input validation errors
// ---------------------------------------------------------------------------

describe("handleCheck — input validation", () => {
  it("returns error for empty array", async () => {
    const result = await handleCheck({ domains: [] });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });

  it("returns error when domains is missing", async () => {
    const result = await handleCheck({});
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });

  it("returns error for more than 20 domains", async () => {
    const domains = Array.from({ length: 21 }, (_, i) => `domain${i}.com`);
    const result = await handleCheck({ domains });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
    assert.ok(
      JSON.stringify(parsed).includes("20") ||
        parsed.message.includes("exceed"),
      "error should mention the 20-domain limit"
    );
  });

  it("returns error when an element is not a string (number)", async () => {
    const result = await handleCheck({ domains: ["valid.com", 42] });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });

  it("returns error when an element is not a string (null)", async () => {
    const result = await handleCheck({ domains: ["valid.com", null] });
    assert.equal(result.isError, true);
  });

  it("returns error when an element is an empty string", async () => {
    const result = await handleCheck({ domains: ["valid.com", ""] });
    assert.equal(result.isError, true);
  });

  it("does not call fetch for invalid inputs", async () => {
    let fetchCalled = false;
    const restore = mockFetch(async () => {
      fetchCalled = true;
      return fakeResponse({});
    });
    try {
      await handleCheck({ domains: [] });
      assert.equal(fetchCalled, false, "fetch should not be called for invalid input");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// check — worker errors
// ---------------------------------------------------------------------------

describe("handleCheck — worker error handling", () => {
  it("returns worker_unavailable error when fetch throws", async () => {
    const restore = mockFetch(async () => {
      throw new Error("Network unreachable");
    });
    try {
      const result = await handleCheck({ domains: ["example.com"] });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error, "worker_unavailable");
      assert.ok(parsed.message);
    } finally {
      restore();
    }
  });

  it("returns worker_unavailable when fetch is rejected with AbortError (timeout)", async () => {
    const restore = mockFetch(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    try {
      const result = await handleCheck({ domains: ["example.com"] });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error, "worker_unavailable");
      assert.ok(parsed.message.toLowerCase().includes("timeout") || parsed.message.length > 0);
    } finally {
      restore();
    }
  });

  it("returns error with status code when worker returns non-200", async () => {
    const restore = mockFetch(async () => fakeResponse({ error: "rate_limited" }, 429));
    try {
      const result = await handleCheck({ domains: ["example.com"] });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.error);
      assert.ok(
        parsed.status === 429 || JSON.stringify(parsed).includes("429"),
        "error response should mention HTTP 429"
      );
    } finally {
      restore();
    }
  });

  it("returns error with status code when worker returns 500", async () => {
    const restore = mockFetch(async () =>
      fakeResponse({ error: "internal_error" }, 500)
    );
    try {
      const result = await handleCheck({ domains: ["example.com"] });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(
        parsed.status === 500 || JSON.stringify(parsed).includes("500"),
        "error response should mention HTTP 500"
      );
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// premium_check — happy path
// ---------------------------------------------------------------------------

describe("handlePremiumCheck — valid input", () => {
  it("returns status and remainingChecks when worker responds successfully", async () => {
    const workerPayload = { status: "available", remainingChecks: 4 };
    const restore = mockFetch(async () => fakeResponse(workerPayload));
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      assert.ok(!result.isError, "should not be an error");
      assert.equal(result.content.length, 1);
      assert.equal(result.content[0].type, "text");

      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.status, "available");
      assert.equal(parsed.remainingChecks, 4);
    } finally {
      restore();
    }
  });

  it("returns quota_exceeded error body from worker (non-error response passthrough)", async () => {
    // Worker returns quota_exceeded with 429, which is a non-200 — but we test
    // what happens when worker returns 200 with error body (passthrough scenario)
    const workerPayload = { error: "quota_exceeded", remainingChecks: 0 };
    const restore = mockFetch(async () => fakeResponse(workerPayload, 200));
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      // The handler passes through the response body as-is for 2xx
      assert.ok(!result.isError);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error, "quota_exceeded");
      assert.equal(parsed.remainingChecks, 0);
    } finally {
      restore();
    }
  });

  it("POSTs to the correct worker URL", async () => {
    let calledUrl;
    const restore = mockFetch(async (url) => {
      calledUrl = url;
      return fakeResponse({ status: "available", remainingChecks: 3 });
    });
    try {
      await handlePremiumCheck({ domain: "example.com" });
      assert.equal(
        calledUrl,
        "https://domain-puppy-proxy.mattjdalley.workers.dev/v1/premium-check"
      );
    } finally {
      restore();
    }
  });

  it("forwards the domain in the request body", async () => {
    let capturedBody;
    const restore = mockFetch(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return fakeResponse({ status: "taken", remainingChecks: 2 });
    });
    try {
      await handlePremiumCheck({ domain: "example.com" });
      assert.equal(capturedBody.domain, "example.com");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// premium_check — input validation errors
// ---------------------------------------------------------------------------

describe("handlePremiumCheck — input validation", () => {
  it("returns error when domain is missing", async () => {
    const result = await handlePremiumCheck({});
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });

  it("returns error when domain is an empty string", async () => {
    const result = await handlePremiumCheck({ domain: "" });
    assert.equal(result.isError, true);
    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.error);
  });

  it("returns error when domain is not a string (number)", async () => {
    const result = await handlePremiumCheck({ domain: 42 });
    assert.equal(result.isError, true);
  });

  it("returns error when domain is null", async () => {
    const result = await handlePremiumCheck({ domain: null });
    assert.equal(result.isError, true);
  });

  it("does not call fetch for invalid inputs", async () => {
    let fetchCalled = false;
    const restore = mockFetch(async () => {
      fetchCalled = true;
      return fakeResponse({});
    });
    try {
      await handlePremiumCheck({ domain: "" });
      assert.equal(fetchCalled, false, "fetch should not be called for invalid input");
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// premium_check — worker errors
// ---------------------------------------------------------------------------

describe("handlePremiumCheck — worker error handling", () => {
  it("returns worker_unavailable error when fetch throws", async () => {
    const restore = mockFetch(async () => {
      throw new Error("Network unreachable");
    });
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error, "worker_unavailable");
      assert.ok(parsed.message);
    } finally {
      restore();
    }
  });

  it("returns worker_unavailable when fetch is rejected with AbortError (timeout)", async () => {
    const restore = mockFetch(async () => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      throw err;
    });
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.equal(parsed.error, "worker_unavailable");
    } finally {
      restore();
    }
  });

  it("returns error with status code when worker returns non-200 (429)", async () => {
    const restore = mockFetch(async () =>
      fakeResponse({ error: "quota_exceeded", remainingChecks: 0 }, 429)
    );
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(parsed.error);
      assert.ok(
        parsed.status === 429 || JSON.stringify(parsed).includes("429"),
        "error response should mention HTTP 429"
      );
    } finally {
      restore();
    }
  });

  it("returns error with status code when worker returns 503", async () => {
    const restore = mockFetch(async () =>
      fakeResponse({ error: "service_unavailable" }, 503)
    );
    try {
      const result = await handlePremiumCheck({ domain: "example.com" });
      assert.equal(result.isError, true);
      const parsed = JSON.parse(result.content[0].text);
      assert.ok(
        parsed.status === 503 || JSON.stringify(parsed).includes("503"),
        "error response should mention HTTP 503"
      );
    } finally {
      restore();
    }
  });
});
