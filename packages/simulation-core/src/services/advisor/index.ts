import type { Engine } from '../engine.js';
import type { GovernmentConfig } from '../government/index.js';
import type { EngineCommand } from '../../models/commands.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { canonical } from '../../shared/canonical.js';

export type DelegatedPolicyVariant =
  | 'transfer'
  | 'food-subsidy'
  | 'local-purchase-tax'
  | 'import-tariff'
  | 'trade-restriction'
  | 'capital-investment';
export interface AdvisorPermission {
  readonly variant: DelegatedPolicyVariant;
  readonly scope: Readonly<Record<string, string>>;
  readonly maxAmount?: number;
  readonly maxRateBps?: number;
}
interface AdvisorGrant {
  grantId: string;
  kingdomId: string;
  advisorId: string;
  permissions: AdvisorPermission[];
  grantedTick: number;
  revokedTick: number | null;
}
interface AdvisorState {
  version: 1;
  grants: AdvisorGrant[];
  audit: Array<Record<string, unknown>>;
}
const variants = new Set<DelegatedPolicyVariant>([
  'transfer',
  'food-subsidy',
  'local-purchase-tax',
  'import-tariff',
  'trade-restriction',
  'capital-investment',
]);
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const bounded = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const stateOf = (domain: Record<string, unknown>): AdvisorState => {
  if (!domain.advisor)
    domain.advisor = { version: 1, grants: [], audit: [] } satisfies AdvisorState;
  return domain.advisor as AdvisorState;
};
function validatePermission(
  permission: AdvisorPermission,
  cityKingdomIds: Readonly<Record<string, string>> = {},
): boolean {
  if (
    !permission ||
    !variants.has(permission.variant) ||
    !permission.scope ||
    typeof permission.scope !== 'object'
  )
    return false;
  const expected: Record<DelegatedPolicyVariant, string[]> = {
    transfer: ['recipientKingdomId', 'recipientOwnerId', 'recipientAccountId'],
    'food-subsidy': ['recipientKingdomId', 'recipientOwnerId', 'recipientAccountId', 'commodity'],
    'local-purchase-tax': ['cityId'],
    'import-tariff': ['importKingdomId', 'routeId', 'commodity'],
    'trade-restriction': ['importKingdomId', 'routeId', 'commodity'],
    'capital-investment': ['cityId'],
  };
  const keys = Object.keys(permission.scope).sort();
  const validScope =
    permission.variant === 'capital-investment'
      ? canonical(keys) === canonical(['cityId']) || canonical(keys) === canonical(['routeId'])
      : canonical(keys) === canonical([...expected[permission.variant]].sort());
  if (
    !validScope ||
    (permission.variant === 'local-purchase-tax' &&
      cityKingdomIds[permission.scope.cityId!] === undefined) ||
    keys.some(
      (key) =>
        !text(permission.scope[key]) ||
        permission.scope[key] === '*' ||
        permission.scope[key].includes('*'),
    )
  )
    return false;
  // Investment grants are bounded by cost and one explicit city or route target.
  if (permission.variant === 'capital-investment')
    return bounded(permission.maxAmount, 1, 1_000_000) && permission.maxRateBps === undefined;
  if (permission.variant === 'trade-restriction')
    return permission.maxAmount === undefined && permission.maxRateBps === undefined;
  if (permission.variant === 'local-purchase-tax')
    return permission.maxAmount === undefined && bounded(permission.maxRateBps, 1, 10000);
  return (
    bounded(permission.maxAmount, 1, Number.MAX_SAFE_INTEGER) && permission.maxRateBps === undefined
  );
}
function matches(permission: AdvisorPermission, payload: Record<string, unknown>): boolean {
  if (payload.variant !== permission.variant) return false;
  const fields: Record<DelegatedPolicyVariant, string[]> = {
    transfer: ['recipientKingdomId', 'recipientOwnerId', 'recipientAccountId'],
    'food-subsidy': ['recipientKingdomId', 'recipientOwnerId', 'recipientAccountId', 'commodity'],
    'local-purchase-tax': ['cityId'],
    'import-tariff': ['importKingdomId', 'routeId', 'commodity'],
    'trade-restriction': ['importKingdomId', 'routeId', 'commodity'],
    'capital-investment': ['cityId'],
  };
  if (permission.variant === 'capital-investment') {
    const target =
      permission.scope.cityId !== undefined ? payload.targetCityId : payload.targetRouteId;
    const scoped = permission.scope.cityId ?? permission.scope.routeId;
    if (target !== scoped) return false;
  } else if (!fields[permission.variant].every((key) => payload[key] === permission.scope[key]))
    return false;
  if (permission.maxAmount !== undefined) {
    const amount = permission.variant === 'capital-investment' ? payload.cost : payload.amount;
    if (!bounded(amount, 1, permission.maxAmount)) return false;
  }
  if (permission.variant === 'local-purchase-tax')
    return bounded(payload.rateBps, 1, permission.maxRateBps ?? 0);
  return permission.maxRateBps === undefined || bounded(payload.rateBps, 1, permission.maxRateBps);
}

export function registerAdvisor(engine: Engine, config: GovernmentConfig): void {
  if (!config || !Array.isArray(config.kingdoms))
    throw new TypeError('advisor requires trusted government configuration');
  const playerKingdomIds = new Set(
    config.kingdoms
      .filter((kingdom) => kingdom.controller === 'player')
      .map((kingdom) => kingdom.kingdomId),
  );
  const cityKingdomIds = config.cityKingdomIds ?? {};
  engine.registerCommandHandler('advisor.grant', (draft, input) => {
    try {
      const p = input as {
        grantId?: unknown;
        kingdomId?: unknown;
        advisorId?: unknown;
        permissions?: unknown;
      };
      if (
        !p ||
        !text(p.grantId) ||
        !text(p.kingdomId) ||
        !text(p.advisorId) ||
        !playerKingdomIds.has(p.kingdomId) ||
        !Array.isArray(p.permissions) ||
        !p.permissions.length ||
        !p.permissions.every(
          (permission) =>
            validatePermission(permission, cityKingdomIds) &&
            (permission.variant !== 'local-purchase-tax' ||
              cityKingdomIds[permission.scope.cityId!] === p.kingdomId),
        )
      )
        throw new Error('invalid advisor grant');
      const advisor = stateOf(draft);
      if (advisor.grants.some((grant) => grant.grantId === p.grantId))
        throw new Error('duplicate grant');
      advisor.grants.push({
        grantId: p.grantId,
        kingdomId: p.kingdomId,
        advisorId: p.advisorId,
        permissions: structuredClone(p.permissions) as AdvisorPermission[],
        grantedTick: engine.getState().tick + 1,
        revokedTick: null,
      });
      advisor.audit.push({
        grantId: p.grantId,
        kingdomId: p.kingdomId,
        advisorId: p.advisorId,
        tick: engine.getState().tick + 1,
        action: 'grant',
      });
    } catch {
      throw new DomainCommandRejection();
    }
  });
  engine.registerCommandHandler('advisor.revoke', (draft, input) => {
    const p = input as { grantId?: unknown; kingdomId?: unknown };
    const advisor = stateOf(draft);
    const grant = advisor.grants.find(
      (item) => item.grantId === p?.grantId && item.kingdomId === p?.kingdomId,
    );
    if (
      !text(p?.kingdomId) ||
      !playerKingdomIds.has(p.kingdomId) ||
      !grant ||
      grant.revokedTick !== null
    )
      throw new DomainCommandRejection();
    grant.revokedTick = engine.getState().tick + 1;
    advisor.audit.push({
      grantId: grant.grantId,
      kingdomId: grant.kingdomId,
      advisorId: grant.advisorId,
      tick: grant.revokedTick,
      action: 'revoke',
    });
  });
  engine.registerCommandSubmitValidator((command: EngineCommand) => {
    if (!command.type.startsWith('advisor.')) return undefined;
    if (command.actor?.kind !== 'player' || !text(command.actor.id)) return 'UNAUTHORIZED';
    const p = command.payload as { kingdomId?: unknown } | null;
    if (!p || !text(p.kingdomId) || !playerKingdomIds.has(p.kingdomId)) return 'UNAUTHORIZED';
    return undefined;
  });
  engine.registerAdvisorPolicySubmitValidator((command: EngineCommand, domain) => {
    if (command.type !== 'government.policy' || command.actor?.kind !== 'advisor')
      return 'UNAUTHORIZED';
    const payload = command.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'UNAUTHORIZED';
    const p = payload as Record<string, unknown>;
    if (
      !text(command.actor.id) ||
      !text(p.governmentId) ||
      p.kingdomId !== p.governmentId ||
      !variants.has(p.variant as DelegatedPolicyVariant)
    )
      return 'UNAUTHORIZED';
    const advisor = domain.advisor as AdvisorState | undefined;
    const grant = advisor?.grants.find(
      (item) =>
        item.kingdomId === p.governmentId &&
        item.advisorId === command.actor!.id &&
        item.revokedTick === null,
    );
    if (!grant || !grant.permissions.some((permission) => matches(permission, p)))
      return 'UNAUTHORIZED';
    return undefined;
  });
  engine.registerSubmitAcceptanceAudit((domain, command) => {
    if (command.type !== 'government.policy' || command.actor?.kind !== 'advisor') return;
    const payload = command.payload as Record<string, unknown>;
    const advisor = stateOf(domain);
    const grant = advisor.grants.find(
      (item) =>
        item.kingdomId === payload.governmentId &&
        item.advisorId === command.actor!.id &&
        item.revokedTick === null &&
        item.permissions.some((permission) => matches(permission, payload)),
    );
    if (!grant) throw new TypeError('submit authorization changed during audit');
    advisor.audit.push({
      commandId: command.commandId,
      grantId: grant.grantId,
      kingdomId: grant.kingdomId,
      advisorId: grant.advisorId,
      tick: engine.getState().tick,
      action: 'policy',
      outcome: 'authorized',
    });
  });
  engine.registerSubmitRejectionAudit((domain, command, code) => {
    if (command.type !== 'government.policy' || command.actor?.kind !== 'advisor') return;
    stateOf(domain).audit.push({
      commandId: command.commandId,
      kingdomId: (command.payload as { governmentId?: unknown } | null)?.governmentId ?? null,
      advisorId: command.actor.id,
      tick: engine.getState().tick,
      action: 'policy',
      outcome: 'rejected',
      code,
    });
  });
  engine.registerInvariant((domain) => {
    const advisor = domain.advisor as AdvisorState | undefined;
    if (!advisor) return;
    if (
      advisor.version !== 1 ||
      !Array.isArray(advisor.grants) ||
      !Array.isArray(advisor.audit) ||
      new Set(advisor.grants.map((grant) => grant.grantId)).size !== advisor.grants.length ||
      advisor.grants.some(
        (grant) =>
          !grant ||
          !text(grant.grantId) ||
          !text(grant.kingdomId) ||
          !text(grant.advisorId) ||
          !playerKingdomIds.has(grant.kingdomId) ||
          !Array.isArray(grant.permissions) ||
          !grant.permissions.every(
            (permission) =>
              validatePermission(permission, cityKingdomIds) &&
              (permission.variant !== 'local-purchase-tax' ||
                cityKingdomIds[permission.scope.cityId!] === grant.kingdomId),
          ) ||
          !Number.isSafeInteger(grant.grantedTick) ||
          grant.grantedTick < 1 ||
          (grant.revokedTick !== null &&
            (!Number.isSafeInteger(grant.revokedTick) || grant.revokedTick < grant.grantedTick)),
      )
    )
      throw new TypeError('invalid advisor state');
  });
}
