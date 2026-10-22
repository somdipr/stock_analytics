# PortfolioPilot AI

A personal portfolio intelligence application. It consolidates holdings from several investment accounts and files into one portfolio view,
keeps prices current from a free market-data provider, and is explicit about how fresh every price is.

**Milestone 1 (portfolio foundation) is implemented and awaiting review.** There is no trading, order entry or automated investment decision anywhere in it.
Fund look-through, concentration analysis, risk measurement and AI recommendations are not started and will not be until milestone 1 is approved.

- Requirements: [docs/SPEC.md](docs/SPEC.md) · Providers, free-tier limits and licensing: [docs/PROVIDERS.md](docs/PROVIDERS.md)

## Quick start (local)
Requires Node 22.9 or newer.

```bash
npm install
cp .env.example .env        # then edit .env (see Configuration)
npm run build               # builds the web app into web/dist
npm start                   # http://127.0.0.1:3000  (live mode: your real data, stored locally)
```

Try it without any data or keys: `npm run start:demo` shows a clearly labelled **synthetic** portfolio in its own database.

Development with hot reload: `npm run dev` (web on http://127.0.0.1:5173, API on :3000).

## Configuration (`.env`, never committed)
| Variable | Default | Meaning |
|---|---|---|
| `PORTFOLIO_MODE` | `live` | `live` uses real files; `demo` uses a separate database and synthetic data |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | empty | Alpaca market-data credentials (paper keys are enough). Without them the app still works, valuing from imported prices and labelling them "From file" |
| `ALPACA_FEED` | `iex` | `iex` is the free feed. Leave as is unless you have a paid plan |
| `ALPACA_STREAM` | `true` | Use the WebSocket for your largest holdings (up to 30 symbols) |
| `FMP_API_KEY`, `FMP_DAILY_CALL_BUDGET` | empty, `200` | Optional end-of-day fallback and the most calls it may use per day (free plan allows about 250) |
| `PRICE_REFRESH_SECONDS` | `45` | Polling interval, clamped to 30-300 (30-60 recommended) |
| `REALTIME_MAX_AGE_SECONDS` | `300` | A trade older than this is not labelled real-time |
| `PORT`, `DATA_DIR` | `3000`, `./data` | Where the server listens (127.0.0.1 only) and where the SQLite files live |

Check your credentials safely (read-only, never prints keys): `npm run check:provider` · add `-- --stream` to test the WebSocket for 10 s, `-- --fmp` to spend one FMP call.

## Using it
1. **Import:** drop one or more CSV or `.xlsx` files. Each is parsed into a review table. Fix any value, untick rows you do not want, rename accounts, or map an account to one you already have. Press **Import**; nothing is saved before that.
2. **Overview:** total value, a freshness bar showing how much of the total rests on each kind of price, allocation by asset class, sector, geography, instrument and account, and data-quality warnings.
3. **Holdings:** every holding with price, price status, quote time and source. Open a row to see its lots per account and to set or change its classification.
4. **Manual assets:** physical gold and silver, real estate and anything else without a market price.
5. **Data & limits:** market status, provider limits and licensing, price-service health, the meaning of each label, current limitations.

### Supported file layouts
- A single-account positions export with a title line ("Positions for account ... as of ...") followed by a table and a totals row.
- A multi-account positions export (account number, name, symbol, quantity, last price, current value, cost basis, type) with a disclaimer footer.
- Any CSV or Excel table with a symbol column and a quantity column; common header names are matched and every row is flagged for review.
Adding a layout means adding one function in `src/server/parsers/index.ts` and a fixture under `tests/fixtures/`.

## How double-counting is prevented
Each file is a **snapshot of an account**. A newer snapshot replaces that account's earlier positions, an older one is kept but not applied, and the same file cannot be imported twice.
Repeated lines in one file are excluded by default; margin and cash lots of one symbol are summed as one holding. An account that looks like an existing one triggers a warning and a one-click mapping.

## Price freshness labels
**Real-time** (provider-confirmed entitlement and a fresh trade) · **Delayed** (provider-declared) · **End of day** (last close of the latest session) · **Stale** (older, or from your file) · **Unavailable**.
Older quotes never overwrite newer ones, and an outage keeps the last valid price. See [docs/SPEC.md](docs/SPEC.md) section 3.

## Project layout
```
src/server/   money, fx, calendar, parsers/, imports, classification, valuation (pure), quotes (ingest + freshness),
              providers/ (alpaca, fmp, synthetic behind one interface), scheduler, portfolio, app (REST + SSE), demo
src/shared/   types shared with the web app
web/          React + Vite app (builds to web/dist, served by the API server)
tests/        104 automated tests and synthetic fixtures
scripts/      check-provider
docs/         SPEC.md, PROVIDERS.md
```
Calculation code (`valuation.ts`, `fx.ts`, `quotes.ts`) is pure and contains no AI. A later explanation layer may read its outputs but must not change them.

## Tests
`npm test` runs 104 tests: duplicate imports, reconciliation (every view sums to the same total and to the files' stated totals), classification, currency conversion,
price updates (out-of-order quotes, outages, backoff, rate limit, fallback), provider adapters with mocked HTTP and WebSocket, the market calendar, and the API end to end.
`npm run typecheck` runs the TypeScript compiler. All fixtures are synthetic: they reproduce file layouts with made-up numbers.

## Data and security
- API keys live only in `.env` on the server side. The browser never receives them and `/api/meta` is tested to leak none.
- `.env`, `data/`, uploads and brokerage-style `*Positions*.csv` files are git-ignored. Do not commit real exports.
- The server listens on 127.0.0.1 only and has no login, which is appropriate for local use only. **Add authentication before hosting it anywhere.**
- Raw account numbers are not stored (a hash is the key, the last four characters are display-only).
- To start over, stop the app and delete `data/live.sqlite*`.

## Known limitations
- Prices on the free plan are IEX-only (one exchange). Thinly traded symbols can show old trades and will be labelled Stale.
- Mutual funds, money-market funds and anything the providers do not return are valued from your imported file's price and labelled "From file".
- US holdings only. FX conversion is implemented and tested but has no automatic rate feed; rates can be entered through the API (`PUT /api/fx/:currency`).
- The market-hours calendar covers 2026 and 2027; outside those years status is approximate and the app says so. Review the holiday list yearly.
- Sector and geography come from a small built-in reference list plus your overrides. Anything else is flagged, not guessed.
- No cost-basis lots, realized gains, dividends or performance history. Gain is shown only where every lot has a cost basis in the file.
- A committed import cannot be undone from the screen; importing a newer snapshot supersedes it, or delete the database file.
- Single user, no authentication, SQLite file storage.

## Verified and not yet verified
Verified here: the full automated suite, type checking, the production build, the demo server end to end over HTTP, and a server-side render of every screen against live demo data.
**Not verified in this environment:** calls to Alpaca and FMP (the build sandbox cannot reach them; adapters are tested against mocked responses only), the FMP free-plan endpoint, and the screens in an actual browser.
Run `npm run check:provider` with your keys and open the app once to close those gaps.
