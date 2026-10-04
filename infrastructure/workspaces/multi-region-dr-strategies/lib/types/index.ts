export const STRATEGIES = ['bnr', 'pl', 'ws', 'aa'] as const;
export type Strategy = (typeof STRATEGIES)[number];

/** Short names used in resource names and outputs. */
export const STRATEGY_LABEL: Record<Strategy, string> = {
  bnr: 'Backup and restore',
  pl: 'Pilot light',
  ws: 'Warm standby',
  aa: 'Multi-site active-active',
};

export const orderTableName = (prefix: string, strategy: Strategy): string => `${prefix}-${strategy}-orders`;
