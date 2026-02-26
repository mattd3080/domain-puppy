# Domain Puppy

**AI-powered domain brainstorming and availability checking — right in your terminal.**

Domain Puppy is a Claude Code skill that turns your terminal into a domain research powerhouse. Brainstorm hundreds of creative names, check availability in seconds, and find aftermarket gems — all without leaving your editor. Claude activates it automatically when you mention needing a domain, or you can invoke it directly.

---

## What It Does

- **Brainstorm with AI** — Generate hundreds of domain name ideas across 7 naming categories using 10 proven techniques
- **Instant availability checking** — RDAP lookups run in parallel batches, no API key required
- **Batch check 50–100+ domains in seconds** — parallel checking means no waiting around
- **Premium aftermarket search** — Find already-registered domains for sale via Fastly Domain Research API (5 free checks/month per user)
- **Affiliate-powered registration links** — Domains link directly to [name.com](https://www.name.com) for registration and [Sedo](https://sedo.com) for aftermarket purchases

---

## Installation

**Universal (works everywhere — terminal, Claude Code, Codex, Cursor, Gemini CLI, etc.):**

```bash
curl -sL domainpuppy.com/install | sh
```

**Or via the skills CLI:**

```bash
npx skills add mattd3080/domain-puppy
```

That's it. Start a new conversation and say "find me a domain for [your idea]" — Domain Puppy activates automatically.

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

---

## Privacy Policy

> Domain Puppy does not log, store, or analyze the domains you search for. Our proxy processes your request and discards it. We only track aggregate usage counts to manage our free tier quota.

Additional details:

- **Availability checks** use MCP tool calls routed through a Cloudflare Worker to RDAP/WHOIS registries — no domain data is stored
- **Premium search via proxy** — your domain is forwarded to Fastly's Domain Research API and not stored by us
- **Playwright fallback** — when the premium quota is exhausted, the skill can optionally scrape registrar pricing pages with explicit user consent (one-time opt-in per session)

---

## Architecture

```
/domain (Claude Code skill)
    |
    +-- Availability:  MCP tool call → Cloudflare Worker → RDAP/WHOIS registries
    |
    +-- Premium:       MCP tool call → Cloudflare Worker → Fastly Domain Research API
    |
    +-- Fallback:      Playwright → registrar pricing pages (user opt-in, when API quota exhausted)
```

1. The skill file runs entirely within Claude Code — no daemon, no background process
2. Availability checks use MCP tool calls (`mcp__domain_puppy__check`) routed through a local MCP server to the Cloudflare Worker, which queries RDAP/WHOIS registries
3. Premium aftermarket search uses MCP tool calls (`mcp__domain_puppy__premium_check`) routed through the same Cloudflare Worker to the Fastly Domain Research API
4. When the free premium quota is exhausted and the user opts in, the skill can use Playwright to scrape registrar pricing pages directly as a fallback

---

## Contributing

Worker infrastructure details, self-hosting instructions, and deployment docs are in [`worker/README.md`](worker/README.md).

---

## License

MIT
