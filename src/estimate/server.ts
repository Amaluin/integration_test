import cors from '@fastify/cors';
import Fastify from 'fastify';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { bearerAuth } from '../shared/auth';
import { registerChaos } from '../shared/chaos';
import { nextNumber, openDb } from '../shared/db';
import type { Row } from '../shared/db';
import { makeEvent } from '../shared/events';
import { addToOutbox, initOutbox, outboxStats, startRelay } from '../shared/outbox';
import type { EstimateReviewCompleted, Item, ReviewDecision } from '../shared/types';

export interface EstimateOptions {
  port: number;
  dbPath: string;
  hubUrl: string;
  token: string; // токен этого сервиса для отправки событий в связующий сервис
  hubToken: string; // токен, который должен предъявлять связующий сервис, вызывая нас
  relayIntervalMs?: number;
  logger?: boolean;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export async function startEstimate(opts: EstimateOptions) {
  const db = openDb(opts.dbPath);
  db.exec(`
    create table if not exists reviews (
      review_id       text primary key,
      idempotency_key text not null unique,
      request_hash    text not null,
      need_id         text not null,
      need_version    integer not null,
      project_id      text not null,
      required_by     text,
      items           text not null,
      status          text not null default 'PENDING',
      decision        text,
      decided_items   text,
      created_at      text not null
    );
  `);
  initOutbox(db);

  const app = Fastify({ logger: opts.logger ? { level: 'info' } : false });
  await app.register(cors, { origin: true });
  const chaos = registerChaos(app);
  let replays = 0; // сколько раз повторный запрос узнали по ключу и не создали дубль (с момента запуска)
  app.get('/health', async () => ({ ok: true }));

  // Команда от связующего сервиса. Повтор с тем же ключом возвращает уже созданную проверку.
  app.post('/api/reviews', { preHandler: bearerAuth(opts.hubToken) }, async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || !key) return reply.code(400).send({ error: 'Idempotency-Key header is required' });
    const body = (req.body ?? {}) as Row;
    if (typeof body.needId !== 'string' || !Array.isArray(body.items) || body.items.length === 0) {
      return reply.code(400).send({ error: 'needId and items are required' });
    }
    const hash = sha(JSON.stringify(body));
    const existing = db.prepare('select * from reviews where idempotency_key = ?').get(key) as Row | undefined;
    if (existing) {
      if (existing.request_hash !== hash) {
        return reply.code(409).send({ error: 'Idempotency-Key was already used with a different request' });
      }
      replays++;
      return reply.code(200).send({ reviewId: existing.review_id });
    }
    const reviewId = nextNumber(db, 'reviews', 'REV');
    db.prepare(
      `insert into reviews (review_id, idempotency_key, request_hash, need_id, need_version, project_id, required_by, items, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      reviewId,
      key,
      hash,
      body.needId,
      body.needVersion ?? 1,
      body.projectId ?? '',
      body.requiredBy ?? null,
      JSON.stringify(body.items),
      new Date().toISOString(),
    );

    // имитация сбоя: проверка создана, а ответ до отправителя не дошёл
    if (chaos.takeDropResponse()) {
      reply.hijack();
      req.raw.socket.destroy();
      return;
    }
    return reply.code(201).send({ reviewId });
  });

  const reviewView = (r: Row) => ({
    reviewId: r.review_id,
    needId: r.need_id,
    needVersion: r.need_version,
    projectId: r.project_id,
    requiredBy: r.required_by,
    items: JSON.parse(r.items) as Item[],
    status: r.status,
    decision: r.decision,
    decidedItems: r.decided_items ? JSON.parse(r.decided_items) : null,
    createdAt: r.created_at,
  });

  app.get('/api/reviews', async () => ({
    outbox: outboxStats(db),
    replays,
    reviews: (db.prepare('select * from reviews order by rowid desc').all() as Row[]).map(reviewView),
  }));

  // Решение сметчика по каждой позиции. Результат и событие сохраняются одной транзакцией.
  app.post('/api/reviews/:id/decision', async (req, reply) => {
    const review = db.prepare('select * from reviews where review_id = ?').get((req.params as Row).id) as
      | Row
      | undefined;
    if (!review) return reply.code(404).send({ error: 'review not found' });
    if (review.status === 'DONE') return reply.code(409).send({ error: 'decision was already made' });

    const requested = JSON.parse(review.items) as Item[];
    const input = ((req.body ?? {}) as Row).items;
    if (!Array.isArray(input)) return reply.code(400).send({ error: 'items are required' });

    const decided: EstimateReviewCompleted['items'] = [];
    for (const item of requested) {
      const row = input.find((x: Row) => x.line === item.line);
      const approved = Number(row?.approvedQuantity);
      if (!row || !Number.isFinite(approved) || approved < 0 || approved > item.quantity) {
        return reply
          .code(400)
          .send({ error: `line ${item.line}: approvedQuantity must be between 0 and ${item.quantity}` });
      }
      decided.push({ line: item.line, requestedQuantity: item.quantity, approvedQuantity: approved });
    }
    const decision: ReviewDecision = decided.every((d) => d.approvedQuantity === 0)
      ? 'REJECTED'
      : decided.every((d) => d.approvedQuantity === d.requestedQuantity)
        ? 'APPROVED'
        : 'PARTIALLY_APPROVED';

    db.transaction(() => {
      db.prepare("update reviews set status = 'DONE', decision = ?, decided_items = ? where review_id = ?").run(
        decision,
        JSON.stringify(decided),
        review.review_id,
      );
      addToOutbox(
        db,
        makeEvent<EstimateReviewCompleted>('estimate', 'EstimateReviewCompleted', review.review_id, 1, {
          reviewId: review.review_id,
          needId: review.need_id,
          needVersion: review.need_version,
          decision,
          items: decided,
        }),
      );
    })();
    return { decision };
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
