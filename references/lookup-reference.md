# Domain Lookup Reference

## RDAP (Layer 1 — Direct Authoritative Endpoints)

The `rdap_url()` function maps 64 TLDs to their authoritative RDAP servers directly, bypassing rdap.org. This distributes load across independent registries and avoids centralized rate limiting.

```bash
curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$(rdap_url example.com)"
```

- `-s` — silent mode
- `-o /dev/null` — discard body
- `-w "%{http_code}"` — print only the HTTP status code
- `--max-time 10` — timeout after 10 seconds
- `-L` — follow redirects if needed (some authoritative servers redirect)

Status codes:
- `404` → Available (definitive)
- `200` → Taken (definitive)
- `429` → Rate limited — non-definitive, proceed to retry then DoH fallback
- `000` or anything else → Non-definitive — proceed to retry then DoH fallback

`rdap_url()` returns one of three things:
- A direct authoritative RDAP URL (64 mapped TLDs) — curl directly
- `"WHOIS"` (13 ccTLDs without RDAP) — route to Worker WHOIS proxy (Layer 2)
- An rdap.org URL (`https://rdap.org/domain/{domain}`) — wildcard fallback for unmapped TLDs, requires `-L` to follow the redirect to the authoritative server

**Concurrency:** Direct RDAP distributes load across 5+ independent servers. Standard 10-parallel batching still applies as a conservative default.

---

## Worker WHOIS Proxy (Layer 2 — 13 ccTLDs)

For TLDs without RDAP support (`.co`, `.it`, `.de`, `.be`, `.at`, `.se`, `.gg`, `.st`, `.pt`, `.my`, `.nu`, `.am`, `.es`), availability is checked via the Domain Shark worker's WHOIS proxy.

Endpoint: `POST https://domain-shark-proxy.mattjdalley.workers.dev/v1/whois-check`

Request: `{"domain": "example.co"}`

Response: `{"status": "available"}`, `{"status": "taken"}`, or `{"status": "unknown"}`

Status mapping:
- `"available"` → Available ✅ (equivalent to RDAP 404)
- `"taken"` → Taken ❌ (equivalent to RDAP 200)
- `"unknown"` → Couldn't check ❓ (equivalent to RDAP 000/429)

The `check_domain()` helper function in SKILL.md templates handles this routing automatically.

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

**CRITICAL: DoH results are ALWAYS ❓ (Couldn't check).** A domain can be registered with no DNS records, so DoH never confirms availability. Only RDAP and WHOIS give definitive results.

---

## Retry Before Fallback

After all RDAP/WHOIS batches complete, collect any results that were not definitive (e.g., 000 timeout, 429 rate limit, WHOIS proxy `"unknown"`). If there are failures:

1. Wait 10 seconds (`sleep 10`) — lets rate limit windows clear
2. Retry failed domains in batches of ≤5 concurrent, with `sleep 3` between retry batches
3. Use `--max-time 10` for retries (more generous than initial pass)
4. Re-read results — they replace the originals

Only fall through to DoH for domains that fail **both** the initial check and the retry.

---

## Full Fallback Chain

```
1. rdap_url() → RDAP URL?  → curl direct  → 200 (taken) or 404 (available) → DONE
               → "WHOIS"?   → curl worker proxy → taken/available → DONE
                                                → unknown → proceed to retry
               → rdap.org?  → curl proxy   → 200/404 → DONE
                   ↓ any non-definitive result
2. Retry → wait 10s, re-check (≤5 concurrent, --max-time 10)
                   ↓ still non-definitive
3. DoH   → "Answer" present → ❓ likely taken — verify manually
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
