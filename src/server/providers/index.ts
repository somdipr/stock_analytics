import type { Config } from '../config.js';
import { AlpacaProvider } from './alpaca.js';
import { FmpProvider } from './fmp.js';
import { SyntheticProvider } from './synthetic.js';
import type { MarketDataProvider } from './types.js';

export interface Providers { intraday: MarketDataProvider | null; eod: MarketDataProvider | null }
export function createProviders(cfg: Config): Providers {
  if (cfg.mode === 'demo') return { intraday: new SyntheticProvider('demo'), eod: null };
  return {
    intraday: cfg.alpaca.enabled ? new AlpacaProvider({ keyId: cfg.alpaca.keyId, secretKey: cfg.alpaca.secretKey, feed: cfg.alpaca.feed }) : null,
    eod: cfg.fmp.enabled ? new FmpProvider({ apiKey: cfg.fmp.apiKey, dailyBudget: cfg.fmp.dailyBudget }) : null,
  };
}
