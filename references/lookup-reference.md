# Domain Lookup Reference

## RDAP (Primary — always try first)

Endpoint: `https://rdap.org/domain/{domain}`

```bash
curl -s -o /dev/null -w "%{http_code}" -L --max-time 10 https://rdap.org/domain/{domain}
```

- `-s` — silent mode
- `-o /dev/null` — discard body
- `-w "%{http_code}"` — print only the HTTP status code
- `-L` — follow redirects (rdap.org returns 302 to the authoritative server — required)
- `--max-time 10` — timeout after 10 seconds (allows for the redirect hop)

Status codes:
- `404` → Available (definitive)
- `200` → Taken (definitive)
- `000` or anything else → Non-definitive — proceed to DoH fallback

**Concurrency limit:** 15 parallel checks per batch (rdap.org rate-limits above ~15 concurrent requests from a single IP).

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
- brainstorm.ly → [Check on Dynadot →](https://www.dynadot.com/domain/search?domain=brainstorm.ly)

Want me to retry?
```
