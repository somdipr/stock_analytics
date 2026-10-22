import { z } from 'zod';

const bool = (d: boolean) => z.string().optional().transform((v) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(v)));
const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  PORTFOLIO_MODE: z.enum(['live', 'demo']).default('live'),
  DATA_DIR: z.string().default('./data'),
  ALPACA_KEY_ID: z.string().default(''), ALPACA_SECRET_KEY: z.string().default(''),
  ALPACA_FEED: z.enum(['iex', 'sip']).default('iex'), ALPACA_STREAM: bool(true),
  FMP_API_KEY: z.string().default(''), FMP_DAILY_CALL_BUDGET: z.coerce.number().int().min(0).max(250).default(200),
  PRICE_PROVIDER: z.enum(['alpaca', 'none']).default('alpaca'),
  PRICE_REFRESH_SECONDS: z.coerce.number().default(45),
  REALTIME_MAX_AGE_SECONDS: z.coerce.number().min(30).default(300),
});
export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const c = schema.parse(env);
  const notes: string[] = [];
  let refresh = c.PRICE_REFRESH_SECONDS;
  if (refresh < 30) { notes.push(`PRICE_REFRESH_SECONDS=${refresh} is below the 30 s floor; using 30`); refresh = 30; }
  if (refresh > 300) { notes.push(`PRICE_REFRESH_SECONDS=${refresh} is above 300 s; using 300`); refresh = 300; }
  return {
    port: c.PORT, mode: c.PORTFOLIO_MODE, dataDir: c.DATA_DIR, dbFile: `${c.DATA_DIR}/${c.PORTFOLIO_MODE}.sqlite`,
    alpaca: { keyId: c.ALPACA_KEY_ID, secretKey: c.ALPACA_SECRET_KEY, feed: c.ALPACA_FEED, stream: c.ALPACA_STREAM, enabled: c.PRICE_PROVIDER === 'alpaca' && !!c.ALPACA_KEY_ID && !!c.ALPACA_SECRET_KEY },
    fmp: { apiKey: c.FMP_API_KEY, dailyBudget: c.FMP_DAILY_CALL_BUDGET, enabled: !!c.FMP_API_KEY },
    refreshSeconds: refresh, realtimeMaxAgeSec: c.REALTIME_MAX_AGE_SECONDS, notes,
  };
}
