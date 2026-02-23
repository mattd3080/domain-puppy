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
- `000` or anything else → Non-definitive — proceed to WHOIS fallback

**Concurrency limit:** 20–30 parallel checks per batch.

---

## WHOIS Fallback

Use when RDAP returns a non-definitive result or the TLD is a ccTLD known to not support RDAP.

```bash
whois {domain}
```

**ccTLDs known to require WHOIS:**
`.er`, `.st`, `.pt`, `.sh`, `.it`, `.me`, `.de`, `.at`, `.be`, `.al`, `.am`, `.nu`, `.se`, `.es`, `.us`

Not exhaustive — fall back to WHOIS for any non-definitive RDAP result.

**"Not found" patterns (domain is AVAILABLE if any match):**
```
No match for
NOT FOUND
No entries found
Domain not found
No Data Found
Status: free
Status: AVAILABLE
is available
No Object Found
DOMAIN NOT FOUND
Object does not exist
No information available
```

**Taken indicators:** registration data present (registrar name, creation date, nameservers).

**Concurrency limit:** Max 5–10 concurrent. Run in sub-batches of 5:

```bash
whois example.er  > "$TMPDIR/example.er.whois"  &
whois example.st  > "$TMPDIR/example.st.whois"  &
whois example.me  > "$TMPDIR/example.me.whois"  &
whois example.de  > "$TMPDIR/example.de.whois"  &
whois example.at  > "$TMPDIR/example.at.whois"  &
wait

grep -iqE "No match for|NOT FOUND|No entries found|Domain not found|No Data Found|Status: free|Status: AVAILABLE|is available|No Object Found|DOMAIN NOT FOUND|Object does not exist|No information available" \
  "$TMPDIR/example.er.whois" && echo "available" || echo "taken"
```

---

## DNS Fallback (last resort)

Use when both RDAP and WHOIS fail or are inconclusive.

```bash
dig +short {domain}
```

- Resolves to IP → likely taken
- Empty → unclear

**CRITICAL: DNS results are ALWAYS ❓ (Couldn't check).** Never present as confirmed available or taken. DNS alone doesn't prove availability — a domain can be registered with no DNS records.

```bash
DNS_RESULT=$(dig +short brainstorm.er)
if [ -n "$DNS_RESULT" ]; then
  echo "❓ Likely taken (resolves to $DNS_RESULT) — verify manually"
else
  echo "❓ Couldn't confirm — verify manually"
fi
```

---

## Full Fallback Chain

```
1. RDAP  →  404 (available) or 200 (taken)? → DONE
              ↓ non-definitive
2. WHOIS →  "not found" pattern? → available
              registration data? → taken
              ↓ unclear
3. DNS   →  any result → ❓ always
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
