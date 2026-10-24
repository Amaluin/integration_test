import { postJson } from './http';
import type { Db, Row } from './db';
import type { Envelope } from './types';

export function initOutbox(db: Db) {
  db.exec(`
    create table if not exists outbox (
      seq        integer primary key autoincrement,
      id         text not null unique,
      payload    text not null,
      status     text not null default 'pending',
      attempts   integer not null default 0,
      last_error text,
      created_at text not null,
      sent_at    text
    );
  `);
}

// Вызывать в той же транзакции, что и бизнес-изменение: либо сохранено всё, либо ничего.
export function addToOutbox(db: Db, e: Envelope) {
  db.prepare('insert into outbox (id, payload, created_at) values (?, ?, ?)').run(
    e.id,
    JSON.stringify(e),
    new Date().toISOString(),
  );
}

export function outboxStats(db: Db) {
  const row = db
    .prepare("select count(*) as pending, min(created_at) as oldest from outbox where status = 'pending'")
    .get() as Row;
  return { pending: row.pending as number, oldestPendingAt: (row.oldest as string | null) ?? null };
}

export interface RelayOptions {
  db: Db;
  hubUrl: string;
  token: string;
  intervalMs?: number;
  timeoutMs?: number;
}

// Отправляет события из outbox в связующий сервис по порядку.
// Недоступность сервиса — не ошибка: запись остаётся в outbox и уйдёт позже.
export function startRelay(opts: RelayOptions) {
  const { db, hubUrl, token, intervalMs = 1000, timeoutMs = 2000 } = opts;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> = Promise.resolve();

  const markError = (seq: number, error: string) =>
    db.prepare('update outbox set attempts = attempts + 1, last_error = ? where seq = ?').run(error, seq);

  async function flush() {
    const rows = db
      .prepare("select seq, payload from outbox where status = 'pending' order by seq limit 50")
      .all() as Row[];
    for (const row of rows) {
      try {
        const res = await postJson(
          `${hubUrl}/v1/events`,
          JSON.parse(row.payload),
          { authorization: `Bearer ${token}` },
          timeoutMs,
        );
        if (res.status >= 200 && res.status < 300) {
          db.prepare("update outbox set status = 'sent', sent_at = ? where seq = ?").run(
            new Date().toISOString(),
            row.seq,
          );
        } else if (res.status === 429 || res.status === 409 || res.status >= 500) {
          markError(row.seq, `HTTP ${res.status}`);
          return; // временная проблема — порядок важен, пробуем позже с этой же записи
        } else {
          // постоянная ошибка контракта: не блокируем остальные события
          db.prepare("update outbox set status = 'rejected', last_error = ? where seq = ?").run(
            `HTTP ${res.status}: ${JSON.stringify(res.body)}`,
            row.seq,
          );
        }
      } catch (err) {
        markError(row.seq, (err as Error).message);
        return;
      }
    }
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inflight = flush().catch(() => {}).finally(schedule);
    }, intervalMs);
  };
  schedule();

  return {
    flush,
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inflight;
    },
  };
}
