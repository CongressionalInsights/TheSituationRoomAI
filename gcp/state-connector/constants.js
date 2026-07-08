export const STATE_NAMES = {
  CA: 'California',
  FL: 'Florida',
  MN: 'Minnesota',
  NY: 'New York',
  TX: 'Texas',
  VA: 'Virginia'
};

export const coveredStates = Object.keys(STATE_NAMES).sort();

export const SIGNAL_TYPES = new Set(['rulemaking', 'executive_order']);
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;
