# Domain Puppy

**AI-powered domain brainstorming and availability checking — right in your terminal.**

Domain Puppy is a Claude Code skill that turns your terminal into a domain research powerhouse. Brainstorm hundreds of creative names, check availability in seconds, and find aftermarket gems — all without leaving your editor. Claude activates it automatically when you mention needing a domain, or you can invoke it directly.

---

## What It Does

- **Brainstorm with AI** — Generate hundreds of domain name ideas across 7 naming categories using 10 proven techniques
- **Instant availability checking** — RDAP lookups run in parallel batches, no API key required
- **Batch check 50–100+ domains in seconds** — parallel checking means no waiting around
- **Premium aftermarket search** — Find already-registered domains for sale via Fastly Domain Research API (5 free checks/month per user, or unlimited with your own key)
- **Affiliate-powered registration links** — Domains link directly to [name.com](https://www.name.com) for registration and [Sedo](https://sedo.com) for aftermarket purchases

---

## Installation

```bash
npx skills add mattd3080/domain-puppy
```

That's it. Claude will automatically activate Domain Puppy when you mention needing a domain, or invoke it directly: "use domain puppy" or "check if brainstorm.com is available".

---

## Usage

### Flow 1: Check a specific domain

```
is brainstorm.com available?
```
or invoke directly:
```
use domain puppy — check brainstorm.com
```

Domain Puppy checks availability across a 10-TLD matrix and returns results:

```
✅ brainstorm.io       — Available — Register at name.com
❌ brainstorm.com      — Taken
✅ brainstorm.ai       — Available — Register at name.com
❓ brainstorm.co.uk    — Status unknown (ccTLD)
```

### Flow 2: Brainstorm mode

```
/domain
> brainstorm
> A project management tool for remote teams
```

Domain Puppy generates waves of names — Quick Wave (fast ideas), Standard Wave (refined variations), Deep Dive (creative combinations) — checking availability for each batch as it goes.

---

## Features

| Feature | Detail |
|---|---|
| Single domain check | Checks availability across 10 TLDs per domain |
| Brainstorm mode | 7 naming categories, 10 techniques, wave-based refinement |
| Wave-based refinement | Quick / Standard / Deep Dive waves |
| Taken domain alternatives | 5 strategies when your first choice is gone |
| WHOIS/DNS fallback | Covers ccTLDs that don't support RDAP |
| Domain hacks | 80+ curated examples across creative TLD combinations |
| Thematic TLD matching | Suggests TLDs based on 12 project types |
| Aftermarket search | Premium search via Fastly Domain Research API |
| Local config | Secure local storage for your API key (chmod 600) |

---

## Premium Search Setup (Optional)

By default, Domain Puppy includes **5 free premium aftermarket checks per month** — no setup needed.

For unlimited premium searches, add your own [Fastly API token](https://manage.fastly.com/account/personal/tokens) (free with a Fastly account):

**Option A: Let Claude handle it**

Just say "I want to add my API key" during a `/domain` session — Claude will prompt you and store it securely.

**Option B: Manual setup**

```bash
mkdir -p ~/.claude/domain-puppy && chmod 700 ~/.claude/domain-puppy
echo '{ "fastlyApiToken": "your-token-here" }' > ~/.claude/domain-puppy/config.json
chmod 600 ~/.claude/domain-puppy/config.json
```

Once set, all premium searches bypass the shared proxy and use your key directly.

---

## Privacy Policy

> Domain Puppy does not log, store, or analyze the domains you search for. Our proxy processes your request and discards it. We only track aggregate usage counts to manage our free tier quota.

Additional details:

- **Free RDAP/WHOIS/DNS checks** go directly from your machine — we never see them
- **Premium search via proxy** — your domain is forwarded to Fastly's Domain Research API and not stored by us
- **With your own API key** — premium searches bypass our proxy entirely and go straight to the Fastly API
- **Config file** is stored at `~/.claude/domain-puppy/config.json` with `chmod 600` (owner-read-only)

---

## Architecture

```
/domain (Claude Code skill)
    |
    +-- Free checks:  curl → RDAP endpoints (parallel)
    |                 Cloudflare Worker → WHOIS (13 ccTLDs without RDAP)
    |
    +-- Premium:      Cloudflare Worker proxy → Fastly Domain Research API
    |                 (or direct to Fastly API with your own key)
    |
    +-- Fallback:     Playwright → registrar pricing pages (when API quota exhausted)
```

1. The skill file runs entirely within Claude Code — no daemon, no background process
2. Free availability checks hit RDAP servers directly from your machine
3. For 13 ccTLDs without RDAP support, the skill routes WHOIS checks through the Cloudflare Worker proxy
4. Premium aftermarket search routes through a Cloudflare Worker that manages the shared quota and forwards requests to Fastly
5. If you supply your own Fastly API token, premium searches skip the proxy entirely
6. When the free premium quota is exhausted and Playwright is installed, the skill can scrape registrar pricing pages directly as a fallback

---

## Worker Infrastructure

The Cloudflare Worker proxy (`worker/src/index.js`) sits between free-tier users and the Fastly Domain Research API. It protects against runaway usage and abuse.

### Deployed Endpoints

- `POST /v1/premium-check` — Premium domain status via Fastly/Domainr (IP-quota limited)
- `POST /v1/whois-check` — WHOIS availability for 13 ccTLDs without RDAP support

Base URL: `https://domain-puppy-proxy.mattjdalley.workers.dev`

### Protection Layers

Requests pass through guards in this order:

| Layer | What it does | Threshold |
|---|---|---|
| **IP rate limit** | Blocks burst abuse from a single IP | 10 requests/minute per IP |
| **Monthly circuit breaker** | Disables premium search for all users when global usage is too high | 8,000 requests/month (configurable via `MONTHLY_QUOTA_LIMIT`) |
| **Per-IP quota** | Limits free checks per user | 5 checks/month per IP (configurable via `FREE_CHECKS_PER_IP`) |

All guards use Cloudflare KV for state and **fail open** — if KV is unavailable, requests pass through rather than breaking the product.

### Circuit Breaker Details

- Counter key: `circuit:monthly:{YYYY-MM}` in KV
- Trips at `MONTHLY_QUOTA_LIMIT` (default: 8,000) total requests across all users
- Resets automatically each calendar month (KV TTL: 60 days)
- When tripped, returns HTTP 503 — the skill handles this gracefully and falls back to free RDAP/WHOIS/DNS checks
- **Alert webhook**: When the breaker trips, fires a one-time POST to `ALERT_WEBHOOK` (if configured) with a notification message. Works with Slack, Discord, or any HTTP endpoint.

### Known Limitations

- **KV eventual consistency**: Cloudflare KV writes can take up to 60 seconds to propagate globally. Under heavy concurrent load, the circuit breaker could overshoot by a few hundred requests before all edge nodes see the updated counter.
- **No edge rate limiting on workers.dev**: Cloudflare's WAF rate limiting rules only apply to custom domains, not `*.workers.dev` subdomains. To add a hard backstop at the Cloudflare edge, set up a custom domain (e.g., `api.domainpuppy.dev`) and add a rate limiting rule there.

### Secrets & Environment Variables

| Name | Type | Description |
|---|---|---|
| `FASTLY_API_TOKEN` | Secret | Fastly API token for Domain Research API access |
| `ALERT_WEBHOOK` | Secret (optional) | Webhook URL for circuit breaker alerts (Slack/Discord/any) |
| `MONTHLY_QUOTA_LIMIT` | Env var | Monthly request cap before circuit breaker trips (default: 8000) |
| `FREE_CHECKS_PER_IP` | Env var | Free premium checks per IP per month (default: 5) |

### KV Namespace

| Binding | Namespace ID | Purpose |
|---|---|---|
| `QUOTA_KV` | `1e8eeb0b1e13419ba18a78f29e18e96a` | IP quotas, circuit breaker counter, rate limit counters |

### KV Key Patterns

| Key format | TTL | Purpose |
|---|---|---|
| `ip:{ip}:{YYYY-MM}` | 60 days | Per-IP monthly quota counter |
| `circuit:monthly:{YYYY-MM}` | 60 days | Global monthly request counter |
| `ratelimit:{ip}:{minute}` | 120 seconds | Per-IP burst rate limit counter |

---

## Releasing a New Version

Domain Puppy auto-prompts users to update when a new version is pushed to main. To release:

```bash
./hooks/bump-version.sh 1.6.0    # updates all version strings in SKILL.md
git add SKILL.md
git commit -m "Release v1.6.0"
git push
```

The bump script updates the version in all three locations within SKILL.md (frontmatter, `LOCAL_VERSION`, and comment headers) in one command. The pre-commit hook will block the commit if any of them are out of sync.

Users on older versions will see a persistent update prompt until they say "update", which runs `npx skills add mattd3080/domain-puppy` to pull the latest.

---

## Self-Hosting the Worker

Contributors and teams who want to run their own proxy can deploy the Cloudflare Worker:

```bash
cd worker
npm install
wrangler kv:namespace create QUOTA_KV
# Copy the KV namespace ID into wrangler.toml
wrangler secret put FASTLY_API_TOKEN
wrangler deploy
```

Then find and replace `https://domain-puppy-proxy.mattjdalley.workers.dev/v1/premium-check` in `SKILL.md` with your deployed worker URL.

### Secret leak prevention

Install the pre-commit hook after cloning:

```bash
cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
```

The hook scans staged files for token-like patterns and blocks the commit if anything suspicious is found. Secrets must be stored in `.dev.vars` (gitignored) or as Cloudflare secrets — never in tracked files.

### Optional: Alert Webhook

```bash
wrangler secret put ALERT_WEBHOOK
# Paste your Slack/Discord/webhook URL
```

### Optional: Custom Domain + Edge Rate Limiting

For a hard backstop beyond the KV-based circuit breaker:

1. Add a custom domain to Cloudflare (e.g., `api.domainpuppy.dev`)
2. Route the worker to that domain via `wrangler.toml` or the Cloudflare dashboard
3. Add a WAF Rate Limiting rule on that zone capping `/v1/premium-check` at your desired monthly limit

---

## License

MIT
