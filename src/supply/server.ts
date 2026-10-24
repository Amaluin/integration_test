import cors from '@fastify/cors';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { bearerAuth } from '../shared/auth';
import { registerChaos } from '../shared/chaos';
import { nextNumber, openDb } from '../shared/db';
import type { Db, Row } from '../shared/db';
import { makeEvent } from '../shared/events';
import { addToOutbox, initOutbox, outboxStats, startRelay } from '../shared/outbox';
import type { Item, ProcurementStatus, ProcurementStatusChanged } from '../shared/types';

export interface SupplyOptions {
  port: number;
  dbPath: string;
  hubUrl: string;
  token: string;
  hubToken: string;
  relayIntervalMs?: number;
  logger?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const NEXT_STATUS: Record<ProcurementStatus, ProcurementStatus | null> = {
  CREATED: 'ORDERED',
  ORDERED: 'DELIVERED',
  DELIVERED: null,
};

// Изменение статуса и событие — в одной транзакции; версия растёт на каждое изменение заявки.
function saveStatus(db: Db, request: Row, status: ProcurementStatus, version: number) {
  addToOutbox(
    db,
    makeEvent<ProcurementStatusChanged>('supply', 'ProcurementStatusChanged', request.procurement_id, version, {
      procurementId: request.procurement_id,
      needId: request.need_id,
      needVersion: request.need_version,
      status,
    }),
  );
}

export async function startSupply(opts: SupplyOptions) {
  const db = openDb(opts.dbPath);
  db.exec(`
    create table if not exists requests (
      procurement_id  text primary key,
      idempotency_key text not null unique,
      request_hash    text not null,
      need_id         text not null,
      need_version    integer not null,
      project_id      text not null,
      required_by     text,
      items           text not null,
      status          text not null,
      version         integer not null,
      created_at      text not null
    );
  `);
  initOutbox(db);

  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(cors, { origin: true });
  const chaos = registerChaos(app);
  let replays = 0; // сколько раз повторный запрос узнали по ключу и не создали дубль (с момента запуска)
  app.get('/health', async () => ({ ok: true }));

  // Создание заявки по команде связующего сервиса. Защита от дублей:
  // тот же ключ и то же тело — возвращаем уже созданную заявку; тот же ключ с другим телом — 409.
  app.post('/api/procurement-requests', { preHandler: bearerAuth(opts.hubToken) }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ error: 'Idempotency-Key header is required' });
    const body = (req.body ?? {}) as Row;
    if (typeof body.needId !== 'string' || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.code(400).send({ error: 'needId and items are required' });
    }
    const hash = sha(JSON.stringify(body));
    const existing = db.prepare('select * from requests where idempotency_key = ?').get(key) as Row | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        return reply.code(409).send({ error: 'Idempotency-Key was already used with a different request' });
      }
      replays++;
      return reply.code(200).send({ procurementId: existing.procurement_id });
    }

    const procurementId = nextNumber(db, 'requests', 'PR');
    db.transaction(() => {
      db.prepare(
        `insert into requests
           (procurement_id, idempotency_key, request_hash, need_id, need_version, project_id, required_by, items, status, version, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', 1, ?)`,
      ).run(
        procurementId,
        key,
        hash,
        body.needId,
        body.needVersion ?? 1,
        body.projectId ?? '',
        body.requiredBy ?? null,
        JSON.stringify(body.items),
        new Date().toISOString(),
      );
      saveStatus(db, { procurement_id: procurementId, need_id: body.needId, need_version: body.needVersion ?? 1 }, 'CREATED', 1);
    })();

    // имитация сбоя: заявка создана, а ответ до отправителя не дошёл
    if (chaos.takeDropResponse()) {
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return reply.code(201).send({ procurementId });
  });

  const requestView = (r: Row) => ({
    procurementId: r.procurement_id,
    needId: r.need_id,
    needVersion: r.need_version,
    projectId: r.project_id,
    requiredBy: r.required_by,
    items: JSON.parse(r.items) as Item[],
    status: r.status as ProcurementStatus,
    nextStatus: NEXT_STATUS[r.status as ProcurementStatus],
    createdAt: r.created_at,
  });

  app.get('/api/procurement-requests', async () => ({
    outbox: outboxStats(db),
    replays,
    requests: (db.prepare('select * from requests order by rowid desc').all() as Row[]).map(requestView),
  }));

  // Снабженец двигает заявку по статусам: создана → заказана → поставлена.
  app.post('/api/procurement-requests/:id/status', async (req, reply) => {
    const request = db.prepare('select * from requests where procurement_id = ?').get((req.params as Row).id) as
      | Row
      | undefined;
    if (!request) return reply.code(404).send({ error: 'request not found' });
    const status = ((req.body ?? {}) as Row).status as ProcurementStatus;
    if (NEXT_STATUS[request.status as ProcurementStatus] !== status) {
      return reply.code(409).send({ error: `cannot move from ${request.status} to ${status}` });
    }
    const version = (request.version as number) + 1;
    db.transaction(() => {
      db.prepare('update requests set status = ?, version = ? where procurement_id = ?').run(
        status,
        version,
        request.procurement_id,
      );
      saveStatus(db, request, status, version);
    })();
    return { status, version };
  });

  const relay = startRelay({ db, hubUrl: opts.hubUrl, token: opts.token, intervalMs: opts.relayIntervalMs });

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
