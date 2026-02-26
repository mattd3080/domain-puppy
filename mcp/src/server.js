/**
 * Domain Puppy MCP Server
 *
 * Thin stdio-based MCP server that wraps the Cloudflare Worker endpoints.
 * Exposes 2 tools: `check` and `premium_check`.
 *
 * Privacy: domain names are never logged.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { handleCheck, handlePremiumCheck } from "./handlers.js";

const server = new McpServer({
  name: "domain-puppy",
  version: "1.9.0",
});

// ---------------------------------------------------------------------------
// Tool: check
// ---------------------------------------------------------------------------

server.tool(
  "check",
  "Check domain availability for up to 20 domains",
  {
    domains: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      maxItems: 20,
    },
  },
  async (args) => handleCheck(args)
);

// ---------------------------------------------------------------------------
// Tool: premium_check
// ---------------------------------------------------------------------------

server.tool(
  "premium_check",
  "Check aftermarket/premium status for a single domain (quota-limited)",
  {
    domain: {
      type: "string",
      minLength: 1,
    },
  },
  async (args) => handlePremiumCheck(args)
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
