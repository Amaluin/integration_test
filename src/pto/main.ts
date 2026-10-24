import { DEFAULT_TOKENS, envInt, envStr } from '../shared/config';
import { startPto } from './server';

const pto = await startPto({
  port: envInt('PORT', 3001),
  dbPath: envStr('DB_PATH', './data/pto.db'),
  hubUrl: envStr('HUB_URL', 'http://localhost:3000'),
  token: DEFAULT_TOKENS.pto,
  logger: true,
});
console.log(`pto listening on ${pto.url}`);
