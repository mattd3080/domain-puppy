# Domain Puppy — Worker Infrastructure

The Cloudflare Worker proxy (`src/index.js`) sits between free-tier users and the Fastly Domain Research API. It protects against runaway usage and abuse.

## Deployed Endpoints

- `POST /v1/check` — Batch domain availability via RDAP/WHOIS
- `POST /v1/premium-check` — Premium domain status via Fastly/Domainr (IP-quota limited)
- `POST /v1/whois-check` — WHOIS availability for 13 ccTLDs without RDAP support

Base URL: `https://domain-puppy-proxy.mattjdalley.workers.dev`

## Protection Layers

Requests pass through guards in this order:

| Layer | What it does | Threshold |
|---|---|---|
| **IP rate limit** | Blocks burst abuse from a single IP | 10 requests/minute per IP |
| **Monthly circuit breaker** | Disables premium search for all users when global usage is too high | 8,000 requests/month (configurable via `MONTHLY_QUOTA_LIMIT`) |
| **Per-IP quota** | Limits free checks per user | 5 checks/month per IP (configurable via `FREE_CHECKS_PER_IP`) |

All guards use Cloudflare KV for state and **fail open** — if KV is unavailable, requests pass through rather than breaking the product.

## Circuit Breaker Details

- Counter key: `circuit:monthly:{YYYY-MM}` in KV
- Trips at `MONTHLY_QUOTA_LIMIT` (default: 8,000) total requests across all users
- Resets automatically each calendar month (KV TTL: 60 days)
- When tripped, returns HTTP 503 — the skill handles this gracefully and falls back to free RDAP/WHOIS/DNS checks
- **Alert webhook**: When the breaker trips, fires a one-time POST to `ALERT_WEBHOOK` (if configured) with a notification message. Works with Slack, Discord, or any HTTP endpoint.

## Known Limitations

- **KV eventual consistency**: Cloudflare KV writes can take up to 60 seconds to propagate globally. Under heavy concurrent load, the circuit breaker could overshoot by a few hundred requests before all edge nodes see the updated counter.
- **No edge rate limiting on workers.dev**: Cloudflare's WAF rate limiting rules only apply to custom domains, not `*.workers.dev` subdomains. To add a hard backstop at the Cloudflare edge, set up a custom domain (e.g., `api.domainpuppy.dev`) and add a rate limiting rule there.

## Environment Variables

| Name | Type | Description |
|---|---|---|
| `FASTLY_API_TOKEN` | Cloudflare secret | Fastly API token for Domain Research API access |
| `ALERT_WEBHOOK` | Cloudflare secret (optional) | Webhook URL for circuit breaker alerts |
| `MONTHLY_QUOTA_LIMIT` | Env var | Monthly request cap before circuit breaker trips (default: 8000) |
| `FREE_CHECKS_PER_IP` | Env var | Free premium checks per IP per month (default: 5) |

## KV Namespace

| Binding | Namespace ID | Purpose |
|---|---|---|
| `QUOTA_KV` | `1e8eeb0b1e13419ba18a78f29e18e96a` | IP quotas, circuit breaker counter, rate limit counters |

## KV Key Patterns

| Key format | TTL | Purpose |
|---|---|---|
| `ip:{ip}:{YYYY-MM}` | 60 days | Per-IP monthly quota counter |
| `circuit:monthly:{YYYY-MM}` | 60 days | Global monthly request counter |
| `ratelimit:{ip}:{minute}` | 120 seconds | Per-IP burst rate limit counter |

## Self-Hosting

Contributors and teams who want to run their own proxy:

```bash
cd worker
npm install
wrangler kv:namespace create QUOTA_KV
# Copy the KV namespace ID into wrangler.toml
wrangler secret put FASTLY_API_TOKEN
wrangler deploy
```

Then update the worker URL in `mcp/src/handlers.js` to point to your deployed worker.

### Pre-commit hook

Install after cloning to prevent accidental secret commits:

```bash
cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

### Optional: Alert Webhook

```bash
wrangler secret put ALERT_WEBHOOK
```

### Optional: Custom Domain + Edge Rate Limiting

1. Add a custom domain to Cloudflare (e.g., `api.domainpuppy.dev`)
2. Route the worker to that domain via `wrangler.toml` or the Cloudflare dashboard
3. Add a WAF Rate Limiting rule on that zone capping `/v1/premium-check` at your desired monthly limit
