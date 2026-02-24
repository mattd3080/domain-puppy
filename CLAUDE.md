# Domain Puppy — Project Instructions

## Internal docs

All PRDs, progress logs, plans, handoffs, and internal notes go in `internal/`. This directory is gitignored and never ships to GitHub.

```
internal/
├── PRD.md
├── PROGRESS.md
└── handoffs/
```

When creating any of the following, put them in `internal/`:
- Product requirements documents
- Implementation plans
- Progress logs
- Phase handoffs and checkpoints
- Anything not meant for public contributors

## Project structure

```
domain-puppy/
├── SKILL.md            # The skill (repo root — required by npx skills add)
├── CLAUDE.md           # This file
├── README.md           # Public-facing docs
├── hooks/              # Git hooks (ships with repo)
├── internal/           # Gitignored — all internal docs
└── worker/             # Cloudflare Worker proxy
```

Install command: `npx skills add mattd3080/domain-puppy`

## Worker

The Cloudflare Worker is deployed at:
`https://domain-puppy-proxy.mattjdalley.workers.dev/v1/premium-check`

Secrets live in Cloudflare (never in files):
- `FASTLY_API_TOKEN` — set via `wrangler secret put FASTLY_API_TOKEN`
- `ALERT_WEBHOOK` — optional, for circuit breaker alerts

To redeploy after changes:
```bash
cd worker && npm run deploy
```

## Secret hygiene

- Never put API keys or tokens in tracked files
- Secrets go in `.dev.vars` (gitignored) for local dev, or as Cloudflare secrets for production
- The pre-commit hook (`hooks/pre-commit`) scans for accidental leaks — install it after cloning:
  ```bash
  cp hooks/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
  ```
