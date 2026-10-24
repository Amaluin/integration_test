import { DEFAULT_TOKENS, envInt, envStr } from '../shared/config';
import { startEstimate } from './server';

const estimate = await startEstimate({
  port: envInt('PORT', 3002),
  dbPath: envStr('DB_PATH', './data/estimate.db'),
  hubUrl: envStr('HUB_URL', 'http://localhost:3000'),
  token: DEFAULT_TOKENS.estimate,
  hubToken: DEFAULT_TOKENS.hub,
  logger: true,
});
console.log(`estimate listening on ${estimate.url}`);
