export const COMMODITIES = ['grain', 'wood', 'tools'] as const;

export type Commodity = (typeof COMMODITIES)[number];
