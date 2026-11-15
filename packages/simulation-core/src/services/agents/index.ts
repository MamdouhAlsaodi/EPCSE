export interface AgentOption {
  readonly id: string;
  readonly score: number;
}
export interface AgentDecisionInput {
  readonly agentId: string;
  readonly options: readonly AgentOption[];
  readonly information: readonly string[];
  readonly constraints: readonly string[];
}
export interface AgentDecision extends AgentDecisionInput {
  readonly alternatives: readonly string[];
  readonly selected: string;
  readonly reason: string;
}

/** Score options independently; stable ID ordering resolves ties deterministically. */
export function decideIndependently(input: AgentDecisionInput): AgentDecision {
  if (
    !input.agentId.trim() ||
    !input.options.length ||
    new Set(input.options.map((x) => x.id)).size !== input.options.length ||
    input.options.some((x) => !x.id.trim() || !Number.isSafeInteger(x.score))
  )
    throw new TypeError('invalid agent decision input');
  const options = [...input.options].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const selected = options.reduce((best, option) => (option.score > best.score ? option : best));
  return {
    ...structuredClone(input),
    alternatives: options.map((x) => x.id),
    selected: selected.id,
    reason: `highest utility score ${selected.score}; ties resolved by stable option ID`,
  };
}
