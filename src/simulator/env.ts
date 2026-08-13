export interface SimulatorEnv {
  /** The receiver's BaseURL, path included. */
  RECEIVER_URL?: string;
  TOKEN_URL?: string;
  CLIENT_ID?: string;
  OAUTH_SCOPE?: string;
  DAILY_VOLUME?: string;
  CHAOS_RATE?: string;
  RETRY_COUNT?: string;

  /** Secrets. */
  CLIENT_SECRET?: string;
  SIM_ADMIN_TOKEN?: string;
}

export function receiverUrl(env: SimulatorEnv): string {
  return (env.RECEIVER_URL ?? 'http://localhost:8787/publications').replace(/\/+$/, '');
}

/** The receiver's origin, for reaching /admin without a second variable. */
export function receiverOrigin(env: SimulatorEnv): string {
  return new URL(receiverUrl(env)).origin;
}

export function dailyVolume(env: SimulatorEnv): number {
  const parsed = Number.parseInt(env.DAILY_VOLUME ?? '40', 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 40;
}

export function chaosRate(env: SimulatorEnv): number {
  const parsed = Number.parseFloat(env.CHAOS_RATE ?? '0.05');
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0.05;
}
