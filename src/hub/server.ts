import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { AddressInfo } from 'node:net';
import { openDb } from '../shared/db';
import type { Row } from '../shared/db';
import { isEnvelope } from '../shared/events';
import type { ServiceName } from '../shared/types';
import { DEFAULT_RETRY, startDispatcher } from './dispatcher';
import type { RetryPolicy } from './dispatcher';
import { handleEvent, RetryLater } from './events';
import { initHubSchema } from './schema';

export interface HubOptions {
  port: number;
  dbPath: string;
  serviceTokens: Record<ServiceName, string>;
  hubToken: string;
  urls: { estimate: string; supply: string };
  retry?: Partial<RetryPolicy>;
  logger?: boolean;
}

export async function startHub(opts: HubOptions) {
  const db = openDb(opts.dbPath);
  initHubSchema(db);

  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(cors, { origin: true });

  const tokenToService = new Map<string, ServiceName>(
    (Object.entries(opts.serviceTokens) as [ServiceName, string][]).map(([name, token]) => [token, name]),
  );

  app.get('/health', async () => ({ ok: true }));

  // Приём событий от приложений. Токен определяет, кто отправитель; в событии источник должен совпадать.
  app.post('/v1/events', async (req, reply) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const service = tokenToService.get(token);
    if (!service) return reply.code(401).send({ error: 'unauthorized' });
    const event = req.body;
    if (!isEnvelope(event)) return reply.code(400).send({ error: 'invalid event envelope' });
    if (event.source !== service) {
      return reply.code(403).send({ error: `token of "${service}" cannot publish events of "${event.source}"` });
    }
    try {
      const result = handleEvent(db, event);
      return reply.code(result === 'applied' ? 202 : 200).send({ result });
    } catch (err) {
      if (err instanceof RetryLater) return reply.code(503).send({ error: err.message });
      throw err;
    }
  });

  const flowView = (row: Row) => ({
    flowId: row.flow_id,
    needId: row.need_id,
    needVersion: row.need_version,
    projectId: row.project_id,
    status: row.status,
    reviewId: row.review_id,
    procurementId: row.procurement_id,
    items: JSON.parse(row.need_json).items,
    approved: row.approved_json ? JSON.parse(row.approved_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    history: db.prepare('select at, message from flow_history where flow_id = ? order by id').all(row.flow_id),
  });

  // В прототипе статусы читаются без авторизации; в продуктивной системе — по токену пользователя.
  app.get('/v1/flows', async () =>
    (db.prepare('select * from flows order by created_at desc, rowid desc').all() as Row[]).map(flowView),
  );

  app.get('/v1/flows/:flowId', async (req, reply) => {
    const row = db.prepare('select * from flows where flow_id = ?').get((req.params as Row).flowId) as
      | Row
      | undefined;
    return row ? flowView(row) : reply.code(404).send({ error: 'not found' });
  });

  // Команды, которые ещё не доставлены: идут повторы или нужен оператор.
  app.get('/v1/commands/open', async () =>
    db
      .prepare(
        `select id, flow_id as flowId, type, target, status, attempts, last_error as lastError
         from commands where status != 'done' order by id`,
      )
      .all(),
  );

  app.post('/v1/commands/:id/retry', async (req, reply) => {
    const res = db
      .prepare("update commands set status = 'pending', attempts = 0, next_attempt_at = ? where id = ? and status = 'needs_attention'")
      .run(Date.now(), (req.params as Row).id);
    return res.changes ? { ok: true } : reply.code(404).send({ error: 'no such command in needs_attention' });
  });

  const dispatcher = startDispatcher({
    db,
    urls: opts.urls,
    hubToken: opts.hubToken,
    retry: { ...DEFAULT_RETRY, ...opts.retry },
  });

  await app.listen({ port: opts.port, host: '0.0.0.0' });
  const port = (app.server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    db,
    async close() {
      await dispatcher.stop();
      await app.close();
      db.close();
    },
  };
}
