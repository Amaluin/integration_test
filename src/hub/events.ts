import type { Db, Row } from '../shared/db';
import type {
  Envelope,
  EstimateReviewCompleted,
  FlowStatus,
  Item,
  MaterialNeedSubmitted,
  ProcurementStatusChanged,
} from '../shared/types';

export type EventResult = 'applied' | 'duplicate' | 'stale';

// Событие пришло раньше, чем появился процесс, которому оно адресовано: источник повторит позже.
export class RetryLater extends Error {}

const now = () => new Date().toISOString();

function addHistory(db: Db, flowId: string, message: string) {
  db.prepare('insert into flow_history (flow_id, at, message) values (?, ?, ?)').run(flowId, now(), message);
}

function setStatus(db: Db, flowId: string, status: FlowStatus, extra: Record<string, string> = {}) {
  const cols = Object.keys(extra).map((c) => `, ${c} = @${c}`).join('');
  db.prepare(`update flows set status = @status, updated_at = @at${cols} where flow_id = @flowId`).run({
    status,
    at: now(),
    flowId,
    ...extra,
  });
}

export function enqueueCommand(
  db: Db,
  cmd: { flowId: string; type: string; target: 'estimate' | 'supply'; key: string; payload: unknown },
) {
  db.prepare(
    `insert or ignore into commands
       (flow_id, type, target, idempotency_key, payload, next_attempt_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(cmd.flowId, cmd.type, cmd.target, cmd.key, JSON.stringify(cmd.payload), Date.now(), now());
}

function getFlowByNeed(db: Db, needId: string): Row {
  const flow = db.prepare('select * from flows where need_id = ?').get(needId) as Row | undefined;
  if (!flow) throw new RetryLater(`flow for ${needId} not found yet`);
  return flow;
}

function onNeedSubmitted(db: Db, d: MaterialNeedSubmitted) {
  const flowId = `need:${d.needId}`;
  if (db.prepare('select 1 from flows where flow_id = ?').get(flowId)) {
    addHistory(db, flowId, 'Повторная подача потребности проигнорирована (редакции в прототипе не поддерживаются)');
    return;
  }
  db.prepare(
    `insert into flows (flow_id, need_id, need_version, project_id, status, need_json, created_at, updated_at)
     values (?, ?, ?, ?, 'REVIEW_REQUESTED', ?, ?, ?)`,
  ).run(flowId, d.needId, d.needVersion, d.projectId, JSON.stringify(d), now(), now());
  addHistory(db, flowId, 'Потребность получена из ПТО');
  enqueueCommand(db, {
    flowId,
    type: 'create_review',
    target: 'estimate',
    key: `review:${d.needId}:v${d.needVersion}`,
    payload: d,
  });
}

function onReviewCompleted(db: Db, d: EstimateReviewCompleted) {
  const flow = getFlowByNeed(db, d.needId);
  if (flow.status !== 'REVIEW_REQUESTED') {
    addHistory(db, flow.flow_id, 'Повторное решение сметы проигнорировано');
    return;
  }
  if (d.decision === 'REJECTED') {
    setStatus(db, flow.flow_id, 'REJECTED', { review_id: d.reviewId });
    addHistory(db, flow.flow_id, 'Сметы отклонили потребность, заявка не создаётся');
    return;
  }
  const need = JSON.parse(flow.need_json) as MaterialNeedSubmitted;
  const approved: Item[] = d.items
    .filter((i) => i.approvedQuantity > 0)
    .map((i) => {
      const original = need.items.find((n) => n.line === i.line)!;
      return { line: i.line, material: original.material, quantity: i.approvedQuantity, unit: original.unit };
    });
  setStatus(db, flow.flow_id, 'PROCUREMENT_REQUESTED', {
    review_id: d.reviewId,
    approved_json: JSON.stringify(approved),
  });
  addHistory(
    db,
    flow.flow_id,
    d.decision === 'APPROVED' ? 'Сметы одобрили потребность' : 'Сметы одобрили потребность частично',
  );
  enqueueCommand(db, {
    flowId: flow.flow_id,
    type: 'create_procurement',
    target: 'supply',
    key: `proc:${d.needId}:v${d.needVersion}:${d.reviewId}`,
    payload: {
      needId: d.needId,
      needVersion: d.needVersion,
      reviewId: d.reviewId,
      projectId: need.projectId,
      requiredBy: need.requiredBy,
      items: approved,
    },
  });
}

const PROCUREMENT_TO_FLOW: Record<ProcurementStatusChanged['status'], FlowStatus> = {
  CREATED: 'PROCUREMENT_CREATED',
  ORDERED: 'ORDERED',
  DELIVERED: 'DELIVERED',
};

function onProcurementStatus(db: Db, d: ProcurementStatusChanged) {
  const flow = getFlowByNeed(db, d.needId);
  if (flow.status === 'REJECTED') return;
  const status = PROCUREMENT_TO_FLOW[d.status];
  setStatus(db, flow.flow_id, status, { procurement_id: d.procurementId });
  addHistory(db, flow.flow_id, `Снабжение: заявка ${d.procurementId}, статус «${d.status}»`);
}

// Вся обработка — в одной транзакции: запись в inbox, смена состояния и постановка команды
// фиксируются вместе или не фиксируются вообще.
export function handleEvent(db: Db, e: Envelope): EventResult {
  const run = db.transaction((): EventResult => {
    const inserted = db
      .prepare(
        `insert or ignore into inbox (event_id, source, type, aggregate_id, aggregate_version, received_at)
         values (?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.source, e.type, e.aggregateId, e.aggregateVersion, now());
    if (inserted.changes === 0) return 'duplicate';

    const key = `${e.type}:${e.aggregateId}`;
    const current = db.prepare('select version from aggregate_versions where key = ?').get(key) as
      | { version: number }
      | undefined;
    if (current && current.version >= e.aggregateVersion) return 'stale';
    db.prepare(
      `insert into aggregate_versions (key, version) values (?, ?)
       on conflict(key) do update set version = excluded.version`,
    ).run(key, e.aggregateVersion);

    switch (e.type) {
      case 'MaterialNeedSubmitted':
        onNeedSubmitted(db, e.data as MaterialNeedSubmitted);
        break;
      case 'EstimateReviewCompleted':
        onReviewCompleted(db, e.data as EstimateReviewCompleted);
        break;
      case 'ProcurementStatusChanged':
        onProcurementStatus(db, e.data as ProcurementStatusChanged);
        break;
    }
    return 'applied';
  });
  return run();
}
