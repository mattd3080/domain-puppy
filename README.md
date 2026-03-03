# Domain Puppy

**AI-powered domain brainstorming and availability checking — right in your terminal.**

Domain Puppy is a Claude Code skill that turns your terminal into a domain research powerhouse. Brainstorm hundreds of creative names, check availability in seconds, and find aftermarket gems — all without leaving your editor. Claude activates it automatically when you mention needing a domain, or you can invoke it directly.

---

## What It Does

- **Brainstorm with AI** — Generate hundreds of domain name ideas across 7 naming categories using 10 proven techniques
- **Instant availability checking** — RDAP lookups run in parallel batches, no API key required
- **Batch check 50–100+ domains in seconds** — parallel checking means no waiting around
- **Premium aftermarket search** — Find already-registered domains for sale with real pricing via Sedo + Fastly (5 free checks/month per user)
- **Affiliate-powered registration links** — Domains link to the appropriate registrar ([name.com](https://www.name.com) or [Dynadot](https://www.dynadot.com) depending on TLD) and [Sedo](https://sedo.com) for aftermarket purchases

---

## Installation

Two steps, one time:

**Step 1 — Install the skill**
```bash
npx skills add mattd3080/domain-puppy
```

**Step 2 — Connect the availability checker**
```bash
claude mcp add domain-puppy -- node ~/.agents/skills/domain-puppy/mcp/src/server.js
```

Start a new conversation and say "find me a domain for [your idea]" — Domain Puppy activates automatically.

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

Domain Puppy checks the domain and returns the result with next steps:

```
✅ brainstorm.dev      — Available — Register at name.com
❌ brainstorm.com      — Taken — check aftermarket, scan other TLDs, or brainstorm alternatives
```

### Flow 2: Brainstorm mode

```
/domain
> brainstorm
> A project management tool for remote teams
```

Domain Puppy generates waves of names — checking availability for each batch as it goes. Say "go deeper" for more waves, or "quick scan" for just the highlights.

---

## Features

| Feature | Detail |
|---|---|
| Single domain check | Checks the specific domain you ask about; opt-in TLD scan available |
| Brainstorm mode | 7 naming categories, 10 techniques, wave-based refinement |
| Wave-based refinement | Standard depth (2-3 waves), "go deeper" or "quick scan" on demand |
| Taken domain options | Check the aftermarket, scan other TLDs, or brainstorm alternatives |
| WHOIS/DNS fallback | Covers ccTLDs that don't support RDAP |
| Domain hacks | 80+ curated examples across creative TLD combinations |
| Thematic TLD matching | Suggests TLDs based on 12 project types |
| Aftermarket search | Premium search via Sedo Partner API + Fastly Domain Research API |

---

## Privacy Policy

> Domain Puppy does not log, store, or analyze the domains you search for. Our proxy processes your request and discards it. We only track aggregate usage counts to manage our free tier quota.

Additional details:

- **Availability checks** use MCP tool calls routed through a Cloudflare Worker to RDAP/WHOIS registries — no domain data is stored
- **Premium search via proxy** — your domain is forwarded to the Sedo Partner API and Fastly's Domain Research API and not stored by us

---

## Architecture

```
/domain (Claude Code skill)
    |
    +-- Availability:  MCP tool call → Cloudflare Worker → RDAP/WHOIS registries
    |
    +-- Premium:       MCP tool call → Cloudflare Worker → Sedo Partner API → Fastly fallback
```

1. The skill file runs entirely within Claude Code — no daemon, no background process
2. Availability checks use MCP tool calls (`mcp__domain_puppy__check`) routed through a local MCP server to the Cloudflare Worker, which queries RDAP/WHOIS registries
3. Premium aftermarket search uses MCP tool calls (`mcp__domain_puppy__premium_check`) routed through the same Cloudflare Worker — Sedo is queried first for aftermarket listings and prices, with Fastly Domain Research API as fallback for registry premiums

---

## Contributing

Worker infrastructure details, self-hosting instructions, and deployment docs are in [`worker/README.md`](worker/README.md).

---

## License

MIT
