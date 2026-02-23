# RDAP Endpoint Map

Canonical reference for all 77 TLDs supported by Domain Shark. Documents the exact RDAP endpoint per registry, the `rdap_url()` bash function used in all SKILL.md templates, and the fallback chain.

---

## Layer 1 — Direct RDAP (64 TLDs)

### Verisign (3 TLDs)

| TLD | Endpoint pattern |
|-----|-----------------|
| .com | `https://rdap.verisign.com/com/v1/domain/{d}` |
| .net | `https://rdap.verisign.com/net/v1/domain/{d}` |
| .cc | `https://tld-rdap.verisign.com/cc/v1/domain/{d}` |

### Google (2 TLDs)

| TLD | Endpoint pattern |
|-----|-----------------|
| .dev | `https://pubapi.registry.google/rdap/domain/{d}` |
| .app | `https://pubapi.registry.google/rdap/domain/{d}` |

### Identity Digital (34 TLDs)

Endpoint pattern: `https://rdap.identitydigital.services/rdap/domain/{d}`

| TLD | Notes |
|-----|-------|
| .ai | |
| .io | ⚠️ unofficial — not in IANA bootstrap, verified working |
| .me | ⚠️ unofficial — not in IANA bootstrap, verified working |
| .sh | ⚠️ unofficial — not in IANA bootstrap, verified working |
| .tools | |
| .codes | |
| .run | |
| .studio | |
| .gallery | |
| .media | |
| .chat | |
| .coffee | |
| .cafe | |
| .ventures | |
| .supply | |
| .agency | |
| .capital | |
| .community | |
| .social | |
| .group | |
| .team | |
| .market | |
| .deals | |
| .academy | |
| .school | |
| .training | |
| .care | |
| .clinic | |
| .band | |
| .money | |
| .finance | |
| .fund | |
| .tax | |
| .investments | |

> **⚠️ Note on .io, .me, .sh:** Identity Digital serves RDAP for these ccTLDs but they are not listed in the IANA RDAP bootstrap. If Identity Digital drops support, move these three to the WHOIS proxy whitelist.

### CentralNic (10 TLDs)

Endpoint pattern: `https://rdap.centralnic.com/{tld}/domain/{d}` (note: TLD is included in the path)

| TLD |
|-----|
| .xyz |
| .build |
| .art |
| .game |
| .quest |
| .lol |
| .inc |
| .store |
| .audio |
| .fm |

### Dedicated NICs (9 TLDs)

| TLD | Endpoint pattern |
|-----|-----------------|
| .design | `https://rdap.nic.design/domain/{d}` |
| .ink | `https://rdap.nic.ink/domain/{d}` |
| .menu | `https://rdap.nic.menu/domain/{d}` |
| .club | `https://rdap.nic.club/domain/{d}` |
| .courses | `https://rdap.nic.courses/domain/{d}` |
| .health | `https://rdap.nic.health/domain/{d}` |
| .fit | `https://rdap.nic.fit/domain/{d}` |
| .music | `https://rdap.registryservices.music/rdap/domain/{d}` |
| .shop | `https://rdap.gmoregistry.net/rdap/domain/{d}` |

### ccTLDs with IANA RDAP (6 TLDs)

| TLD | Endpoint pattern |
|-----|-----------------|
| .ly | `https://rdap.nic.ly/domain/{d}` |
| .is | `https://rdap.isnic.is/rdap/domain/{d}` |
| .to | `https://rdap.tonicregistry.to/rdap/domain/{d}` |
| .in | `https://rdap.nixiregistry.in/rdap/domain/{d}` |
| .re | `https://rdap.nic.re/domain/{d}` |
| .no | `https://rdap.norid.no/domain/{d}` |

---

## Layer 2 — Worker WHOIS Proxy (13 TLDs)

No RDAP available. Routed through the worker's WHOIS proxy.

| TLD | WHOIS server |
|-----|-------------|
| .co | whois.registry.co |
| .it | whois.nic.it |
| .de | whois.denic.de |
| .be | whois.dns.be |
| .at | whois.nic.at |
| .se | whois.iis.se |
| .gg | whois.gg |
| .st | whois.nic.st |
| .pt | whois.dns.pt |
| .my | whois.mynic.my |
| .nu | whois.iis.nu |
| .am | whois.amnic.net |
| .es | whois.nic.es ⚠️ IP auth required |

---

## Non-Registrable ccTLDs

| TLD | Reason |
|-----|--------|
| .er | No public registration — no availability check |
| .al | No public registration — no availability check |

---

## The `rdap_url()` Canonical Function

Copy this function **verbatim** into all 4 SKILL.md templates. Do not modify the URL patterns or case labels without also updating this file.

```bash
rdap_url() {
  local domain=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  local tld="${domain##*.}"
  case "$tld" in
    # --- Verisign ---
    com) echo "https://rdap.verisign.com/com/v1/domain/${domain}" ;;
    net) echo "https://rdap.verisign.com/net/v1/domain/${domain}" ;;
    cc) echo "https://tld-rdap.verisign.com/cc/v1/domain/${domain}" ;;
    # --- Google ---
    dev|app) echo "https://pubapi.registry.google/rdap/domain/${domain}" ;;
    # --- Identity Digital (includes unofficial: .io, .me, .sh) ---
    ai|io|me|sh|tools|codes|run|studio|gallery|media|chat|coffee|cafe|ventures|supply|agency|capital|community|social|group|team|market|deals|academy|school|training|care|clinic|band|money|finance|fund|tax|investments)
      echo "https://rdap.identitydigital.services/rdap/domain/${domain}" ;;
    # --- CentralNic ---
    xyz|build|art|game|quest|lol|inc|store|audio|fm)
      echo "https://rdap.centralnic.com/${tld}/domain/${domain}" ;;
    # --- Dedicated NICs ---
    design) echo "https://rdap.nic.design/domain/${domain}" ;;
    ink) echo "https://rdap.nic.ink/domain/${domain}" ;;
    menu) echo "https://rdap.nic.menu/domain/${domain}" ;;
    club) echo "https://rdap.nic.club/domain/${domain}" ;;
    courses) echo "https://rdap.nic.courses/domain/${domain}" ;;
    health) echo "https://rdap.nic.health/domain/${domain}" ;;
    fit) echo "https://rdap.nic.fit/domain/${domain}" ;;
    music) echo "https://rdap.registryservices.music/rdap/domain/${domain}" ;;
    shop) echo "https://rdap.gmoregistry.net/rdap/domain/${domain}" ;;
    # --- ccTLDs with IANA RDAP ---
    ly) echo "https://rdap.nic.ly/domain/${domain}" ;;
    is) echo "https://rdap.isnic.is/rdap/domain/${domain}" ;;
    to) echo "https://rdap.tonicregistry.to/rdap/domain/${domain}" ;;
    in) echo "https://rdap.nixiregistry.in/rdap/domain/${domain}" ;;
    re) echo "https://rdap.nic.re/domain/${domain}" ;;
    no) echo "https://rdap.norid.no/domain/${domain}" ;;
    # --- No RDAP: route through worker WHOIS proxy ---
    co|it|de|be|at|se|gg|st|pt|my|nu|am|es) echo "WHOIS" ;;
    # --- Unknown TLDs: rdap.org fallback ---
    *) echo "https://rdap.org/domain/${domain}" ;;
  esac
}
```

---

## Fallback Chain

```
rdap_url() → RDAP URL  → curl direct  → 200/404         → DONE
           → "WHOIS"   → curl worker proxy → taken/available/unknown
           → rdap.org  → curl proxy   → 200/404         → DONE
                ↓ non-definitive
Retry → wait 10s → re-check
                ↓ still non-definitive
DoH → could not confirm — return manual link
```

---

## Maintenance Notes

When adding a new TLD:

1. **Check IANA bootstrap first** — `https://data.iana.org/rdap/dns.json` — if the TLD is listed, use that URL.
2. **Not in IANA bootstrap?** Check if Identity Digital serves it (`rdap.identitydigital.services`). Mark it ⚠️ unofficial if so.
3. **No RDAP at all?** Add to the WHOIS proxy whitelist in the worker and add a `WHOIS` case to `rdap_url()`.
4. Update this file, `tld-catalog.md`, and all 4 SKILL.md templates in sync.
