export type ServiceName = 'pto' | 'estimate' | 'supply';

export type EventType =
  | 'MaterialNeedSubmitted'
  | 'EstimateReviewCompleted'
  | 'ProcurementStatusChanged';

export const EVENT_TYPES: EventType[] = [
  'MaterialNeedSubmitted',
  'EstimateReviewCompleted',
  'ProcurementStatusChanged',
];

export const SERVICE_NAMES: ServiceName[] = ['pto', 'estimate', 'supply'];

export interface Envelope<T = unknown> {
  id: string;
  type: EventType;
  source: ServiceName;
  aggregateId: string;
  aggregateVersion: number;
  occurredAt: string;
  data: T;
}

export interface Item {
  line: number;
  material: string;
  quantity: number;
  unit: string;
}

export interface MaterialNeedSubmitted {
  needId: string;
  needVersion: number;
  projectId: string;
  requiredBy: string;
  items: Item[];
}

export type ReviewDecision = 'APPROVED' | 'PARTIALLY_APPROVED' | 'REJECTED';

export interface EstimateReviewCompleted {
  reviewId: string;
  needId: string;
  needVersion: number;
  decision: ReviewDecision;
  items: { line: number; requestedQuantity: number; approvedQuantity: number }[];
}

export type ProcurementStatus = 'CREATED' | 'ORDERED' | 'DELIVERED';

export interface ProcurementStatusChanged {
  procurementId: string;
  needId: string;
  needVersion: number;
  status: ProcurementStatus;
}

export type FlowStatus =
  | 'REVIEW_REQUESTED'
  | 'REJECTED'
  | 'PROCUREMENT_REQUESTED'
  | 'PROCUREMENT_CREATED'
  | 'ORDERED'
  | 'DELIVERED';

export const FLOW_STATUS_RU: Record<FlowStatus, string> = {
  REVIEW_REQUESTED: 'На проверке в сметах',
  REJECTED: 'Отклонено сметами',
  PROCUREMENT_REQUESTED: 'Одобрено, заявка создаётся',
  PROCUREMENT_CREATED: 'Заявка создана',
  ORDERED: 'Заказано',
  DELIVERED: 'Поставлено',
};
