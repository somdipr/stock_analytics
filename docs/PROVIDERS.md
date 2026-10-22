# Market-data providers: free-tier facts, limits and licensing

> Figures were gathered from provider documentation excerpts and third-party summaries during planning, not from the providers' current
> legal terms. Plans change. **Re-check each provider's own pricing and terms pages before relying on a number, and before sharing or hosting anything.**
> This is not legal advice. `npm run check:provider` verifies what your own keys can actually do today.

## Decision
| | Alpaca Basic (free) | Financial Modeling Prep (free) | Alpha Vantage (free) |
|---|---|---|---|
| Role in this app | **Primary** intraday prices | Optional end-of-day fallback | Not used |
| Assets | US stocks and ETFs (also crypto, options indicative) | US symbols, end-of-day | US equities, FX, crypto, many endpoints |
| Exchange coverage | IEX only on the free plan (single venue, not the consolidated tape) | US listings | US |
| Freshness | Real-time IEX trades; recent SIP data is blocked on the free plan | End-of-day | No real-time or delayed US data on the free tier |
| Streaming | WebSocket, about 30 symbols, one connection per account | None | None |
| Rate limit | About 200 calls/min (market data) | About 250 calls/day | About 25 calls/day and 5/min |
| History | Available through the data API | About 5 years | Available, within call limits |
| Paid step (never taken automatically) | Algo Trader Plus (all US exchanges), around $99/month | Starter around $29/month for real-time | Real-time tiers from around $100/month |

Why Alpaca: it is the only candidate that gives free intraday prices, streaming, and a rate limit that fits a 30-60 second refresh.
The trade-off is IEX-only data: last-trade prices of thinly traded symbols can be minutes old during market hours, and those are labelled **Stale** honestly instead of being called real-time.

## Alpaca
- **Credentials:** `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` in `.env`. Paper-trading keys are sufficient; the app never places orders.
- **Endpoints used:** `GET /v2/stocks/snapshots?symbols=...&feed=iex` (polling) and `wss://stream.data.alpaca.markets/v2/iex` (trades, largest holdings up to the symbol cap).
- **Real-time claim:** made only after an authenticated call on the IEX feed succeeds **and** the trade timestamp is fresher than `REALTIME_MAX_AGE_SECONDS`.
- **Streaming limits:** the app subscribes to at most 30 symbols, opens one connection, and stops (does not retry) on a connection-limit or auth error. All other symbols are polled.
- **Licensing:** free-plan data is for your own use. SIP (consolidated) data cannot be redistributed without a paid data subscription. Review Alpaca's Market Data Agreement for display and attribution requirements before any hosted or shared version.

## Financial Modeling Prep (fallback)
- **Credentials:** `FMP_API_KEY`. Each symbol is one call; `FMP_DAILY_CALL_BUDGET` (default 200 of 250) is a hard stop and a symbol is tried at most once per UTC day.
- **Used only** for symbols the intraday provider does not return. A restricted endpoint or empty answer leaves the symbol on its file price; no price is invented.
- **Endpoint:** `/stable/historical-price-eod/light`. Whether the free plan allows it can change: confirm with `npm run check:provider -- --fmp`.
- **Licensing:** the free plan is personal use. Display or redistribution to others needs a commercial licence.

## Alpha Vantage
Not integrated. Its free tier (about 25 calls/day) cannot support a 30-60 second refresh and excludes real-time and delayed US data. Adding it later means writing one `MarketDataProvider` adapter.

## Replacing or adding a provider
Implement `MarketDataProvider` (`getSnapshots`, optional `getEodCloses` and `stream`, plus `capabilities()` describing feed, limits and licensing) in `src/server/providers/` and register it in `providers/index.ts`.
Nothing else needs to change: ingest rules, freshness labelling and valuation are provider-neutral.
