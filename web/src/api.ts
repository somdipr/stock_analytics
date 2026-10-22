import type { PortfolioView } from '../../src/shared/types';

export class ApiError extends Error { constructor(message: string, public status: number, public body: any) { super(message); } }
export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const opts: RequestInit = { ...init };
  if (init?.json !== undefined) { opts.method = opts.method ?? 'POST'; opts.headers = { 'content-type': 'application/json' }; opts.body = JSON.stringify(init.json); }
  const res = await fetch(path, opts);
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export interface Meta {
  mode: 'live' | 'demo'; banner: string | null; refreshSeconds: number; realtimeMaxAgeSec: number; configNotes: string[]; limitations: string[];
  market: { state: string; label: string; lastCloseUtc: string; nextOpenUtc: string; calendarKnown: boolean };
  provider: ProviderInfo | null; eodProvider: ProviderInfo | null;
  health: { state: string; lastAttemptAt: string | null; lastSuccessAt: string | null; lastError: string | null; consecutiveFailures: number; stream: { state: string; detail?: string } | null; streamSymbols: number; fmpCallsRemaining: number | null } | null;
}
export interface ProviderInfo { id: string; label: string; realtime: boolean; feed: string | null; coverage: string; licensing: string; attribution: string; rateLimitPerMin: number | null; dailyCallBudget: number | null; maxStreamSymbols: number; notes: string[] }
export type { PortfolioView };
