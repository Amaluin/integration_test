import { DEFAULT_TOKENS, envInt, envStr } from '../shared/config';
import { startHub } from './server';

const hub = await startHub({
  port: envInt('PORT', 3000),
  dbPath: envStr('DB_PATH', './data/hub.db'),
  serviceTokens: { pto: DEFAULT_TOKENS.pto, estimate: DEFAULT_TOKENS.estimate, supply: DEFAULT_TOKENS.supply },
  hubToken: DEFAULT_TOKENS.hub,
  urls: {
    estimate: envStr('ESTIMATE_URL', 'http://localhost:3002'),
    supply: envStr('SUPPLY_URL', 'http://localhost:3003'),
  },
  retry: {
    baseMs: envInt('RETRY_BASE_MS', 1000),
    maxMs: envInt('RETRY_MAX_MS', 30_000),
    maxAttempts: envInt('RETRY_MAX_ATTEMPTS', 12),
  },
  logger: true,
});
console.log(`hub listening on ${hub.url}`);
