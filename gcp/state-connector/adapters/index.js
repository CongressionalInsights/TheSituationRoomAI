import ca from './ca.js';
import fl from './fl.js';
import mn from './mn.js';
import ny from './ny.js';
import tx from './tx.js';
import va from './va.js';
import { coveredStates } from '../constants.js';

export const adapters = [ca, fl, mn, ny, tx, va];

export { coveredStates };

export function adaptersForState(stateCode = '') {
  const normalized = String(stateCode || '').trim().toUpperCase();
  if (!normalized) return adapters;
  return adapters.filter((adapter) => adapter.state === normalized);
}
