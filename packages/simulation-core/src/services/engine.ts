import {
  DomainCommandRejection,
  type CommandHandler,
  type EngineCommand,
  type CommandReceipt,
} from '../models/commands.js';
import type { EngineConfig, EngineSnapshot, EngineView } from '../models/world.js';
import type { EngineEvent } from '../models/events.js';
import { canonical, cloneJson, hash } from '../shared/canonical.js';
import { decodeJson } from './codec.js';
import { Mulberry32 } from './rng.js';
import { PHASES, type PhaseName } from './phases.js';
import { compareCommands, queuedReceipt, sameEnvelope, type QueuedCommand } from './scheduler.js';

export interface Engine {
  submit(command: EngineCommand): CommandReceipt;
  step(): EngineView;
  run(ticks: number): EngineView;
  pause(): void;
  resume(): void;
  isPaused(): boolean;
  getState(): EngineView;
  events(): readonly EngineEvent[];
  receipts(): readonly CommandReceipt[];
  snapshot(): EngineSnapshot;
  snapshotText(): string;
  restore(snapshot: EngineSnapshot | string): void;
  registerCommandHandler(type: string, handler: CommandHandler): void;
  registerPhaseSystem(
    phase: PhaseName,
    name: string,
    system: (draft: Record<string, unknown>, drawRandom: () => number) => unknown,
  ): void;
  registerInvariant(invariant: (domain: Readonly<Record<string, unknown>>) => void): void;
  drawRandom(): number;
}
const versions = {
  schemaVersion: 1,
  engineVersion: 1,
  rulesVersion: 1,
  canonicalVersion: 1,
  phaseVersion: 1,
} as const;
function validateConfig(config: EngineConfig): EngineConfig {
  const copy = cloneJson(config);
  if (copy === null || typeof copy !== 'object' || Array.isArray(copy))
    throw new TypeError('config must be a plain object');
  if (copy.worldId !== undefined && (typeof copy.worldId !== 'string' || !copy.worldId))
    throw new TypeError('worldId must be a nonempty string');
  if (
    copy.initialState !== undefined &&
    (copy.initialState === null ||
      typeof copy.initialState !== 'object' ||
      Array.isArray(copy.initialState))
  )
    throw new TypeError('initialState must be an object');
  return copy;
}
export function createEngine(config: EngineConfig, seed: number): Engine {
  const safeConfig = validateConfig(config);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)
    throw new RangeError('seed must be uint32');
  let domain = cloneJson(safeConfig.initialState ?? {});
  let tick = 0,
    rngState = seed >>> 0,
    nextSequence = 1,
    nextEventId = 1,
    paused = false,
    advancing = false;
  let queue: QueuedCommand[] = [],
    receiptMap = new Map<string, CommandReceipt>(),
    envelopes = new Map<string, EngineCommand>(),
    eventLog: EngineEvent[] = [];
  const handlers = new Map<string, CommandHandler>();
  const phaseSystems = new Map<
    PhaseName,
    Map<string, (draft: Record<string, unknown>, drawRandom: () => number) => unknown>
  >();
  const invariants: Array<(domain: Readonly<Record<string, unknown>>) => void> = [];
  const verifyInvariants = (candidate: Record<string, unknown> = domain): void => {
    cloneJson(candidate);
    for (const invariant of invariants) invariant(cloneJson(candidate));
  };
  handlers.set('transfer', (draft, payload) => {
    if (!payload || typeof payload !== 'object') throw new DomainCommandRejection();
    const p = payload as { from?: unknown; to?: unknown; amount?: unknown };
    if (
      typeof p.from !== 'string' ||
      typeof p.to !== 'string' ||
      !Number.isSafeInteger(p.amount) ||
      (p.amount as number) <= 0
    )
      throw new DomainCommandRejection();
    const balances = draft.balances;
    if (!balances || typeof balances !== 'object' || Array.isArray(balances))
      throw new DomainCommandRejection();
    const b = balances as Record<string, number>,
      amount = p.amount as number;
    if (
      !Number.isSafeInteger(b[p.from]) ||
      !Number.isSafeInteger(b[p.to]) ||
      b[p.from]! < amount ||
      b[p.to]! > Number.MAX_SAFE_INTEGER - amount
    )
      throw new DomainCommandRejection();
    b[p.from] = b[p.from]! - amount;
    b[p.to] = b[p.to]! + amount;
  });
  const view = (): EngineView => ({
    tick,
    domain: cloneJson(domain),
    hash: hash({ ...api.snapshot(), events: [] }),
    eventHash: hash(eventLog),
  });
  const reject = (commandId: string, requestedTick: number, code: string): CommandReceipt => ({
    receiptVersion: 1,
    commandId,
    status: 'rejected',
    requestedTick,
    appliedTick: null,
    sequence: null,
    errorCode: code,
  });
  const api: Engine = {
    submit(command) {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      try {
        if (!command || typeof command !== 'object') return reject('', 0, 'INVALID');
        const input = cloneJson(command);
        if (
          typeof input.commandId !== 'string' ||
          !input.commandId ||
          typeof input.type !== 'string' ||
          !input.type ||
          (input.commandVersion !== undefined && input.commandVersion !== 1) ||
          (input.worldId !== undefined && input.worldId !== (safeConfig.worldId ?? 'default')) ||
          input.sequence !== undefined ||
          !Number.isSafeInteger(input.requestedTick) ||
          input.requestedTick < 1
        )
          return reject(input.commandId ?? '', input.requestedTick ?? 0, 'INVALID');
        const normalized = cloneJson({
          ...input,
          commandVersion: 1 as const,
          worldId: input.worldId ?? safeConfig.worldId ?? 'default',
        });
        const existing = envelopes.get(command.commandId);
        if (existing)
          return sameEnvelope(existing, normalized)
            ? cloneJson(receiptMap.get(command.commandId)!)
            : reject(command.commandId, command.requestedTick, 'DUPLICATE_CONFLICT');
        if (command.requestedTick <= tick)
          return reject(command.commandId, command.requestedTick, 'LATE');
        const queued: QueuedCommand = { ...normalized, sequence: nextSequence++ };
        envelopes.set(command.commandId, queued);
        queue.push(queued);
        queue.sort(compareCommands);
        const receipt = queuedReceipt(queued);
        receiptMap.set(command.commandId, receipt);
        return cloneJson(receipt);
      } catch {
        return reject(command?.commandId ?? '', command?.requestedTick ?? 0, 'INVALID');
      }
    },
    step() {
      return api.run(1);
    },
    run(count) {
      if (!Number.isSafeInteger(count) || count < 0 || count > Number.MAX_SAFE_INTEGER - tick)
        throw new RangeError('invalid tick count');
      if (advancing) throw new Error('reentrant advancement');
      if (paused && count > 0) throw new Error('engine is paused');
      advancing = true;
      try {
        for (let n = 0; n < count; n++) {
          const before = {
            domain,
            tick,
            rngState,
            nextSequence,
            nextEventId,
            queue,
            receiptMap,
            envelopes,
            eventLog,
          };
          domain = cloneJson(domain);
          queue = [...queue];
          receiptMap = new Map(receiptMap);
          envelopes = new Map(envelopes);
          eventLog = [...eventLog];
          try {
            const current = tick + 1;
            for (const phase of PHASES) {
              if (phase === 'commands') {
                for (const command of queue.filter((item) => item.requestedTick <= current)) {
                  const draft = cloneJson(domain);
                  const rngBeforeCommand = rngState;
                  try {
                    const handler = handlers.get(command.type);
                    if (!handler) throw new DomainCommandRejection();
                    const result: unknown = handler(draft, cloneJson(command.payload));
                    if (result && typeof (result as { then?: unknown }).then === 'function') {
                      void Promise.resolve(result).catch(() => undefined);
                      throw new TypeError('command handlers must be synchronous');
                    }
                    verifyInvariants(draft);
                    domain = cloneJson(draft);
                    const receipt: CommandReceipt = {
                      ...receiptMap.get(command.commandId)!,
                      status: 'applied',
                      appliedTick: current,
                      errorCode: null,
                    };
                    receiptMap.set(command.commandId, receipt);
                    eventLog.push({
                      eventId: `event-${nextEventId++}`,
                      tick: current,
                      phase: 1,
                      sequence: command.sequence,
                      type: command.type,
                      commandId: command.commandId,
                    });
                  } catch (error) {
                    if (!(error instanceof DomainCommandRejection)) throw error;
                    rngState = rngBeforeCommand;
                    receiptMap.set(command.commandId, {
                      ...receiptMap.get(command.commandId)!,
                      status: 'rejected',
                      errorCode: error.code,
                    });
                  }
                  queue = queue.filter((item) => item.commandId !== command.commandId);
                }
              }
              const systems = [...(phaseSystems.get(phase)?.entries() ?? [])].sort(([a], [b]) =>
                a < b ? -1 : a > b ? 1 : 0,
              );
              for (const [, system] of systems) {
                const draft = cloneJson(domain);
                const result = system(draft, api.drawRandom);
                if (result && typeof (result as { then?: unknown }).then === 'function') {
                  void Promise.resolve(result).catch(() => undefined);
                  throw new TypeError('phase systems must be synchronous');
                }
                verifyInvariants(draft);
                domain = cloneJson(draft);
              }
            }
            verifyInvariants();
            tick = current;
          } catch (error) {
            domain = before.domain;
            tick = before.tick;
            rngState = before.rngState;
            nextSequence = before.nextSequence;
            nextEventId = before.nextEventId;
            queue = before.queue;
            receiptMap = before.receiptMap;
            envelopes = before.envelopes;
            eventLog = before.eventLog;
            throw error;
          }
        }
      } finally {
        advancing = false;
      }
      return view();
    },
    pause() {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      paused = true;
    },
    resume() {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      paused = false;
    },
    isPaused() {
      return paused;
    },
    getState: view,
    events() {
      return cloneJson(eventLog);
    },
    receipts() {
      return cloneJson([...receiptMap.values()]);
    },
    snapshot() {
      return {
        ...versions,
        config: cloneJson(safeConfig),
        seed,
        tick,
        rngState,
        nextSequence,
        nextEventId,
        domain: cloneJson(domain),
        queue: cloneJson(queue),
        receipts: cloneJson([...receiptMap.values()]),
        envelopes: cloneJson([...envelopes.values()]),
        events: cloneJson(eventLog),
      };
    },
    snapshotText() {
      return canonical(api.snapshot());
    },
    restore(input) {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      const parsed = typeof input === 'string' ? decodeJson(input) : cloneJson(input);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new TypeError('invalid snapshot');
      const s = parsed as EngineSnapshot;
      for (const key of Object.keys(versions) as (keyof typeof versions)[])
        if (s[key] !== versions[key]) throw new Error('INCOMPATIBLE_VERSION');
      const restoredConfig = validateConfig(s.config);
      if (
        hash(restoredConfig) !== hash(safeConfig) ||
        s.seed !== seed ||
        !Number.isSafeInteger(s.tick) ||
        s.tick < 0 ||
        !Number.isSafeInteger(s.rngState) ||
        s.rngState < 0 ||
        s.rngState > 0xffffffff
      )
        throw new Error('invalid snapshot');
      if (
        !Array.isArray(s.queue) ||
        !Array.isArray(s.receipts) ||
        !Array.isArray(s.envelopes) ||
        !Array.isArray(s.events) ||
        !Number.isSafeInteger(s.nextSequence) ||
        s.nextSequence < 1 ||
        !Number.isSafeInteger(s.nextEventId) ||
        s.nextEventId < 1
      )
        throw new TypeError('invalid snapshot collections or counters');
      const nextDomain = cloneJson(s.domain);
      if (!nextDomain || typeof nextDomain !== 'object' || Array.isArray(nextDomain))
        throw new TypeError('invalid snapshot domain');
      const nextQueue = cloneJson(s.queue) as QueuedCommand[];
      const receiptList = cloneJson(s.receipts) as CommandReceipt[];
      const envelopeList = cloneJson(s.envelopes) as EngineCommand[];
      const nextEvents = cloneJson(s.events) as EngineEvent[];
      const nextReceipts = new Map<string, CommandReceipt>();
      for (const receipt of receiptList) {
        if (
          !receipt ||
          typeof receipt.commandId !== 'string' ||
          !receipt.commandId ||
          receipt.receiptVersion !== 1 ||
          !['queued', 'applied', 'rejected'].includes(receipt.status) ||
          !Number.isSafeInteger(receipt.requestedTick) ||
          receipt.requestedTick < 1 ||
          !Number.isSafeInteger(receipt.sequence) ||
          receipt.sequence! < 1 ||
          receipt.sequence! >= s.nextSequence ||
          (receipt.status === 'queued' &&
            (receipt.appliedTick !== null || receipt.errorCode !== null)) ||
          (receipt.status === 'applied' &&
            (!Number.isSafeInteger(receipt.appliedTick) ||
              receipt.appliedTick! < 1 ||
              receipt.appliedTick! > s.tick ||
              receipt.errorCode !== null)) ||
          (receipt.status === 'rejected' &&
            (receipt.appliedTick !== null ||
              typeof receipt.errorCode !== 'string' ||
              !receipt.errorCode)) ||
          nextReceipts.has(receipt.commandId)
        )
          throw new TypeError('invalid or duplicate snapshot receipt');
        nextReceipts.set(receipt.commandId, receipt);
      }
      const nextEnvelopes = new Map<string, EngineCommand>();
      for (const command of envelopeList) {
        if (
          !command ||
          typeof command.commandId !== 'string' ||
          command.commandVersion !== 1 ||
          typeof command.worldId !== 'string' ||
          !command.worldId ||
          !Number.isSafeInteger(command.sequence) ||
          command.sequence! < 1 ||
          command.sequence! >= s.nextSequence ||
          !Number.isSafeInteger(command.requestedTick) ||
          command.requestedTick < 1 ||
          typeof command.type !== 'string' ||
          !command.type ||
          command.worldId !== (safeConfig.worldId ?? 'default') ||
          nextEnvelopes.has(command.commandId)
        )
          throw new TypeError('invalid or duplicate snapshot envelope');
        nextEnvelopes.set(command.commandId, command);
      }
      if (
        nextEnvelopes.size !== nextReceipts.size ||
        envelopeList.some((command) => {
          const receipt = nextReceipts.get(command.commandId);
          return (
            !receipt ||
            receipt.requestedTick !== command.requestedTick ||
            receipt.sequence !== command.sequence
          );
        }) ||
        new Set(envelopeList.map((command) => command.sequence)).size !== envelopeList.length
      )
        throw new TypeError('inconsistent snapshot envelopes and receipts');
      const queuedIds = new Set<string>();
      for (const command of nextQueue) {
        if (
          !command ||
          typeof command.commandId !== 'string' ||
          queuedIds.has(command.commandId) ||
          !Number.isSafeInteger(command.sequence) ||
          command.sequence < 1 ||
          !Number.isSafeInteger(command.requestedTick) ||
          command.requestedTick <= s.tick ||
          !nextReceipts.has(command.commandId) ||
          !nextEnvelopes.has(command.commandId) ||
          nextReceipts.get(command.commandId)!.status !== 'queued' ||
          canonical(nextEnvelopes.get(command.commandId)) !== canonical(command)
        )
          throw new TypeError('invalid or duplicate queued command');
        queuedIds.add(command.commandId);
      }
      if (
        receiptList.some(
          (receipt) => (receipt.status === 'queued') !== queuedIds.has(receipt.commandId),
        ) ||
        nextQueue.some(
          (command, index) => index > 0 && compareCommands(nextQueue[index - 1]!, command) > 0,
        ) ||
        nextEvents.some(
          (event, index) =>
            !event ||
            event.eventId !== `event-${index + 1}` ||
            !Number.isSafeInteger(event.tick) ||
            event.tick < 1 ||
            event.tick > s.tick ||
            event.phase !== 1 ||
            !nextReceipts.has(event.commandId) ||
            nextReceipts.get(event.commandId)!.status !== 'applied',
        ) ||
        s.nextEventId !== nextEvents.length + 1
      )
        throw new TypeError('invalid snapshot ordering, sequence, or event IDs');
      const applied = receiptList.filter((receipt) => receipt.status === 'applied');
      if (
        applied.length !== nextEvents.length ||
        new Set(nextEvents.map((event) => event.commandId)).size !== nextEvents.length ||
        nextEvents.some((event) => {
          const receipt = nextReceipts.get(event.commandId)!;
          const envelope = nextEnvelopes.get(event.commandId)!;
          return (
            event.tick !== receipt.appliedTick ||
            event.sequence !== receipt.sequence ||
            event.type !== envelope.type ||
            event.tick !== envelope.requestedTick
          );
        })
      )
        throw new TypeError('inconsistent snapshot event history');
      verifyInvariants(nextDomain);
      domain = nextDomain;
      queue = nextQueue;
      receiptMap = nextReceipts;
      envelopes = nextEnvelopes;
      eventLog = nextEvents;
      tick = s.tick;
      rngState = s.rngState;
      nextSequence = s.nextSequence;
      nextEventId = s.nextEventId;
    },
    registerCommandHandler(type, handler) {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      if (!type || handlers.has(type) || typeof handler !== 'function')
        throw new Error('invalid or duplicate handler');
      handlers.set(type, handler);
    },
    registerPhaseSystem(phase, name, system) {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      if (!PHASES.includes(phase) || !name || typeof system !== 'function')
        throw new TypeError('invalid phase system');
      const systems = phaseSystems.get(phase) ?? new Map();
      if (systems.has(name)) throw new Error(`duplicate phase system: ${name}`);
      systems.set(name, system);
      phaseSystems.set(phase, systems);
    },
    registerInvariant(invariant) {
      if (advancing) throw new Error('engine mutation is not allowed during a tick');
      if (typeof invariant !== 'function') throw new TypeError('invariant must be a function');
      invariants.push(invariant);
    },
    drawRandom() {
      if (!advancing) throw new Error('random draws require an active tick');
      const rng = new Mulberry32(rngState);
      const value = rng.next();
      rngState = rng.state;
      return value;
    },
  };
  return api;
}
