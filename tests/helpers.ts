import net from 'node:net';
import { startEstimate } from '../src/estimate/server';
import { startHub } from '../src/hub/server';
import { startPto } from '../src/pto/server';
import { startSupply } from '../src/supply/server';
import { DEFAULT_TOKENS } from '../src/shared/config';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 8000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${label}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

export const getJson = async (url: string) => (await fetch(url)).json() as Promise<any>;

// Поднимает весь стенд в одном процессе. Связующий сервис можно не запускать (hubAutostart: false)
// и поднять позже — так проверяется работа при его недоступности.
export async function startStack(options: { hubAutostart?: boolean } = {}) {
  const ports = {
    hub: await freePort(),
    pto: await freePort(),
    estimate: await freePort(),
    supply: await freePort(),
  };
  const hubUrl = `http://127.0.0.1:${ports.hub}`;
  const relayIntervalMs = 40;

  const startHubNow = () =>
    startHub({
      port: ports.hub,
      dbPath: ':memory:',
      serviceTokens: { pto: DEFAULT_TOKENS.pto, estimate: DEFAULT_TOKENS.estimate, supply: DEFAULT_TOKENS.supply },
      hubToken: DEFAULT_TOKENS.hub,
      urls: {
        estimate: `http://127.0.0.1:${ports.estimate}`,
        supply: `http://127.0.0.1:${ports.supply}`,
      },
      retry: { baseMs: 40, maxMs: 150, maxAttempts: 100, tickMs: 25, timeoutMs: 500 },
    });

  let hub = options.hubAutostart === false ? null : await startHubNow();
  const pto = await startPto({
    port: ports.pto,
    dbPath: ':memory:',
    hubUrl,
    token: DEFAULT_TOKENS.pto,
    relayIntervalMs,
  });
  const estimate = await startEstimate({
    port: ports.estimate,
    dbPath: ':memory:',
    hubUrl,
    token: DEFAULT_TOKENS.estimate,
    hubToken: DEFAULT_TOKENS.hub,
    relayIntervalMs,
  });
  const supply = await startSupply({
    port: ports.supply,
    dbPath: ':memory:',
    hubUrl,
    token: DEFAULT_TOKENS.supply,
    hubToken: DEFAULT_TOKENS.hub,
    relayIntervalMs,
  });

  return {
    hubUrl,
    get hub() {
      if (!hub) throw new Error('hub is not running');
      return hub;
    },
    pto,
    estimate,
    supply,
    async startHub() {
      hub = await startHubNow();
    },
    async close() {
      await Promise.all([pto.close(), estimate.close(), supply.close(), hub?.close()]);
    },
  };
}

export type Stack = Awaited<ReturnType<typeof startStack>>;

export async function createNeed(stack: Stack, quantity = 12) {
  const res = await post(`${stack.pto.url}/api/needs`, {
    projectId: 'OBJ-0102',
    requiredBy: '2026-11-15',
    items: [{ material: 'Арматура А500С ø12', quantity, unit: 'т' }],
  });
  if (res.status !== 201) throw new Error(`create need failed: ${res.status}`);
  return ((await res.json()) as { needId: string }).needId;
}

export const flowOf = async (stack: Stack, needId: string) =>
  (await getJson(`${stack.hubUrl}/v1/flows`)).find((f: any) => f.needId === needId) ?? null;

export const waitForStatus = (stack: Stack, needId: string, status: string) =>
  waitFor(async () => (await flowOf(stack, needId))?.status === status, 8000, `flow ${needId} → ${status}`);

export async function decide(stack: Stack, needId: string, approvedQuantity: number) {
  await waitFor(
    async () => (await getJson(`${stack.estimate.url}/api/reviews`)).reviews.some((r: any) => r.needId === needId),
    8000,
    'review at estimate',
  );
  const { reviews } = await getJson(`${stack.estimate.url}/api/reviews`);
  const review = reviews.find((r: any) => r.needId === needId);
  const res = await post(`${stack.estimate.url}/api/reviews/${review.reviewId}/decision`, {
    items: [{ line: 1, approvedQuantity }],
  });
  if (res.status !== 200) throw new Error(`decision failed: ${res.status}`);
  return review.reviewId as string;
}

export const count = (db: { prepare: (sql: string) => { get: () => unknown } }, table: string) =>
  (db.prepare(`select count(*) as c from ${table}`).get() as { c: number }).c;

export const setChaos = (url: string, mode: string) => post(`${url}/admin/chaos`, { mode });
