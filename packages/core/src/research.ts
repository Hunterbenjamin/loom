export const RESEARCH_DEPTH_VALUES = ["quick", "standard", "deep"] as const;
export type ResearchDepth = (typeof RESEARCH_DEPTH_VALUES)[number];
export const RESEARCH_LIMITS = {
  quick: { turns: 10, tokens: 30000 },
  standard: { turns: 30, tokens: 100000 },
  deep: { turns: 60, tokens: 200000 },
} as const;
