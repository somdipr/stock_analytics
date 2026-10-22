# PortfolioPilot AI: Milestone 1 requirements specification

Written from the owner's milestone brief and provider requirements. This is the spec the build and the tests trace to.
Status: milestone 1 implemented; awaiting owner review. Nothing beyond milestone 1 has been started.

## 1. Purpose and scope
A personal, single-user, local-first web application that consolidates holdings from several investment accounts and files into one
portfolio view, keeps prices current from a free market-data provider, and is honest about how fresh every number is.
**In scope (milestone 1):** import and review, consolidation, classification, valuation, price refresh, freshness labelling, manual valuation, demo mode.
**Out of scope:** trading or order entry, automated investment decisions, fund look-through, concentration and risk analytics, AI recommendations,
tax lots and performance history, multi-user hosting. These need the owner's explicit approval as a later phase.

## 2. Functional requirements
| ID | Requirement | Where it lives | Verified by |
|---|---|---|---|
| F1 | Upload several CSV and Excel (.xlsx) files at once | `parsers/`, `POST /api/imports/stage` | parsers, api tests |
| F2 | Review and correct every extracted row before import; nothing is saved until the owner commits | `imports.ts`, Import screen | imports, api tests |
| F3 | Consolidate across accounts without double-counting | snapshot semantics, `valuation.ts` | imports, valuation tests |
| F4 | Classify by asset class, sector, geography, instrument type and account; unknowns are flagged, never guessed; owner overrides win | `classification.ts` | classification tests |
| F5 | Show total value, allocation charts, holdings table, data-quality warnings | web UI, `valuation.ts` | valuation, SSR smoke test |
| F6 | Refresh prices automatically through a configurable provider (WebSocket where permitted, otherwise polling, 30-60 s recommended) | `scheduler.ts`, `providers/` | priceservice, providers tests |
| F7 | Show quote timestamp, retrieval timestamp, source, currency, market status and a freshness label per price | `quotes.ts`, `calendar.ts` | quotes, calendar tests |
| F8 | Recalculate valuations and weights whenever a valid newer price arrives | `portfolio.ts` + SSE | valuation, priceservice tests |
| F9 | Manual valuation for physical gold and silver, real estate and other unpriced assets, with stale-valuation warnings | manual assets API and screen | valuation, api tests |
| F10 | Market-data provider behind a replaceable interface | `providers/types.ts` | providers tests |
| F11 | Synthetic data only in clearly labelled demo mode, separate database, refused in live mode | `demo.ts`, `SyntheticProvider` | api, providers tests |
| F12 | Document free-tier limits, attribution and licensing | `docs/PROVIDERS.md`, `/api/meta`, Data & limits screen | api test (no secrets, limits present) |

## 3. Price rules
1. A quote is stored with: price, currency, quote timestamp, retrieval timestamp, source, feed, kind (trade, delayed, end-of-day) and the provider's entitlement flag.
2. The only write path is `ingestQuote`. It rejects non-positive prices, future timestamps and currency changes, and ignores quotes that are not strictly newer than the stored one.
3. An outage never deletes or alters the last valid price; the service reports a degraded state and backs off.
4. Freshness is derived at read time from facts, never copied from a provider label:
   - **Real-time**: provider-confirmed real-time entitlement for the feed **and** a trade timestamp no older than `REALTIME_MAX_AGE_SECONDS` (default 300).
   - **Delayed**: provider-declared delay and age within that delay plus tolerance.
   - **End of day**: the official close or the last trade of the most recent regular session, when the market is not trading.
   - **Stale**: anything older, or a price taken from the imported file.
   - **Unavailable**: no usable price from any source.
5. A holding with no live quote is valued from the imported file's price and labelled "From file".

## 4. Import and reconciliation rules
- Each committed file is a **snapshot** of an account at a time. A newer snapshot replaces that account's earlier positions; an older one is stored but not applied.
- The same file (by content hash) cannot be committed twice, whatever it is called.
- Identical lines repeated inside one file are excluded by default and flagged. A margin and a cash lot of the same symbol are distinct lots and are summed.
- If an incoming account holds nearly the same positions as an existing account, the owner is warned and can map it to the existing account.
- When a file states its own total, the rows are reconciled to it and any difference is shown.
- Raw account numbers are never stored (a hash is the key; only the last four characters are kept for display).

## 5. Non-functional requirements
- Money arithmetic uses decimal numbers only; values are stored as exact text.
- API keys are read from the server environment, never sent to the browser, never logged, and never committed (`.gitignore`, `.env.example`).
- The server listens on 127.0.0.1 only. Real portfolio files and the database are git-ignored.
- Financial calculations are pure functions with no AI involvement. Any later AI layer must read their outputs and may not write to them.
- Free tiers only. The application never upgrades a plan and stops at configured call budgets.

## 6. Acceptance criteria
All 104 automated tests pass, the type checker is clean, and the owner can: import the three sample layouts, correct a row, see consolidated totals that match the files' own stated totals, see the freshness label on every price, add a manual asset, and run the demo without touching live data.
