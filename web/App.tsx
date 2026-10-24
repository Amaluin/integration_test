import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { FLOW_STATUS_RU } from '../src/shared/types';
import type { FlowStatus } from '../src/shared/types';

const env = import.meta.env;
const URLS = {
  hub: env.VITE_HUB_URL ?? 'http://localhost:3000',
  pto: env.VITE_PTO_URL ?? 'http://localhost:3001',
  estimate: env.VITE_ESTIMATE_URL ?? 'http://localhost:3002',
  supply: env.VITE_SUPPLY_URL ?? 'http://localhost:3003',
};

type Json = any;

const SUPPLY_STATUS_RU: Record<string, string> = {
  CREATED: 'Создана',
  ORDERED: 'Заказано',
  DELIVERED: 'Поставлено',
};
const DECISION_RU: Record<string, string> = {
  APPROVED: 'Одобрено',
  PARTIALLY_APPROVED: 'Одобрено частично',
  REJECTED: 'Отклонено',
};

function usePoll<T = Json>(url: string, intervalMs = 1000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(String(res.status));
        const json = await res.json();
        if (alive) {
          setData(json);
          setError(false);
        }
      } catch {
        if (alive) setError(true);
      }
    };
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [url, intervalMs]);
  return { data, error };
}

async function send(url: string, body: unknown) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      alert(json.error ?? `Ошибка ${res.status}`);
    }
  } catch {
    alert('Сервис недоступен');
  }
}

function Panel(props: { title: string; subtitle: string; down?: boolean; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="panel">
      <header>
        <div>
          <h2>{props.title}</h2>
          <p>{props.subtitle}</p>
        </div>
        {props.down && <span className="badge bad">сервис недоступен</span>}
      </header>
      {props.actions}
      <div className="body">{props.children}</div>
    </section>
  );
}

function Chaos({ base }: { base: string }) {
  const { data } = usePoll<{ mode: string }>(`${base}/admin/chaos`);
  const modes: [string, string][] = [
    ['ok', 'Работает'],
    ['down', 'Отключить'],
    ['drop-response', 'Потерять ответ'],
  ];
  return (
    <div className="chaos">
      <span>Имитация сбоя:</span>
      {modes.map(([mode, label]) => (
        <button
          key={mode}
          className={data?.mode === mode ? 'active' : ''}
          onClick={() => send(`${base}/admin/chaos`, { mode })}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Outbox({ pending }: { pending?: number }) {
  if (!pending) return null;
  return <div className="note warn">Не передано в связующий сервис: {pending} (сохранено, уйдёт при восстановлении связи)</div>;
}

function FlowBadge({ status }: { status: FlowStatus }) {
  return <span className={`badge ${status}`}>{FLOW_STATUS_RU[status]}</span>;
}

function PtoPanel() {
  const { data, error } = usePoll<Json>(`${URLS.pto}/api/needs`);
  const [projectId, setProjectId] = useState('OBJ-0102');
  const [material, setMaterial] = useState('Арматура А500С ø12');
  const [quantity, setQuantity] = useState(12);
  const [unit, setUnit] = useState('т');

  return (
    <Panel title="ПТО" subtitle="Формирует потребность в материалах" down={error}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          send(`${URLS.pto}/api/needs`, { projectId, items: [{ material, quantity, unit }] });
        }}
      >
        <input value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="Объект" />
        <input value={material} onChange={(e) => setMaterial(e.target.value)} placeholder="Материал" />
        <input type="number" min="0" step="any" value={quantity} onChange={(e) => setQuantity(Number(e.target.value))} />
        <input value={unit} onChange={(e) => setUnit(e.target.value)} />
        <button type="submit" className="primary">Подать потребность</button>
      </form>
      <Outbox pending={data?.outbox?.pending} />
      {data && !data.hubAvailable && <div className="note warn">Связующий сервис недоступен: статусы не обновляются</div>}
      {data?.needs.map((n: Json) => (
        <div className="card" key={n.needId}>
          <div className="row">
            <b>{n.needId}</b>
            {n.flow ? (
              <FlowBadge status={n.flow.status} />
            ) : (
              <span className="badge">{data.hubAvailable ? 'Ожидает передачи' : 'Статус неизвестен'}</span>
            )}
          </div>
          <div className="muted">
            {n.projectId} · {n.items.map((i: Json) => `${i.material}: ${i.quantity} ${i.unit}`).join('; ')}
          </div>
          {n.flow?.procurementId && <div className="muted">Заявка {n.flow.procurementId}</div>}
        </div>
      ))}
    </Panel>
  );
}

function ReviewCard({ review }: { review: Json }) {
  const [qty, setQty] = useState<Record<number, number>>(
    Object.fromEntries(review.items.map((i: Json) => [i.line, i.quantity])),
  );
  const pending = review.status === 'PENDING';
  return (
    <div className="card">
      <div className="row">
        <b>{review.reviewId}</b>
        <span className={`badge ${pending ? 'wait' : review.decision}`}>
          {pending ? 'Ждёт решения' : DECISION_RU[review.decision]}
        </span>
      </div>
      <div className="muted">Потребность {review.needId} · {review.projectId}</div>
      {review.items.map((i: Json) => {
        const decided = review.decidedItems?.find((d: Json) => d.line === i.line);
        return (
          <div className="row item" key={i.line}>
            <span>{i.material}: запрошено {i.quantity} {i.unit}</span>
            {pending ? (
              <input
                type="number"
                min="0"
                max={i.quantity}
                step="any"
                value={qty[i.line]}
                onChange={(e) => setQty({ ...qty, [i.line]: Number(e.target.value) })}
              />
            ) : (
              <b>одобрено {decided?.approvedQuantity}</b>
            )}
          </div>
        );
      })}
      {pending && (
        <div className="row">
          <button
            className="primary"
            onClick={() =>
              send(`${URLS.estimate}/api/reviews/${review.reviewId}/decision`, {
                items: review.items.map((i: Json) => ({ line: i.line, approvedQuantity: qty[i.line] })),
              })
            }
          >
            Принять решение
          </button>
          <button
            onClick={() =>
              send(`${URLS.estimate}/api/reviews/${review.reviewId}/decision`, {
                items: review.items.map((i: Json) => ({ line: i.line, approvedQuantity: 0 })),
              })
            }
          >
            Отклонить
          </button>
        </div>
      )}
    </div>
  );
}

function EstimatePanel() {
  const { data, error } = usePoll<Json>(`${URLS.estimate}/api/reviews`);
  return (
    <Panel
      title="Сметный отдел"
      subtitle="Проверяет потребность, указывает одобренное количество"
      down={error}
      actions={<Chaos base={URLS.estimate} />}
    >
      <Outbox pending={data?.outbox?.pending} />
      {data?.reviews.map((r: Json) => <ReviewCard key={r.reviewId} review={r} />)}
      {data?.reviews.length === 0 && <div className="muted">Запросов на проверку пока нет</div>}
    </Panel>
  );
}

function SupplyPanel() {
  const { data, error } = usePoll<Json>(`${URLS.supply}/api/procurement-requests`);
  return (
    <Panel
      title="Снабжение"
      subtitle="Создаёт заявки на закупку и ведёт их статус"
      down={error}
      actions={<Chaos base={URLS.supply} />}
    >
      <Outbox pending={data?.outbox?.pending} />
      {data?.requests.map((r: Json) => (
        <div className="card" key={r.procurementId}>
          <div className="row">
            <b>{r.procurementId}</b>
            <span className={`badge ${r.status}`}>{SUPPLY_STATUS_RU[r.status]}</span>
          </div>
          <div className="muted">
            Потребность {r.needId} · {r.items.map((i: Json) => `${i.material}: ${i.quantity} ${i.unit}`).join('; ')}
          </div>
          {r.nextStatus && (
            <button onClick={() => send(`${URLS.supply}/api/procurement-requests/${r.procurementId}/status`, { status: r.nextStatus })}>
              Отметить: {SUPPLY_STATUS_RU[r.nextStatus]}
            </button>
          )}
        </div>
      ))}
      {data?.requests.length === 0 && <div className="muted">Заявок пока нет</div>}
    </Panel>
  );
}

function HubPanel() {
  const flows = usePoll<Json[]>(`${URLS.hub}/v1/flows`);
  const open = usePoll<Json[]>(`${URLS.hub}/v1/commands/open`);
  return (
    <Panel title="Связующий сервис" subtitle="Ведёт процесс, повторяет передачу при сбоях" down={flows.error}>
      {open.data && open.data.length > 0 && (
        <div className="note warn">
          <b>Передача не завершена:</b>
          {open.data.map((c: Json) => (
            <div className="row" key={c.id}>
              <span>
                {c.target === 'estimate' ? 'Сметы' : 'Снабжение'} · {c.flowId} ·{' '}
                {c.status === 'needs_attention' ? 'нужен оператор' : `повторы: ${c.attempts}`}
                {c.lastError ? ` (${c.lastError})` : ''}
              </span>
              {c.status === 'needs_attention' && (
                <button onClick={() => send(`${URLS.hub}/v1/commands/${c.id}/retry`, {})}>Повторить</button>
              )}
            </div>
          ))}
        </div>
      )}
      {flows.data?.map((f: Json) => (
        <div className="card" key={f.flowId}>
          <div className="row">
            <b>{f.needId}</b>
            <FlowBadge status={f.status} />
          </div>
          <details>
            <summary>История ({f.history.length})</summary>
            <ul className="history">
              {f.history.map((h: Json, i: number) => (
                <li key={i}>
                  <time>{new Date(h.at).toLocaleTimeString('ru-RU')}</time> {h.message}
                </li>
              ))}
            </ul>
          </details>
        </div>
      ))}
      {flows.data?.length === 0 && <div className="muted">Процессов пока нет</div>}
    </Panel>
  );
}

export function App() {
  return (
    <main>
      <h1>ПТО → Сметы → Снабжение</h1>
      <p className="lead">
        Приложения общаются только через связующий сервис. Отключите сметы или снабжение кнопкой «Имитация сбоя» —
        процесс не потеряется и продолжится после восстановления.
      </p>
      <div className="grid">
        <PtoPanel />
        <EstimatePanel />
        <SupplyPanel />
        <HubPanel />
      </div>
    </main>
  );
}
