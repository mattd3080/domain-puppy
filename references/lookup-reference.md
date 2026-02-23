# Domain Lookup Reference

## RDAP (Primary — always try first)

Endpoint: `https://rdap.org/domain/{domain}`

```bash
curl -s -o /dev/null -w "%{http_code}" --max-time 5 https://rdap.org/domain/{domain}
```

- `-s` — silent mode
- `-o /dev/null` — discard body
- `-w "%{http_code}"` — print only the HTTP status code
- `--max-time 5` — timeout after 5 seconds

Status codes:
- `404` → Available (definitive)
- `200` → Taken (definitive)
- `000` or anything else → Non-definitive — proceed to DoH fallback

**Concurrency limit:** 20–30 parallel checks per batch.

---

## DoH Fallback (DNS over HTTPS via curl)

Use when RDAP returns a non-definitive result. No local `dig` or `whois` required — uses Cloudflare's public DNS API over HTTPS.

```bash
DOH=$(curl -s --max-time 5 \
  "https://cloudflare-dns.com/dns-query?name={domain}&type=A" \
  -H "accept: application/dns-json")

if echo "$DOH" | grep -q '"Answer"'; then
  echo "❓ Likely taken (has DNS records) — verify manually"
else
  echo "❓ Couldn't confirm — verify manually"
fi
```

**CRITICAL: DoH results are ALWAYS ❓ (Couldn't check).** A domain can be registered with no DNS records, so DoH never confirms availability. Only RDAP gives definitive results.

---

## Full Fallback Chain

```
1. RDAP  →  404 (available) or 200 (taken)? → DONE
              ↓ non-definitive
2. DoH   →  "Answer" present → ❓ likely taken — verify manually
              no Answer       → ❓ couldn't confirm — verify manually
```

---

## Graceful Degradation

Trigger: 3+ timeouts (HTTP 000) in the same batch across different registries.

- Do NOT present unchecked domains as available or taken
- Show names without status, with manual check links:

```
I'm having trouble checking availability right now. Here are my suggestions — check them manually:

- brainstorm.dev → [Check on name.com →](https://www.name.com/domain/search/brainstorm.dev)

Want me to retry?
```
