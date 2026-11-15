import {
  applyAccountingTransaction,
  type AccountingAccount,
  type AccountingState,
} from '../accounting/index.js';
import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { hash } from '../../shared/canonical.js';

export interface GovernmentRecipient {
  readonly kingdomId: string;
  readonly ownerId: string;
  readonly accountId: string;
}
export interface GovernmentKingdom {
  readonly kingdomId: string;
  readonly controller: 'player' | 'ai';
  readonly treasuryAccountId: string;
  readonly recipients: readonly GovernmentRecipient[];
  readonly aiPolicy?: {
    readonly recipientOwnerId: string;
    readonly recipientAccountId: string;
    readonly amount: number;
    readonly reserve: number;
  };
}
export interface GovernmentConfig {
  readonly kingdoms: readonly GovernmentKingdom[];
}
export interface FundedTransferPolicy {
  readonly policyId: string;
  readonly governmentId: string;
  readonly recipientKingdomId: string;
  readonly recipientOwnerId: string;
  readonly recipientAccountId: string;
  readonly amount: number;
  readonly effectiveTick: number;
  readonly expiryTick: number;
}
type GovernmentState = {
  version: 2;
  configDigest: string;
  kingdoms: GovernmentKingdom[];
  policies: FundedTransferPolicy[];
  applied: string[];
  decisions: Array<{
    kingdomId: string;
    policyId: string;
    tick: number;
    selected: string;
    cause: string;
    reason: string;
    alternatives: string[];
    information: string[];
    constraints: string[];
  }>;
};
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const validPolicy = (p: FundedTransferPolicy) =>
  !!p &&
  text(p.policyId) &&
  text(p.governmentId) &&
  text(p.recipientKingdomId) &&
  text(p.recipientOwnerId) &&
  text(p.recipientAccountId) &&
  Number.isSafeInteger(p.amount) &&
  p.amount > 0 &&
  Number.isSafeInteger(p.effectiveTick) &&
  p.effectiveTick > 0 &&
  Number.isSafeInteger(p.expiryTick) &&
  p.expiryTick >= p.effectiveTick;
const validKingdom = (k: GovernmentKingdom) =>
  !!k &&
  text(k.kingdomId) &&
  ['player', 'ai'].includes(k.controller) &&
  text(k.treasuryAccountId) &&
  Array.isArray(k.recipients) &&
  k.recipients.length > 0 &&
  k.recipients.every(
    (r) =>
      !!r &&
      r.kingdomId === k.kingdomId &&
      text(r.ownerId) &&
      r.ownerId === k.kingdomId &&
      text(r.accountId),
  ) &&
  (!k.aiPolicy ||
    (text(k.aiPolicy.recipientOwnerId) &&
      text(k.aiPolicy.recipientAccountId) &&
      k.aiPolicy.recipientAccountId !== k.treasuryAccountId &&
      Number.isSafeInteger(k.aiPolicy.amount) &&
      k.aiPolicy.amount > 0 &&
      Number.isSafeInteger(k.aiPolicy.reserve) &&
      k.aiPolicy.reserve >= 0));
function allowed(
  kingdom: GovernmentKingdom,
  recipientKingdomId: string,
  ownerId: string,
  accountId: string,
) {
  return (
    recipientKingdomId === kingdom.kingdomId &&
    kingdom.recipients.some(
      (r) =>
        r.kingdomId === recipientKingdomId && r.ownerId === ownerId && r.accountId === accountId,
    )
  );
}
export function scheduleFundedTransfer(
  policy: FundedTransferPolicy,
  kingdoms: readonly GovernmentKingdom[],
  accounts: readonly Pick<AccountingAccount, 'id' | 'ownerId'>[],
): FundedTransferPolicy {
  const k = kingdoms.find((item) => item.kingdomId === policy?.governmentId);
  if (
    !validPolicy(policy) ||
    !k ||
    policy.recipientAccountId === k.treasuryAccountId ||
    !allowed(k, policy.recipientKingdomId, policy.recipientOwnerId, policy.recipientAccountId) ||
    policy.recipientKingdomId !== policy.governmentId ||
    accounts.find((a) => a.id === policy.recipientAccountId)?.ownerId !== policy.recipientOwnerId ||
    accounts.find((a) => a.id === k.treasuryAccountId)?.ownerId !== k.kingdomId
  )
    throw new TypeError('invalid or unauthorized funded transfer');
  return structuredClone(policy);
}
export function applyScheduledTransfer(
  state: AccountingState,
  policy: FundedTransferPolicy,
  tick: number,
  treasuryAccountId: string,
): AccountingState {
  if (!validPolicy(policy) || !text(treasuryAccountId) || !Number.isSafeInteger(tick) || tick < 0)
    throw new TypeError('invalid policy tick');
  if (tick < policy.effectiveTick || tick > policy.expiryTick) return state;
  const treasury = state.accounts.find(
    (a) => a.id === treasuryAccountId && a.ownerId === policy.governmentId,
  );
  const recipient = state.accounts.find(
    (a) => a.id === policy.recipientAccountId && a.ownerId === policy.recipientOwnerId,
  );
  if (!treasury || !recipient || treasury.balance < policy.amount) return state;
  return applyAccountingTransaction(
    state,
    [
      {
        type: 'payment',
        fromAccountId: treasury.id,
        toAccountId: recipient.id,
        amount: {
          kind: 'money',
          currencyId: state.currency.id,
          unit: state.currency.unit,
          scale: state.currency.scale,
          minor: policy.amount,
        },
        causeId: `government:${policy.policyId}`,
      },
    ],
    `government:${policy.policyId}:${tick}`,
  );
}
export function registerGovernment(engine: Engine, config: GovernmentConfig): void {
  if (
    !config ||
    !Array.isArray(config.kingdoms) ||
    config.kingdoms.length < 2 ||
    config.kingdoms.some((k) => !validKingdom(k)) ||
    config.kingdoms.filter((k) => k.controller === 'player').length !== 1 ||
    new Set(config.kingdoms.map((k) => k.kingdomId)).size !== config.kingdoms.length
  )
    throw new TypeError('invalid government configuration');
  const kingdoms = structuredClone(config.kingdoms),
    digest = hash(kingdoms),
    initial: GovernmentState = {
      version: 2,
      configDigest: digest,
      kingdoms,
      policies: [],
      applied: [],
      decisions: [],
    };
  const initialize = (d: Record<string, unknown>) => {
    if (!d.government) d.government = structuredClone(initial);
  };
  engine.registerPhaseSystem('infrastructure', 'government:initialize', initialize);
  engine.registerInvariant((d) => {
    const g = d.government as GovernmentState | undefined;
    if (
      g &&
      (g.version !== 2 ||
        g.configDigest !== digest ||
        hash(g.kingdoms) !== digest ||
        !Array.isArray(g.policies) ||
        !Array.isArray(g.applied) ||
        !Array.isArray(g.decisions))
    )
      throw new TypeError('invalid government state');
    const diplomacy = d.diplomacy as
      { kingdoms?: Array<{ kingdomId: string; controller: 'player' | 'ai' }> } | undefined;
    if (
      g &&
      diplomacy &&
      (!Array.isArray(diplomacy.kingdoms) ||
        diplomacy.kingdoms.length !== g.kingdoms.length ||
        g.kingdoms.some(
          (kingdom) =>
            diplomacy.kingdoms!.find((item) => item.kingdomId === kingdom.kingdomId)?.controller !==
            kingdom.controller,
        ))
    )
      throw new TypeError('government and diplomacy kingdom roles do not match');
    const accounting = d.accounting as AccountingState | undefined;
    if (
      g &&
      accounting &&
      g.kingdoms.some(
        (k) =>
          accounting.accounts.find((a) => a.id === k.treasuryAccountId)?.ownerId !== k.kingdomId ||
          k.recipients.some(
            (r) => accounting.accounts.find((a) => a.id === r.accountId)?.ownerId !== r.ownerId,
          ),
      )
    )
      throw new TypeError('government account mapping does not match accounting');
  });
  engine.registerCommandHandler('government.policy', (d, payload) => {
    try {
      initialize(d);
      const p = payload as FundedTransferPolicy & { kingdomId?: unknown };
      const k = kingdoms.find((x) => x.kingdomId === p?.governmentId);
      if (!p || p.kingdomId !== p.governmentId || !k || k.controller !== 'player')
        throw new TypeError('government command restricted to player kingdom');
      const state = d.accounting as AccountingState | undefined;
      if (!state) throw new TypeError('government accounting unavailable');
      const policy = scheduleFundedTransfer(p, kingdoms, state.accounts);
      const g = d.government as GovernmentState;
      if (g.policies.some((item) => item.policyId === policy.policyId))
        throw new TypeError('duplicate policy');
      g.policies.push(policy);
    } catch {
      throw new DomainCommandRejection();
    }
  });
  engine.registerPhaseSystem('settlement', 'government:autonomous-policy', (d) => {
    const g = d.government as GovernmentState | undefined;
    let accounting = d.accounting as AccountingState | undefined;
    if (!g || !accounting) return;
    const tick = engine.getState().tick + 1;
    for (const k of g.kingdoms.filter((item) => item.controller === 'ai' && item.aiPolicy)) {
      const rule = k.aiPolicy!,
        treasury = accounting.accounts.find(
          (a) => a.id === k.treasuryAccountId && a.ownerId === k.kingdomId,
        ),
        recipient = accounting.accounts.find(
          (a) => a.id === rule.recipientAccountId && a.ownerId === rule.recipientOwnerId,
        );
      const balance = treasury?.balance ?? 0,
        amount = Math.min(rule.amount, Math.max(0, balance - rule.reserve));
      const policyId = `ai-${k.kingdomId}-transfer-${tick}`;
      const selected =
        amount > 0 &&
        recipient &&
        allowed(k, k.kingdomId, rule.recipientOwnerId, rule.recipientAccountId)
          ? 'fund'
          : 'retain';
      g.decisions.push({
        kingdomId: k.kingdomId,
        policyId,
        tick,
        selected,
        alternatives: ['fund', 'retain'],
        cause: 'deterministic treasury-and-reserve rule',
        information: [`treasury=${balance}`, `recipient=${recipient?.id ?? 'missing'}`],
        constraints: [`reserve=${rule.reserve}`],
        reason:
          selected === 'fund'
            ? `funded amount ${amount} while preserving reserve`
            : 'insufficient spendable treasury or recipient unavailable',
      });
      if (selected === 'fund') {
        const policy = {
          policyId,
          governmentId: k.kingdomId,
          recipientKingdomId: k.kingdomId,
          recipientOwnerId: rule.recipientOwnerId,
          recipientAccountId: rule.recipientAccountId,
          amount,
          effectiveTick: tick,
          expiryTick: tick,
        };
        g.policies.push(policy);
        const next = applyScheduledTransfer(accounting, policy, tick, k.treasuryAccountId);
        if (next !== accounting) {
          accounting = next;
          d.accounting = accounting;
          g.applied.push(policyId);
        }
      }
    }
    for (const policy of g.policies) {
      if (
        g.applied.includes(policy.policyId) ||
        tick < policy.effectiveTick ||
        tick > policy.expiryTick
      )
        continue;
      const k = g.kingdoms.find((item) => item.kingdomId === policy.governmentId)!;
      const before = d.accounting as AccountingState;
      const treasury = before.accounts.find((a) => a.id === k.treasuryAccountId)!;
      const next = applyScheduledTransfer(before, policy, tick, k.treasuryAccountId);
      g.decisions.push({
        kingdomId: k.kingdomId,
        policyId: policy.policyId,
        tick,
        selected: next === before ? 'retain' : 'fund',
        alternatives: ['fund', 'retain'],
        cause: 'scheduled player policy evaluated against treasury balance',
        information: [`treasury=${treasury.balance}`, `requested amount=${policy.amount}`],
        constraints: [`available balance must cover ${policy.amount}`],
        reason:
          next === before
            ? 'insufficient treasury; no transfer occurred'
            : 'scheduled transfer debited the configured treasury',
      });
      if (next !== before) {
        d.accounting = next;
        g.applied.push(policy.policyId);
      }
    }
  });
}
