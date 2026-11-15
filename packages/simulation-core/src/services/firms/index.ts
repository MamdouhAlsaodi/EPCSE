import type { Engine } from '../engine.js';
import { DomainCommandRejection } from '../../models/commands.js';
import { applyAccountingTransaction, type AccountingState } from '../accounting/index.js';
import type { LocalEconomyProducer } from '../economy/index.js';

export interface FirmsConfig {
  producers: readonly LocalEconomyProducer[];
  constructionAccountId: string;
  expansionCostPerCapacity: number;
}
type Firm = LocalEconomyProducer & {
  capacity: number;
  status: 'active' | 'closed' | 'insolvent';
  employment: number;
  insolvencyTicks: number;
  closureReason: string | null;
  closureTick: number | null;
  capitalOutlayThisTick: number;
  cumulativeCapitalOutlay: number;
  revenueThisTick: number;
  costThisTick: number;
  profitThisTick: number;
  cumulativeRevenue: number;
  cumulativeCost: number;
  cumulativeProfit: number;
  investment: { decision: 'expand' | 'hold'; reason: string; alternatives: string[] };
};
type FirmState = {
  version: 1;
  configDigest: string;
  firms: Record<string, Firm>;
  journalCursor: number;
};

export function registerFirms(engine: Engine, config: FirmsConfig): void {
  if (
    !config.constructionAccountId ||
    !Number.isSafeInteger(config.expansionCostPerCapacity) ||
    config.expansionCostPerCapacity <= 0
  )
    throw new RangeError('invalid firm construction provider or cost');
  const producers = structuredClone(config.producers);
  const initial = engine.getState().domain;
  const accounting = initial.accounting as AccountingState | undefined;
  const provider = accounting?.accounts.find((a) => a.id === config.constructionAccountId);
  if (
    provider &&
    producers.some((p) => p.accountId === provider.id || p.ownerId === provider.ownerId)
  )
    throw new RangeError('construction provider must be a distinct configured account and owner');
  const accountIds = new Set<string>();
  const ownerIds = new Set<string>();
  const firmIds = new Set<string>();
  for (const p of producers) {
    if (!p.id?.trim() || firmIds.has(p.id)) throw new RangeError('invalid or duplicate firm ID');
    firmIds.add(p.id);
    if (accountIds.has(p.accountId) || ownerIds.has(p.ownerId))
      throw new RangeError(
        'firms require unique producer owner and account for truthful attribution',
      );
    accountIds.add(p.accountId);
    ownerIds.add(p.ownerId);
    if (accounting && accounting.accounts.find((a) => a.id === p.accountId)?.ownerId !== p.ownerId)
      throw new RangeError(`unknown firm account: ${p.id}`);
  }
  const configDigest = JSON.stringify({
    producers,
    constructionAccountId: config.constructionAccountId,
    expansionCostPerCapacity: config.expansionCostPerCapacity,
  });
  const firms: FirmState['firms'] = Object.fromEntries(
    producers.map((p) => [
      p.id,
      {
        ...p,
        capacity: p.maxBatches,
        status: 'active' as const,
        employment: 0,
        insolvencyTicks: 0,
        closureReason: null,
        closureTick: null,
        capitalOutlayThisTick: 0,
        cumulativeCapitalOutlay: 0,
        revenueThisTick: 0,
        costThisTick: 0,
        profitThisTick: 0,
        cumulativeRevenue: 0,
        cumulativeCost: 0,
        cumulativeProfit: 0,
        investment: {
          decision: 'hold' as const,
          reason: 'capacity unchanged',
          alternatives: ['expand', 'hold'],
        },
      },
    ]),
  );
  const state: FirmState = {
    version: 1,
    configDigest,
    firms,
    journalCursor: accounting?.journal.length ?? 0,
  };
  engine.registerPhaseSystem('infrastructure', 'z-firms:initialize', (d) => {
    if (d.firms) return;
    const ledger = d.accounting as AccountingState | undefined;
    const economy = d.economy as
      | {
          producers?: Record<string, LocalEconomyProducer & { maxBatches: number }>;
        }
      | undefined;
    const construction = ledger?.accounts.find((a) => a.id === config.constructionAccountId);
    if (
      !ledger ||
      !construction ||
      !economy?.producers ||
      Object.keys(economy.producers).length !== producers.length ||
      producers.some(
        (p) =>
          !economy.producers?.[p.id] ||
          economy.producers[p.id]!.cityId !== p.cityId ||
          economy.producers[p.id]!.ownerId !== p.ownerId ||
          economy.producers[p.id]!.accountId !== p.accountId ||
          economy.producers[p.id]!.recipeId !== p.recipeId ||
          economy.producers[p.id]!.laborPerBatch !== p.laborPerBatch ||
          economy.producers[p.id]!.wagePerBatch !== p.wagePerBatch ||
          economy.producers[p.id]!.maxBatches !== p.maxBatches ||
          JSON.stringify(economy.producers[p.id]!.requiredSkills) !==
            JSON.stringify(p.requiredSkills ?? {}) ||
          ledger.accounts.find((a) => a.id === p.accountId)?.ownerId !== p.ownerId ||
          p.accountId === construction.id ||
          p.ownerId === construction.ownerId,
      )
    )
      throw new TypeError('invalid firm accounting references');
    const initialized = structuredClone(state);
    initialized.journalCursor = ledger.journal.length;
    d.firms = initialized;
  });
  engine.registerCommandHandler('firm.expand', (d, payload) => {
    const p = payload as { firmId?: unknown; ownerId?: unknown; capacity?: unknown };
    const fs = d.firms as FirmState | undefined,
      a = d.accounting as AccountingState | undefined;
    const firm = fs?.firms[String(p?.firmId)];
    if (
      !firm ||
      !a ||
      p.ownerId !== firm.ownerId ||
      !Number.isSafeInteger(p.capacity) ||
      (p.capacity as number) <= 0 ||
      firm.status !== 'active'
    )
      throw new DomainCommandRejection();
    const amount = (p.capacity as number) * config.expansionCostPerCapacity;
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      firm.capacity > 1000 - (p.capacity as number)
    )
      throw new DomainCommandRejection();
    const payer = a.accounts.find((x) => x.id === firm.accountId),
      recipient = a.accounts.find((x) => x.id === config.constructionAccountId);
    if (
      !payer ||
      !recipient ||
      payer.balance < amount ||
      recipient.balance > Number.MAX_SAFE_INTEGER - amount
    )
      throw new DomainCommandRejection();
    try {
      d.accounting = applyAccountingTransaction(
        a,
        [
          {
            type: 'payment',
            fromAccountId: firm.accountId,
            toAccountId: recipient.id,
            amount: {
              kind: 'money',
              currencyId: a.currency.id,
              unit: a.currency.unit,
              scale: a.currency.scale,
              minor: amount,
            },
            causeId: `firm-expansion:${firm.id}:${engine.getState().tick + 1}`,
          },
        ],
        `firm-expansion:${firm.id}:${engine.getState().tick + 1}`,
      );
    } catch {
      throw new DomainCommandRejection();
    }
    firm.capacity += p.capacity as number;
    firm.investment = {
      decision: 'expand',
      reason: 'owner-authorized expansion paid to configured construction provider',
      alternatives: ['expand', 'hold'],
    };
  });
  engine.registerCommandHandler('firm.close', (d, payload) => {
    const p = payload as { firmId?: unknown; ownerId?: unknown };
    const firm = (d.firms as FirmState | undefined)?.firms[String(p?.firmId)];
    if (!firm || p.ownerId !== firm.ownerId || firm.status !== 'active')
      throw new DomainCommandRejection();
    firm.status = 'closed';
    firm.closureReason = 'owner-authorized';
    firm.closureTick = engine.getState().tick + 1;
    firm.employment = 0;
  });
  engine.registerPhaseSystem('production', 'z-firms:insolvency', (d) => {
    const fs = d.firms as FirmState | undefined;
    const economy = d.economy as
      { producers: Record<string, { stopped: string | null }> } | undefined;
    if (!fs || !economy) return;
    for (const producer of producers) {
      const firm = fs.firms[producer.id]!;
      if (firm.status !== 'active') continue;
      const qualifies =
        producer.wagePerBatch > 0 && economy.producers[producer.id]?.stopped === 'no-liquidity';
      firm.insolvencyTicks = qualifies ? firm.insolvencyTicks + 1 : 0;
      if (firm.insolvencyTicks >= 2) {
        firm.status = 'insolvent';
        firm.closureReason = 'repeated-wage-liquidity-failure';
        firm.closureTick = engine.getState().tick + 1;
        firm.employment = 0;
      }
    }
  });
  engine.registerPhaseSystem('publish', 'firms:accounting-observation', (d) => {
    const fs = d.firms as FirmState,
      a = d.accounting as AccountingState;
    const entries = a.journal.slice(fs.journalCursor);
    for (const f of Object.values(fs.firms)) {
      f.revenueThisTick = 0;
      f.costThisTick = 0;
      f.capitalOutlayThisTick = 0;
      for (const entry of entries) {
        const effect = entry.effects[0] as { debit?: string; credit?: string; amount?: number };
        if (!effect || !Number.isSafeInteger(effect.amount)) continue;
        if (entry.causeId.startsWith(`wage:${f.id}:`) && effect.debit === f.accountId)
          f.costThisTick += effect.amount!;
        if (entry.causeId.startsWith(`firm-expansion:${f.id}:`) && effect.debit === f.accountId) {
          f.capitalOutlayThisTick += effect.amount!;
          f.cumulativeCapitalOutlay += effect.amount!;
        }
        if (
          entry.type === 'payment' &&
          effect.credit === f.accountId &&
          entry.causeId.startsWith('purchase:')
        )
          f.revenueThisTick += effect.amount!;
      }
      f.profitThisTick = f.revenueThisTick - f.costThisTick;
      f.cumulativeRevenue += f.revenueThisTick;
      f.cumulativeCost += f.costThisTick;
      f.cumulativeProfit += f.profitThisTick;
      f.employment =
        f.status === 'active'
          ? ((d.economy as { producers: Record<string, { employed: number }> }).producers[f.id]
              ?.employed ?? 0)
          : 0;
    }
    fs.journalCursor = a.journal.length;
  });
  engine.registerInvariant((d) => {
    const fs = d.firms as FirmState | undefined;
    if (!fs) return;
    if (
      fs.version !== 1 ||
      fs.configDigest !== configDigest ||
      Object.keys(fs.firms).length !== producers.length
    )
      throw new TypeError('invalid firms state');
    for (const firm of Object.values(fs.firms))
      if (
        !Number.isSafeInteger(firm.capacity) ||
        firm.capacity < 0 ||
        !['active', 'closed', 'insolvent'].includes(firm.status) ||
        !Number.isSafeInteger(firm.employment) ||
        firm.employment < 0 ||
        !Number.isSafeInteger(firm.insolvencyTicks) ||
        firm.insolvencyTicks < 0 ||
        ![
          firm.revenueThisTick,
          firm.costThisTick,
          firm.cumulativeRevenue,
          firm.cumulativeCost,
          firm.capitalOutlayThisTick,
          firm.cumulativeCapitalOutlay,
        ].every((n) => Number.isSafeInteger(n) && n >= 0) ||
        ![firm.profitThisTick, firm.cumulativeProfit].every(Number.isSafeInteger) ||
        (firm.status !== 'active' && (firm.closureReason === null || firm.closureTick === null))
      )
        throw new RangeError('invalid firm lifecycle state');
  });
}
