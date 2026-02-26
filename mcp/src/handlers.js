/**
 * Domain Puppy MCP — handler functions
 *
 * Pure functions that take validated args, call the Cloudflare Worker,
 * and return MCP-protocol response objects.
 *
 * Privacy: domain names are never logged.
 */

const WORKER_BASE = "https://domain-puppy-proxy.mattjdalley.workers.dev";

// ---------------------------------------------------------------------------
// check handler
// ---------------------------------------------------------------------------

/**
 * Handles the `check` tool.
 *
 * Validates input, POSTs to /v1/check, returns MCP content.
 *
 * @param {{ domains: unknown }} args
 * @returns {Promise<{ content: Array<{type: string, text: string}>, isError?: boolean }>}
 */
export async function handleCheck(args) {
  const { domains } = args;

  // Input validation
  if (!domains || !Array.isArray(domains) || domains.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "invalid_input",
            message: "domains must be a non-empty array",
          }),
        },
      ],
    };
  }

  if (domains.length > 20) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "invalid_input",
            message: "domains array must not exceed 20 elements",
          }),
        },
      ],
    };
  }

  for (const item of domains) {
    if (typeof item !== "string" || item.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "invalid_input",
              message: "each element in domains must be a non-empty string",
            }),
          },
        ],
      };
    }
  }

  // Call the worker
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${WORKER_BASE}/v1/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domains }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "worker_error",
              message: `Worker returned HTTP ${response.status}`,
              status: response.status,
              body: text,
            }),
          },
        ],
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "worker_unavailable",
            message: err.name === "AbortError"
              ? "Request timed out after 30 seconds"
              : "Worker is unreachable",
          }),
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// premium_check handler
// ---------------------------------------------------------------------------

/**
 * Handles the `premium_check` tool.
 *
 * Validates input, POSTs to /v1/premium-check, returns MCP content.
 *
 * @param {{ domain: unknown }} args
 * @returns {Promise<{ content: Array<{type: string, text: string}>, isError?: boolean }>}
 */
export async function handlePremiumCheck(args) {
  const { domain } = args;

  // Input validation
  if (!domain || typeof domain !== "string" || domain.length === 0) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "invalid_input",
            message: "domain must be a non-empty string",
          }),
        },
      ],
    };
  }

  // Call the worker
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${WORKER_BASE}/v1/premium-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              error: "worker_error",
              message: `Worker returned HTTP ${response.status}`,
              status: response.status,
              body: text,
            }),
          },
        ],
      };
    }

    const data = await response.json();
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(data),
        },
      ],
    };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "worker_unavailable",
            message: err.name === "AbortError"
              ? "Request timed out after 15 seconds"
              : "Worker is unreachable",
          }),
        },
      ],
    };
  } finally {
    clearTimeout(timer);
  }
}
