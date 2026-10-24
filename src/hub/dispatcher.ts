import { postJson } from '../shared/http';
import type { Db, Row } from '../shared/db';

export interface RetryPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  tickMs: number;
  timeoutMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  baseMs: 1000,
  maxMs: 30_000,
  maxAttempts: 12,
  tickMs: 300,
  timeoutMs: 2000,
};

const TARGET_RU = { estimate: 'сметами', supply: 'снабжением' } as const;
const PATHS: Record<string, string> = {
  create_review: '/api/reviews',
  create_procurement: '/api/procurement-requests',
};

export interface DispatcherOptions {
  db: Db;
  urls: { estimate: string; supply: string };
  hubToken: string;
  retry: RetryPolicy;
}

const now = () => new Date().toISOString();

function history(db: Db, flowId: string, message: string) {
  db.prepare('insert into flow_history (flow_id, at, message) values (?, ?, ?)').run(flowId, now(), message);
}

function onSuccess(db: Db, cmd: Row, body: Row | null) {
  db.transaction(() => {
    db.prepare("update commands set status = 'done', last_error = null where id = ?").run(cmd.id);
    if (cmd.type === 'create_review') {
      db.prepare('update flows set review_id = ?, updated_at = ? where flow_id = ?').run(
        body?.reviewId ?? null,
        now(),
        cmd.flow_id,
      );
      history(db, cmd.flow_id, `Сметы приняли запрос на проверку (${body?.reviewId})`);
    } else if (cmd.type === 'create_procurement') {
      // статус «заявка создана» ставим, только если процесс не ушёл дальше (событие о заказе могло прийти раньше)
      db.prepare(
        `update flows set procurement_id = ?, updated_at = ?,
           status = case when status = 'PROCUREMENT_REQUESTED' then 'PROCUREMENT_CREATED' else status end
         where flow_id = ?`,
      ).run(body?.procurementId ?? null, now(), cmd.flow_id);
      history(db, cmd.flow_id, `Снабжение создало заявку ${body?.procurementId}`);
    }
  })();
}

function onFailure(db: Db, cmd: Row, error: string, retryable: boolean, retry: RetryPolicy) {
  const attempts = (cmd.attempts as number) + 1;
  const target = TARGET_RU[cmd.target as keyof typeof TARGET_RU];
  if (!retryable || attempts >= retry.maxAttempts) {
    db.prepare("update commands set status = 'needs_attention', attempts = ?, last_error = ? where id = ?").run(
      attempts,
      error,
      cmd.id,
    );
    history(db, cmd.flow_id, `Передача ${target} остановлена, нужно вмешательство оператора: ${error}`);
    return;
  }
  const delay = Math.min(retry.maxMs, retry.baseMs * 2 ** (attempts - 1)) * (0.8 + Math.random() * 0.4);
  db.prepare('update commands set attempts = ?, last_error = ?, next_attempt_at = ? where id = ?').run(
    attempts,
    error,
    Date.now() + Math.round(delay),
    cmd.id,
  );
  history(
    db,
    cmd.flow_id,
    `Не удалось связаться со ${target} (${error}). Повтор через ${Math.round(delay / 1000)} с, попытка ${attempts}`,
  );
}

// Берёт готовые к отправке команды и отправляет их получателям с ключом идемпотентности.
// Временные ошибки (сеть, таймаут, 5xx, 429) — повтор с нарастающей паузой; ошибки данных (4xx) — к оператору.
export function startDispatcher(opts: DispatcherOptions) {
  const { db, urls, hubToken, retry } = opts;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> = Promise.resolve();

  async function sendOne(cmd: Row) {
    const base = cmd.target === 'estimate' ? urls.estimate : urls.supply;
    try {
      const res = await postJson(
        base + PATHS[cmd.type],
        JSON.parse(cmd.payload),
        {
          authorization: `Bearer ${hubToken}`,
          'idempotency-key': cmd.idempotency_key,
          'x-correlation-id': cmd.flow_id,
        },
        retry.timeoutMs,
      );
      if (res.status >= 200 && res.status < 300) onSuccess(db, cmd, res.body);
      else if (res.status === 429 || res.status >= 500) onFailure(db, cmd, `HTTP ${res.status}`, true, retry);
      else onFailure(db, cmd, `HTTP ${res.status}: ${JSON.stringify(res.body)}`, false, retry);
    } catch (err) {
      onFailure(db, cmd, (err as Error).message, true, retry);
    }
  }

  async function tick() {
    const due = db
      .prepare("select * from commands where status = 'pending' and next_attempt_at <= ? order by id limit 10")
      .all(Date.now()) as Row[];
    for (const cmd of due) {
      if (stopped) return;
      await sendOne(cmd);
    }
  }

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      inflight = tick().catch(() => {}).finally(schedule);
    }, retry.tickMs);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inflight;
    },
  };
}
