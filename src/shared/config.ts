import type { ServiceName } from './types';

// Заглушка вместо Keycloak: в реальной системе токены выдаёт Keycloak (client credentials).
export const DEFAULT_TOKENS: Record<ServiceName | 'hub', string> = {
  pto: 'dev-token-pto',
  estimate: 'dev-token-estimate',
  supply: 'dev-token-supply',
  hub: 'dev-token-hub',
};

export function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  return v ? Number.parseInt(v, 10) : fallback;
}
