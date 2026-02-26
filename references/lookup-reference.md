# Domain Lookup Reference

## Worker `/v1/check` Endpoint (Layer 1 — All RDAP + WHOIS Routing)

SKILL.md calls the `mcp__domain_puppy__check` tool (MCP server wraps `POST /v1/check` on the Cloudflare Worker). The worker handles all RDAP routing, WHOIS proxying, and status mapping internally — SKILL.md never calls RDAP endpoints or the worker URL directly.

### Primary: MCP Tool Call (used by SKILL.md)

```
mcp__domain_puppy__check({"domains": ["example.com", "example.io"]})
```

Request: `{"domains": ["example.com", "example.io"]}` — up to 20 domains per request.

Response:
```json
{
  "results": [
    {"domain": "example.com", "status": "taken",     "source": "rdap"},
    {"domain": "example.io",  "status": "available", "source": "rdap"}
  ]
}
```

### Diagnostic / Direct Call (for debugging only — not used by SKILL.md)

```bash
curl -s --max-time 30 -X POST \
  -H "Content-Type: application/json" \
  -d '{"domains":["example.com","example.io"]}' \
  https://domain-puppy-proxy.mattjdalley.workers.dev/v1/check
```

Status values:
- `"available"` → Available (definitive)
- `"taken"` → Taken (definitive)
- `"unknown"` → Non-definitive — proceed to retry
- `"skip"` → TLD is not checkable (.es) — skip, show manual link

Rate limit: 10 requests/min/IP. Use `sleep 3` between batches.

**Concurrency:** Batch up to 20 domains per request. The worker fans out RDAP requests internally across independent registries.

---

## Worker Internal WHOIS Proxy (Layer 2 — 12 ccTLDs)

For TLDs without RDAP support (`.co`, `.it`, `.de`, `.be`, `.at`, `.se`, `.gg`, `.st`, `.pt`, `.my`, `.nu`, `.am`), the worker calls its internal WHOIS proxy transparently. SKILL.md does not need to call `/v1/whois-check` directly — the `/v1/check` endpoint handles routing automatically.

Direct endpoint (for diagnostics only): `POST https://domain-puppy-proxy.mattjdalley.workers.dev/v1/whois-check`

Request: `{"domain": "example.co"}`

Response: `{"status": "available"}`, `{"status": "taken"}`, or `{"status": "unknown"}`

---

## Premium Check (Layer 3 — Domainr/Fastly)

For premium pricing and aftermarket availability, SKILL.md calls the `mcp__domain_puppy__premium_check` tool (single domain, IP-quota limited, 5 checks/month/IP).

### Primary: MCP Tool Call (used by SKILL.md)

```
mcp__domain_puppy__premium_check({"domain": "example.com"})
```

### Diagnostic / Direct Call (for debugging only)

Endpoint: `POST https://domain-puppy-proxy.mattjdalley.workers.dev/v1/premium-check`

Request: `{"domain": "example.com"}`

Response includes `status`, `price`, and `summary` fields.

---

## Retry Before Fallback

After all worker batches complete, collect any results with `"unknown"` status. If there are failures:

1. Wait 10 seconds (`sleep 10`) — lets rate limit windows clear
2. Retry failed domains in a single batch (≤20), reusing `mcp__domain_puppy__check`
3. Re-read results — they replace the originals

Only domains that remain `"unknown"` after retry are shown with manual check links.

---

## Full Fallback Chain

```
1. mcp__domain_puppy__check → worker routes internally:
       → RDAP direct (64 TLDs)  → "taken" or "available"  → DONE
       → WHOIS proxy (12 ccTLDs) → "taken" or "available" → DONE
       → "skip" (.es)            → show manual link        → DONE
       → "unknown"               → proceed to retry
                   ↓ any "unknown" result
2. Retry → wait 10s, re-call mcp__domain_puppy__check (≤20 domains)
                   ↓ still "unknown"
3. Graceful degradation → show manual registrar links (no DoH)
```

---

## Graceful Degradation

Trigger: 3+ domains return `"unknown"` from the worker after retry.

- Do NOT present unchecked domains as available or taken
- Show names without status, with manual check links:

```
I'm having trouble checking availability right now. Here are my suggestions — check them manually:

- brainstorm.dev → [Check on name.com →](https://www.name.com/domain/search/brainstorm.dev)
- brainstorm.ly → [Check on Dynadot →](https://www.dynadot.com/domain/search?domain=brainstorm.ly)

Want me to retry?
```
