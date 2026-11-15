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
  administration?: { wagePerBatch: number };
  relocationProposal?: { cityId: string; ownerId: string; submittedTick: number } | null;
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
  const payForCapacity = (
    d: Record<string, unknown>,
    firm: Firm,
    capacity: number,
    cause: string,
  ) => {
    const a = d.accounting as AccountingState;
    const amount = capacity * config.expansionCostPerCapacity;
    const payer = a.accounts.find((x) => x.id === firm.accountId);
    const recipient = a.accounts.find((x) => x.id === config.constructionAccountId);
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      !payer ||
      !recipient ||
      payer.ownerId !== firm.ownerId ||
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
            fromAccountId: payer.id,
            toAccountId: recipient.id,
            amount: {
              kind: 'money',
              currencyId: a.currency.id,
              unit: a.currency.unit,
              scale: a.currency.scale,
              minor: amount,
            },
            causeId: cause,
          },
        ],
        cause,
      );
    } catch {
      throw new DomainCommandRejection();
    }
  };
  engine.registerCommandHandler('firm.build', (d, payload) => {
    const p = payload as (Partial<LocalEconomyProducer> & { firmId?: unknown }) | null;
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new DomainCommandRejection();
    const id = p.firmId;
    const fs = d.firms as FirmState | undefined,
      a = d.accounting as AccountingState | undefined;
    const e = d.economy as
      | {
          producers: Record<
            string,
            LocalEconomyProducer & { stopped: string | null; batches: number; employed: number }
          >;
        }
      | undefined;
    if (
      !p ||
      !fs ||
      !a ||
      !e ||
      typeof id !== 'string' ||
      !id.trim() ||
      ['__proto__', 'prototype', 'constructor'].includes(id) ||
      Object.hasOwn(fs.firms, id) ||
      Object.hasOwn(e.producers, id) ||
      typeof p.ownerId !== 'string' ||
      !p.ownerId.trim() ||
      typeof p.accountId !== 'string' ||
      !p.accountId.trim() ||
      typeof p.cityId !== 'string' ||
      !p.cityId.trim() ||
      typeof p.recipeId !== 'string' ||
      !Number.isSafeInteger(p.laborPerBatch) ||
      p.laborPerBatch! <= 0 ||
      !Number.isSafeInteger(p.maxBatches) ||
      p.maxBatches! <= 0 ||
      p.maxBatches! > 1000 ||
      !Number.isSafeInteger(p.wagePerBatch) ||
      p.wagePerBatch! < 0 ||
      (p.requiredSkills !== undefined &&
        (!p.requiredSkills ||
          typeof p.requiredSkills !== 'object' ||
          Array.isArray(p.requiredSkills) ||
          Object.entries(p.requiredSkills).some(
            ([skill, level]) => !skill.trim() || !Number.isSafeInteger(level) || level < 0,
          ))) ||
      !a.owners.includes(p.ownerId) ||
      a.accounts.find((x) => x.id === p.accountId)?.ownerId !== p.ownerId ||
      !a.recipes.some((x) => x.id === p.recipeId) ||
      p.accountId === config.constructionAccountId ||
      a.accounts.find((x) => x.id === p.accountId)?.ownerId ===
        a.accounts.find((x) => x.id === config.constructionAccountId)?.ownerId ||
      Object.values(fs.firms).some((f) => f.ownerId === p.ownerId || f.accountId === p.accountId)
    )
      throw new DomainCommandRejection();
    const producer = { ...p, id } as LocalEconomyProducer;
    const firm = {
      ...producer,
      capacity: p.maxBatches!,
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
        reason: 'new construction',
        alternatives: ['expand', 'hold'],
      },
      administration: { wagePerBatch: p.wagePerBatch! },
      relocationProposal: null,
    } as Firm;
    payForCapacity(d, firm, p.maxBatches!, `firm-build:${id}:${engine.getState().tick + 1}`);
    fs.firms[id] = firm;
    e.producers[id] = {
      ...producer,
      requiredSkills: p.requiredSkills ?? {},
      stopped: null,
      batches: 0,
      employed: 0,
    } as (typeof e.producers)[string];
  });
  engine.registerCommandHandler('firm.upgrade', (d, payload) => {
    const p = payload as { firmId?: unknown; ownerId?: unknown; capacity?: unknown };
    const fs = d.firms as FirmState | undefined,
      firm = fs?.firms[String(p?.firmId)];
    if (
      !firm ||
      p.ownerId !== firm.ownerId ||
      !Number.isSafeInteger(p.capacity) ||
      (p.capacity as number) <= 0 ||
      firm.status !== 'active' ||
      firm.capacity > 1000 - (p.capacity as number)
    )
      throw new DomainCommandRejection();
    payForCapacity(
      d,
      firm,
      p.capacity as number,
      `firm-upgrade:${firm.id}:${engine.getState().tick + 1}`,
    );
    firm.capacity += p.capacity as number;
  });
  engine.registerCommandHandler('firm.administration', (d, payload) => {
    const p = payload as { firmId?: unknown; ownerId?: unknown; wagePerBatch?: unknown };
    const fs = d.firms as FirmState | undefined,
      e = d.economy as { producers: Record<string, { wagePerBatch: number }> } | undefined,
      firm = fs?.firms[String(p?.firmId)];
    if (
      !firm ||
      !e?.producers[firm.id] ||
      p.ownerId !== firm.ownerId ||
      !Number.isSafeInteger(p.wagePerBatch) ||
      (p.wagePerBatch as number) < 0 ||
      firm.status !== 'active'
    )
      throw new DomainCommandRejection();
    e.producers[firm.id]!.wagePerBatch = p.wagePerBatch as number;
    firm.wagePerBatch = p.wagePerBatch as number;
    firm.administration = { wagePerBatch: p.wagePerBatch as number };
  });
  engine.registerCommandHandler('firm.price', (d, payload) => {
    const p = (payload ?? {}) as {
      firmId?: unknown;
      ownerId?: unknown;
      commodity?: unknown;
      minPrice?: unknown;
      maxPrice?: unknown;
      openingPrice?: unknown;
    };
    const firm = (d.firms as FirmState | undefined)?.firms[String(p?.firmId)],
      e = d.economy as
        | {
            sellers: Record<
              string,
              {
                cityId: string;
                ownerId: string;
                accountId: string;
                commodity: string;
                minPrice: number;
                maxPrice: number;
                openingPrice: number;
                price: number;
                reason: string;
              }
            >;
          }
        | undefined;
    const sellers = Object.values(e?.sellers ?? {}).filter(
      (s) =>
        s.cityId === firm?.cityId &&
        s.ownerId === firm?.ownerId &&
        s.accountId === firm?.accountId &&
        s.commodity === p.commodity,
    );
    if (
      !firm ||
      p.ownerId !== firm.ownerId ||
      !sellers.length ||
      ![p.minPrice, p.maxPrice, p.openingPrice].every(Number.isSafeInteger) ||
      (p.minPrice as number) <= 0 ||
      (p.maxPrice as number) < (p.minPrice as number) ||
      (p.openingPrice as number) < (p.minPrice as number) ||
      (p.openingPrice as number) > (p.maxPrice as number)
    )
      throw new DomainCommandRejection();
    for (const seller of sellers)
      Object.assign(seller, {
        minPrice: p.minPrice as number,
        maxPrice: p.maxPrice as number,
        openingPrice: p.openingPrice as number,
        price: p.openingPrice as number,
        reason: 'owner-price-command',
      });
  });
  engine.registerCommandHandler('firm.relocation.propose', (d, payload) => {
    const p = payload as { firmId?: unknown; ownerId?: unknown; cityId?: unknown };
    const firm = (d.firms as FirmState | undefined)?.firms[String(p?.firmId)];
    const cityState = d.cities as { cities?: Record<string, unknown> } | undefined;
    const economy = d.economy as
      | {
          producers?: Record<string, { cityId?: unknown }>;
          configCohorts?: Record<string, { cityId?: unknown }>;
          sellers?: Record<string, { cityId?: unknown }>;
        }
      | undefined;
    const knownCities = cityState?.cities
      ? new Set(Object.keys(cityState.cities))
      : new Set(
          [
            ...Object.values(economy?.producers ?? {}).map((x) => x.cityId),
            ...Object.values(economy?.configCohorts ?? {}).map((x) => x.cityId),
            ...Object.values(economy?.sellers ?? {}).map((x) => x.cityId),
          ].filter((cityId): cityId is string => typeof cityId === 'string'),
        );
    if (
      !firm ||
      p.ownerId !== firm.ownerId ||
      typeof p.cityId !== 'string' ||
      !p.cityId.trim() ||
      p.cityId === firm.cityId ||
      !knownCities.has(p.cityId) ||
      ['__proto__', 'prototype', 'constructor'].includes(p.cityId)
    )
      throw new DomainCommandRejection();
    firm.relocationProposal = {
      cityId: p.cityId,
      ownerId: firm.ownerId,
      submittedTick: engine.getState().tick + 1,
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
    for (const firm of Object.values(fs.firms)) {
      const producer = firm;
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
        if (
          (entry.causeId.startsWith(`firm-expansion:${f.id}:`) ||
            entry.causeId.startsWith(`firm-build:${f.id}:`) ||
            entry.causeId.startsWith(`firm-upgrade:${f.id}:`)) &&
          effect.debit === f.accountId
        ) {
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
      producers.some((producer) => !fs.firms[producer.id])
    )
      throw new TypeError('invalid firms state');
    const ledger = d.accounting as AccountingState | undefined;
    const economy = d.economy as { producers?: Record<string, LocalEconomyProducer> } | undefined;
    if (
      !ledger ||
      !economy?.producers ||
      Object.keys(fs.firms).length !== Object.keys(economy.producers).length
    )
      throw new TypeError('firm/economy identities diverged');
    for (const [id, firm] of Object.entries(fs.firms)) {
      const producer = economy.producers[id];
      if (
        !producer ||
        producer.ownerId !== firm.ownerId ||
        producer.accountId !== firm.accountId ||
        producer.cityId !== firm.cityId ||
        producer.recipeId !== firm.recipeId ||
        ledger.accounts.find((account) => account.id === firm.accountId)?.ownerId !== firm.ownerId
      )
        throw new TypeError('invalid live firm identity');
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
    }
  });
}
