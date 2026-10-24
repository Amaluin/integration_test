import { DEFAULT_TOKENS, envInt, envStr } from '../shared/config';
import { startSupply } from './server';

const supply = await startSupply({
  port: envInt('PORT', 3003),
  dbPath: envStr('DB_PATH', './data/supply.db'),
  hubUrl: envStr('HUB_URL', 'http://localhost:3000'),
  token: DEFAULT_TOKENS.supply,
  hubToken: DEFAULT_TOKENS.hub,
  logger: true,
});
console.log(`supply listening on ${supply.url}`);
