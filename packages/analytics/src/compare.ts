import { createThreeNations } from '@epcse/scenarios';
import type { Engine, EngineCommand } from '@epcse/simulation-core';
import { projectWorld, type WorldProjection } from './projections.js';

export interface ThreeNationsFoodSubsidyOptions {
  readonly seed?: number;
  /** Opt-in versioned SC-16 setup; omit to run the unchanged default fixture. */
  readonly counterfactualSetupVersion?: 1;
}

export interface CounterfactualProjection {
  readonly tick: number;
  readonly cities: WorldProjection['cities'];
  readonly kingdoms: WorldProjection['kingdoms'];
  readonly world: WorldProjection['world'];
  readonly politics: { readonly satisfactionByGroup: Readonly<Record<string, number>> };
}

export interface ThreeNationsFoodSubsidyComparison {
  readonly label: string;
  readonly baselineVersions: Readonly<{
    schema: number;
    engine: number;
    rules: number;
    canonical: number;
    phase: number;
    fixture: number;
    metrics: number;
  }>;
  readonly baseline: CounterfactualProjection;
  readonly a: CounterfactualProjection;
  readonly b: CounterfactualProjection;
  readonly deltaAminusB: CounterfactualDelta;
  readonly deltaAfromBaseline: CounterfactualDelta;
  readonly deltaBfromBaseline: CounterfactualDelta;
  readonly policy: {
    readonly receipt: { readonly status: string; readonly commandId: string };
    readonly payment: { readonly amount: number; readonly causeId: string } | null;
    /** Number of distinct qualifying treasury-debit journal effects (payment installments). */
    readonly paymentCount: number;
    readonly fundedGuarantee: number;
    /** Sum of ALL qualifying treasury debits, not just the first payment effect. */
    readonly treasuryDebit: number;
  };
  readonly setup: { readonly version: number | null; readonly label: string | null };
  readonly initialBranchSnapshotsIdentical: boolean;
  readonly sourceSnapshotUnchanged: boolean;
  readonly conservation: { readonly a: boolean; readonly b: boolean };
}

export interface CounterfactualDelta {
  readonly cities: Readonly<Record<string, { readonly prices: Readonly<Record<string, number>> }>>;
  readonly kingdoms: Readonly<
    Record<string, { readonly staplePrice: number; readonly treasury: number }>
  >;
  readonly world: {
    readonly treasury: number;
    readonly produced: number;
    readonly consumed: number;
    readonly unmet: number;
    readonly departed: number;
    readonly arrived: number;
  };
  readonly politics: { readonly satisfactionByGroup: Readonly<Record<string, number>> };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function project(engine: Engine, tick: number): CounterfactualProjection {
  const domain = engine.getState().domain;
  const world = projectWorld(domain, tick);
  const politics = asRecord(domain.politics);
  const decisions = Array.isArray(politics.decisions) ? politics.decisions : [];
  const satisfactionByGroup: Record<string, number> = {};
  for (const item of decisions) {
    const decision = asRecord(item);
    const information = Array.isArray(decision.information) ? decision.information : [];
    const signal = information.find(
      (value) => typeof value === 'string' && value.startsWith('satisfaction='),
    );
    if (typeof decision.agentId === 'string' && typeof signal === 'string') {
      const value = Number(signal.slice('satisfaction='.length));
      if (Number.isFinite(value)) satisfactionByGroup[decision.agentId] = value;
    }
  }
  return {
    tick,
    cities: world.cities,
    kingdoms: world.kingdoms,
    world: world.world,
    politics: { satisfactionByGroup },
  };
}

function assertMoneyConserved(engine: Engine): boolean {
  const accounting = asRecord(engine.getState().domain.accounting);
  const accounts = Array.isArray(accounting.accounts) ? accounting.accounts : [];
  const opening = Array.isArray(accounting.openingBalances) ? accounting.openingBalances : [];
  const balance = (rows: unknown[]) =>
    rows.reduce<number>((sum, row) => sum + Number(asRecord(row).balance ?? 0), 0);
  return (
    accounts.every((row) => Number(asRecord(row).balance) >= 0) &&
    balance(accounts) === balance(opening)
  );
}

/**
 * Collects EVERY journal effect that debits the policy kingdom's treasury against an
 * actual purchase settled under the given subsidy policy. A food-subsidy guarantee may be
 * paid in several installments (each purchase below the remaining guarantee produces its
 * own journal entry), so aggregation over all entries — not just the first — is required
 * for honest treasury reconciliation. Pure function over the journal; no engine access.
 */
export function collectSubsidyTreasuryDebits(
  journal: unknown,
  policyId: string,
): ReadonlyArray<{ readonly debit: string; readonly amount: number; readonly causeId: string }> {
  const rows = Array.isArray(journal) ? journal : [];
  const causePrefix = `government:${policyId}:purchase:`;
  const effects: { debit: string; amount: number; causeId: string }[] = [];
  for (const item of rows) {
    const entry = asRecord(item);
    if (typeof entry.causeId !== 'string' || !entry.causeId.startsWith(causePrefix)) continue;
    for (const effect of Array.isArray(entry.effects) ? entry.effects : []) {
      const value = asRecord(effect);
      if (value.debit === 'plains-treasury' && typeof value.amount === 'number') {
        effects.push({ debit: value.debit, amount: value.amount, causeId: entry.causeId });
      }
    }
  }
  return effects;
}

function delta<T extends Record<string, number>>(a: T, b: T): Record<string, number> {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return Object.fromEntries([...keys].sort().map((key) => [key, (a[key] ?? 0) - (b[key] ?? 0)]));
}

function compareProjections(
  a: CounterfactualProjection,
  b: CounterfactualProjection,
): CounterfactualDelta {
  const cityIds = new Set([...Object.keys(a.cities), ...Object.keys(b.cities)]);
  const kingdomIds = new Set([...Object.keys(a.kingdoms), ...Object.keys(b.kingdoms)]);
  return {
    cities: Object.fromEntries(
      [...cityIds].sort().map((id) => [
        id,
        {
          prices: delta(a.cities[id]?.prices ?? {}, b.cities[id]?.prices ?? {}),
        },
      ]),
    ),
    kingdoms: Object.fromEntries(
      [...kingdomIds].sort().map((id) => [
        id,
        {
          staplePrice: (a.kingdoms[id]?.staplePrice ?? 0) - (b.kingdoms[id]?.staplePrice ?? 0),
          treasury: (a.kingdoms[id]?.treasury ?? 0) - (b.kingdoms[id]?.treasury ?? 0),
        },
      ]),
    ),
    world: {
      treasury: a.world.treasury - b.world.treasury,
      produced: a.world.produced - b.world.produced,
      consumed: a.world.consumed - b.world.consumed,
      unmet: a.world.unmet - b.world.unmet,
      departed: a.world.departed - b.world.departed,
      arrived: a.world.arrived - b.world.arrived,
    },
    politics: {
      satisfactionByGroup: delta(a.politics.satisfactionByGroup, b.politics.satisfactionByGroup),
    },
  };
}

/**
 * Runs the fixture-owned SC-16 experiment. Callers provide only a seed; trusted initial state,
 * snapshots, registrations, and policy recipients are built internally from the pinned fixture.
 */
export function compareThreeNationsFoodSubsidy(
  options: ThreeNationsFoodSubsidyOptions = {},
): ThreeNationsFoodSubsidyComparison {
  const seed = options.seed ?? 42;
  const optionsForFixture = {
    seed,
    ticks: 300,
    ...(options.counterfactualSetupVersion !== undefined
      ? { counterfactualSetupVersion: options.counterfactualSetupVersion }
      : {}),
  } as const;
  const source = createThreeNations(optionsForFixture);
  const { engine, commandsForTick } = source;
  for (let tick = 1; tick <= 200; tick++) {
    for (const command of commandsForTick(tick)) engine.submit(command);
  }
  engine.run(200);
  const sourceText = engine.snapshotText();
  const snapshot = engine.snapshot();
  const metrics = asRecord(snapshot.domain['three-nations:metrics']);
  if (snapshot.tick !== 200 || metrics.version !== 2)
    throw new Error('INCOMPATIBLE_VERSION: expected tick-200 fixture metrics v2');
  const baselineVersions = {
    schema: snapshot.schemaVersion,
    engine: snapshot.engineVersion,
    rules: snapshot.rulesVersion,
    canonical: snapshot.canonicalVersion,
    phase: snapshot.phaseVersion,
    fixture: source.config.fixtureVersion,
    metrics: metrics.version,
  };
  const baseline = project(engine, 200);

  const makeBranch = () => {
    const branch = createThreeNations(optionsForFixture).engine;
    branch.restore(sourceText);
    if (branch.snapshotText() !== sourceText) throw new Error('restored branch snapshot mismatch');
    return branch;
  };
  const a = makeBranch();
  const b = makeBranch();
  const initialBranchSnapshotsIdentical = a.snapshotText() === b.snapshotText();
  if (!initialBranchSnapshotsIdentical) throw new Error('counterfactual branch state mismatch');

  const recipient = asRecord(asRecord(a.getState().domain.economy).configCohorts);
  const cohort = asRecord(recipient['plain-central-residents']);
  const accountId = cohort.accountId;
  const ownerId = cohort.ownerId;
  if (typeof accountId !== 'string' || typeof ownerId !== 'string')
    throw new Error('fixture food-subsidy recipient is unavailable');
  const policyCommandId = 'sc16-food-subsidy-policy-a';
  const guarantee = 10;
  const command: EngineCommand = {
    commandId: policyCommandId,
    type: 'government.policy',
    requestedTick: 201,
    payload: {
      kingdomId: 'plains',
      governmentId: 'plains',
      variant: 'food-subsidy',
      policyId: 'sc16-food-subsidy-a',
      recipientKingdomId: 'plains',
      recipientOwnerId: ownerId,
      recipientAccountId: accountId,
      commodity: 'grain',
      amount: guarantee,
      effectiveTick: 204,
      expiryTick: 300,
      legitimacy: 80,
      quorum: 0,
      support: 80,
      oppositionVeto: false,
    },
  };
  a.submit(command);
  for (let tick = 201; tick <= 300; tick++) {
    for (const scheduled of commandsForTick(tick)) {
      a.submit(scheduled);
      b.submit(scheduled);
    }
  }
  a.run(100);
  b.run(100);

  const receipt = a.receipts().find((item) => item.commandId === policyCommandId);
  if (receipt?.status !== 'applied')
    throw new Error(`food-subsidy policy was not applied: ${JSON.stringify(receipt)}`);
  const accounting = asRecord(a.getState().domain.accounting);
  const journal = Array.isArray(accounting.journal) ? accounting.journal : [];
  const qualifying = collectSubsidyTreasuryDebits(journal, 'sc16-food-subsidy-a');
  const payment = qualifying[0] ?? null;
  const treasuryDebit = qualifying.reduce((sum, effect) => sum + effect.amount, 0);
  const finalA = project(a, 300);
  const finalB = project(b, 300);
  const sourceSnapshotUnchanged = engine.snapshotText() === sourceText;
  if (!sourceSnapshotUnchanged) throw new Error('source engine changed while branching');
  return {
    label: 'Model outcomes in this fixture; differences are not scientific causal effects.',
    baselineVersions,
    baseline,
    a: finalA,
    b: finalB,
    deltaAminusB: compareProjections(finalA, finalB),
    deltaAfromBaseline: compareProjections(finalA, baseline),
    deltaBfromBaseline: compareProjections(finalB, baseline),
    policy: {
      receipt: { status: receipt.status, commandId: receipt.commandId },
      payment:
        payment && typeof payment.amount === 'number' && typeof payment.causeId === 'string'
          ? { amount: payment.amount, causeId: payment.causeId }
          : null,
      paymentCount: qualifying.length,
      fundedGuarantee: guarantee,
      treasuryDebit,
    },
    setup: {
      version: source.config.counterfactualSetupVersion,
      label: source.config.counterfactualSetupLabel,
    },
    initialBranchSnapshotsIdentical,
    sourceSnapshotUnchanged,
    conservation: { a: assertMoneyConserved(a), b: assertMoneyConserved(b) },
  };
}
