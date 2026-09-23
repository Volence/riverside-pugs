import { writeFileSync } from 'node:fs';
import { loadBalanceKnobs, renderBalanceListInc } from '../src/balanceKnobs.js';

const out = new URL('../plugin/pug-balance-list.inc', import.meta.url);
writeFileSync(out, renderBalanceListInc(loadBalanceKnobs()));
console.log('wrote', out.pathname);
