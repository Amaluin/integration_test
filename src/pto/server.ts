import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { nextNumber, openDb } from '../shared/db';
import type { Row } from '../shared/db';
import { makeEvent } from '../shared/events';
import { addToOutbox, initOutbox, outboxStats, startRelay } from '../shared/outbox';
import type { Item, MaterialNeedSubmitted } from '../shared/types';

export interface PtoOptions {
  port: number;
  dbPath: string;
  hubUrl: string;
  token: string;
  relayIntervalMs?: number;
  logger?: boolean;
}

export async function startPto(opts: PtoOptions) {
  const db = openDb(opts.dbPath);
  db.exec(`
    create table if not exists needs (
      need_id     text primary key,
      version     integer not null,
      project_id  text not null,
      required_by text not null,
      items       text not null,
      created_at  text not null
    );
  `);
  initOutbox(db);

  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(cors, { origin: true });
  app.get('/health', async () => ({ ok: true }));

  // Потребность и событие для связующего сервиса сохраняются в одной транзакции (outbox).
  // Если связующий сервис недоступен, пользователь всё равно может работать.
  app.post('/api/needs', async (req, reply) => {
    const body = (req.body ?? {}) as Row;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (typeof body.projectId !== 'string' || !body.projectId.trim()) {
      return reply.code(400).send({ error: 'projectId is required' });
    }
    if (rawItems.length === 0) return reply.code(400).send({ error: 'at least one item is required' });
    const items: Item[] = [];
    for (const [i, raw] of rawItems.entries()) {
      if (typeof raw.material !== 'string' || !raw.material.trim() || !(Number(raw.quantity) > 0)) {
        return reply.code(400).send({ error: `item ${i + 1}: material and positive quantity are required` });
      }
      items.push({
        line: i + 1,
        material: raw.material.trim(),
        quantity: Number(raw.quantity),
        unit: typeof raw.unit === 'string' && raw.unit ? raw.unit : 'т',
      });
    }

    const needId = nextNumber(db, 'needs', 'NEED');
    const requiredBy =
      typeof body.requiredBy === 'string' && body.requiredBy
        ? body.requiredBy
        : new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    const data: MaterialNeedSubmitted = {
      needId,
      needVersion: 1,
      projectId: body.projectId.trim(),
      requiredBy,
      items,
    };

    db.transaction(() => {
      db.prepare(
        'insert into needs (need_id, version, project_id, required_by, items, created_at) values (?, ?, ?, ?, ?, ?)',
      ).run(needId, 1, data.projectId, requiredBy, JSON.stringify(items), new Date().toISOString());
      addToOutbox(db, makeEvent('pto', 'MaterialNeedSubmitted', needId, 1, data));
    })();
    return reply.code(201).send({ needId });
  });

  // Статус процесса приложение не хранит, а запрашивает у связующего сервиса.
  // Если тот недоступен, список потребностей всё равно открывается.
  app.get('/api/needs', async () => {
    const needs = (db.prepare('select * from needs order by rowid desc').all() as Row[]).map((n) => ({
      needId: n.need_id,
      projectId: n.project_id,
      requiredBy: n.required_by,
      items: JSON.parse(n.items),
      createdAt: n.created_at,
    }));
    let flows: Row[] | null = null;
    try {
      const res = await fetch(`${opts.hubUrl}/v1/flows`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) flows = (await res.json()) as Row[];
    } catch {
      flows = null;
    }
    return {
      hubAvailable: flows !== null,
      outbox: outboxStats(db),
      needs: needs.map((n) => ({
        ...n,
        flow: flows?.find((f) => f.needId === n.needId) ?? null,
      })),
    };
  });

  const relay = startRelay({
    db,
    hubUrl: opts.hubUrl,
    token: opts.token,
    intervalMs: opts.relayIntervalMs,
  });

  await app.listen({ port: opts.port, host: '0.0.0.0' });
  const port = (app.server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    async close() {
      await relay.stop();
      await app.close();
      db.close();
    },
  };
}
