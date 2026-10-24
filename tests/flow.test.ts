import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TOKENS } from '../src/shared/config';
import { makeEvent } from '../src/shared/events';
import {
  count,
  createNeed,
  decide,
  flowOf,
  getJson,
  post,
  setChaos,
  sleep,
  startStack,
  waitFor,
  waitForStatus,
} from './helpers';
import type { Stack } from './helpers';

let stack: Stack;
afterEach(async () => {
  await stack?.close();
});

describe('сквозной процесс', () => {
  it('потребность проходит ПТО → сметы → снабжение, статусы видны в ПТО', async () => {
    stack = await startStack();
    const needId = await createNeed(stack, 12);

    await decide(stack, needId, 10.5); // сметчик одобряет 10,5 т из 12 т
    await waitForStatus(stack, needId, 'PROCUREMENT_CREATED');

    const { requests } = await getJson(`${stack.supply.url}/api/procurement-requests`);
    expect(requests).toHaveLength(1);
    expect(requests[0].items[0].quantity).toBe(10.5);

    for (const status of ['ORDERED', 'DELIVERED']) {
      await post(`${stack.supply.url}/api/procurement-requests/${requests[0].procurementId}/status`, { status });
      await waitForStatus(stack, needId, status);
    }

    const { needs, hubAvailable } = await getJson(`${stack.pto.url}/api/needs`);
    expect(hubAvailable).toBe(true);
    expect(needs[0].flow.status).toBe('DELIVERED');
    expect(needs[0].flow.procurementId).toBe(requests[0].procurementId);
  });

  it('отклонённая потребность не создаёт заявку', async () => {
    stack = await startStack();
    const needId = await createNeed(stack);
    await decide(stack, needId, 0);
    await waitForStatus(stack, needId, 'REJECTED');
    await sleep(300);
    expect(count(stack.supply.db, 'requests')).toBe(0);
  });
});

describe('сбои', () => {
  it('снабжение недоступно: процесс ждёт и дожимается после восстановления, заявка одна', async () => {
    stack = await startStack();
    await setChaos(stack.supply.url, 'down');
    const needId = await createNeed(stack);
    await decide(stack, needId, 12);

    await waitFor(() => (stack.hub.db.prepare("select max(attempts) as a from commands").get() as any).a >= 2);
    expect((await flowOf(stack, needId)).status).toBe('PROCUREMENT_REQUESTED');
    expect(count(stack.supply.db, 'requests')).toBe(0);

    await setChaos(stack.supply.url, 'ok');
    await waitForStatus(stack, needId, 'PROCUREMENT_CREATED');
    expect(count(stack.supply.db, 'requests')).toBe(1);
  });

  it('заявка создана, а ответ потерян: повтор не создаёт вторую заявку', async () => {
    stack = await startStack();
    await setChaos(stack.supply.url, 'drop-response');
    const needId = await createNeed(stack);
    await decide(stack, needId, 12);

    // повтор команды должен завершиться успехом: снабжение узнаёт ключ и возвращает уже созданную заявку
    const command = () =>
      stack.hub.db.prepare("select status, attempts from commands where type = 'create_procurement'").get() as any;
    await waitFor(() => command()?.status === 'done', 8000, 'повтор команды завершился успешно');
    await waitForStatus(stack, needId, 'PROCUREMENT_CREATED');

    expect(command().attempts).toBeGreaterThanOrEqual(1); // действительно был повтор
    expect(count(stack.supply.db, 'requests')).toBe(1);
    const { procurementId } = await flowOf(stack, needId);
    expect(procurementId).toBe(
      (stack.supply.db.prepare('select procurement_id as id from requests').get() as any).id,
    );
  });

  it('связующий сервис недоступен: потребность сохраняется и доходит позже', async () => {
    stack = await startStack({ hubAutostart: false });
    const needId = await createNeed(stack);

    const { hubAvailable, outbox } = await getJson(`${stack.pto.url}/api/needs`);
    expect(hubAvailable).toBe(false);
    expect(outbox.pending).toBe(1);

    await stack.startHub();
    await waitForStatus(stack, needId, 'REVIEW_REQUESTED');
    await waitFor(() => count(stack.estimate.db, 'reviews') === 1, 8000, 'review at estimate');
    expect(count(stack.pto.db, 'needs')).toBe(1);
  });

  it('то же событие, доставленное дважды, обрабатывается один раз', async () => {
    stack = await startStack();
    const event = makeEvent('pto', 'MaterialNeedSubmitted', 'NEED-X-1', 1, {
      needId: 'NEED-X-1',
      needVersion: 1,
      projectId: 'OBJ-1',
      requiredBy: '2026-12-01',
      items: [{ line: 1, material: 'Бетон', quantity: 5, unit: 'м3' }],
    });
    const send = () => post(`${stack.hubUrl}/v1/events`, event, { authorization: `Bearer ${DEFAULT_TOKENS.pto}` });

    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(200); // повтор распознан
    await waitFor(() => count(stack.estimate.db, 'reviews') === 1);
    await sleep(200);
    expect(count(stack.hub.db, 'flows')).toBe(1);
    expect(count(stack.estimate.db, 'reviews')).toBe(1);
  });

  it('запоздавшее событие не откатывает статус назад', async () => {
    stack = await startStack();
    const needId = await createNeed(stack);
    await decide(stack, needId, 12);
    await waitForStatus(stack, needId, 'PROCUREMENT_CREATED');
    const { procurementId } = await flowOf(stack, needId);

    const supplyEvent = (version: number, status: string) =>
      post(
        `${stack.hubUrl}/v1/events`,
        makeEvent('supply', 'ProcurementStatusChanged', procurementId, version, {
          procurementId,
          needId,
          needVersion: 1,
          status,
        }),
        { authorization: `Bearer ${DEFAULT_TOKENS.supply}` },
      );

    await supplyEvent(3, 'DELIVERED');
    await supplyEvent(2, 'ORDERED'); // пришло позже, но относится к более раннему состоянию
    expect((await flowOf(stack, needId)).status).toBe('DELIVERED');
  });
});

describe('безопасность обмена', () => {
  it('без токена — 401, чужой источник — 403, команда без токена — 401', async () => {
    stack = await startStack();
    const event = makeEvent('supply', 'ProcurementStatusChanged', 'PR-1', 1, {
      procurementId: 'PR-1',
      needId: 'NEED-1',
      needVersion: 1,
      status: 'CREATED',
    });
    expect((await post(`${stack.hubUrl}/v1/events`, event)).status).toBe(401);
    expect(
      (await post(`${stack.hubUrl}/v1/events`, event, { authorization: `Bearer ${DEFAULT_TOKENS.pto}` })).status,
    ).toBe(403);
    expect(
      (await post(`${stack.supply.url}/api/procurement-requests`, { needId: 'N', items: [{}] }, { 'idempotency-key': 'k' }))
        .status,
    ).toBe(401);
  });

  it('тот же ключ идемпотентности с другим телом — 409', async () => {
    stack = await startStack();
    const headers = { authorization: `Bearer ${DEFAULT_TOKENS.hub}`, 'idempotency-key': 'proc:N:v1:R1' };
    const body = { needId: 'N', needVersion: 1, items: [{ line: 1, material: 'x', quantity: 1, unit: 'т' }] };
    expect((await post(`${stack.supply.url}/api/procurement-requests`, body, headers)).status).toBe(201);
    expect((await post(`${stack.supply.url}/api/procurement-requests`, body, headers)).status).toBe(200);
    const changed = { ...body, items: [{ line: 1, material: 'x', quantity: 2, unit: 'т' }] };
    expect((await post(`${stack.supply.url}/api/procurement-requests`, changed, headers)).status).toBe(409);
    expect(count(stack.supply.db, 'requests')).toBe(1);
  });
});
