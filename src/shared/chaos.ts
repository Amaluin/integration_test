import type { FastifyInstance } from 'fastify';

export type ChaosMode = 'ok' | 'down' | 'drop-response';

// Имитация сбоев для демонстрации:
//  down          — сервис отвечает 503 на все запросы, кроме /admin и /health;
//  drop-response — следующий запрос обрабатывается полностью, но соединение обрывается до ответа.
export function registerChaos(app: FastifyInstance) {
  let mode: ChaosMode = 'ok';

  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'OPTIONS' || req.url.startsWith('/admin') || req.url === '/health') return;
    if (mode === 'down') {
      reply.code(503).send({ error: 'service unavailable (chaos mode)' });
      return reply;
    }
  });

  app.get('/admin/chaos', async () => ({ mode }));
  app.post('/admin/chaos', async (req, reply) => {
    const next = (req.body as { mode?: string } | null)?.mode;
    if (next !== 'ok' && next !== 'down' && next !== 'drop-response') {
      return reply.code(400).send({ error: 'mode must be ok | down | drop-response' });
    }
    mode = next;
    return { mode };
  });

  return {
    // true — если ответ на текущий запрос нужно «потерять» (режим сбрасывается после первого срабатывания)
    takeDropResponse(): boolean {
      if (mode === 'drop-response') {
        mode = 'ok';
        return true;
      }
      return false;
    },
  };
}
