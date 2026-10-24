import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, SERVICE_NAMES } from './types';
import type { Envelope, EventType, ServiceName } from './types';

export function makeEvent<T>(
  source: ServiceName,
  type: EventType,
  aggregateId: string,
  aggregateVersion: number,
  data: T,
): Envelope<T> {
  return {
    id: randomUUID(),
    type,
    source,
    aggregateId,
    aggregateVersion,
    occurredAt: new Date().toISOString(),
    data,
  };
}

export function isEnvelope(x: unknown): x is Envelope {
  const e = x as Envelope;
  return (
    !!e &&
    typeof e.id === 'string' &&
    EVENT_TYPES.includes(e.type) &&
    SERVICE_NAMES.includes(e.source) &&
    typeof e.aggregateId === 'string' &&
    Number.isInteger(e.aggregateVersion) &&
    e.aggregateVersion >= 1 &&
    typeof e.data === 'object' &&
    e.data !== null
  );
}
