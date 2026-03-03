# Sedo Partner API Integration + Domainbro QA Expansion (v2.2.0)

Plan saved from implementation session. See the full plan in the conversation transcript.

## Phase 1 Results (Validated 2026-03-03)

- **Endpoint:** `GET https://api.sedo.com/api/v1/DomainStatus`
- **Credentials needed:** 2 only — `partnerid` + `signkey` (no username/password)
- **Response format:** XML with `<SEDOLIST>` containing `<item>` elements
- **Fields:** domain, type, forsale, price, currency, visitors, domainstatus
- **API returns fuzzy matches** alongside exact domain — must filter for exact match
- **Currency:** decimal `0` for unlisted domains, string `"USD"` for listed. Map: {0: 'EUR', 1: 'USD', 2: 'GBP'}
- **Response time:** 200-800ms
- **poker.net example:** forsale=true, price=1500000, currency=USD, domainstatus=1
- **google.com example:** forsale=false, price=0.00, currency=0, domainstatus=0
