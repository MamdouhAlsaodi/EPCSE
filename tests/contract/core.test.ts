import { describe, expect, it } from 'vitest';
import { createEngine, DomainCommandRejection } from '../../packages/simulation-core/src/index.js';

describe('synchronous engine contract', () => {
  it('rolls back an infrastructure failure after a staged debit', () => {
    const engine = createEngine({ initialState: { balances: { a: 10, b: 0 } } }, 7);
    engine.registerCommandHandler('broken-transfer', (draft) => {
      const balances = draft.balances as Record<string, number>;
      balances.a = balances.a! - 4;
      engine.drawRandom();
      throw new Error('infrastructure failure');
    });
    engine.submit({
      commandId: 'broken',
      requestedTick: 1,
      type: 'broken-transfer',
      payload: null,
    });
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow('infrastructure failure');
    expect(engine.snapshotText()).toBe(before);
    expect(engine.getState().domain).toEqual({ balances: { a: 10, b: 0 } });
  });

  it('rolls back a tick when a registered invariant fails after command commit', () => {
    const engine = createEngine({ initialState: { value: 0 } }, 7);
    engine.registerCommandHandler('increment', (draft) => {
      draft.value = 1;
    });
    engine.registerInvariant((domain) => {
      if (domain.value === 1) throw new Error('invariant failure');
    });
    engine.submit({ commandId: 'inc', requestedTick: 1, type: 'increment', payload: null });
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow('invariant failure');
    expect(engine.snapshotText()).toBe(before);
  });

  it('preserves the domain when an invariant rejects a staged command', () => {
    const engine = createEngine({ initialState: { value: 0 } }, 7);
    engine.registerCommandHandler('increment', (draft) => {
      draft.value = 1;
      engine.drawRandom();
    });
    engine.registerInvariant((domain) => {
      if (domain.value === 1) throw new DomainCommandRejection();
    });
    engine.submit({ commandId: 'inc', requestedTick: 1, type: 'increment', payload: null });
    const before = engine.snapshotText();
    engine.step();
    const after = engine.snapshot();
    expect(after.domain).toEqual({ value: 0 });
    expect(after.rngState).toBe(JSON.parse(before).rngState);
    expect(after.events).toEqual([]);
    expect(after.nextEventId).toBe(1);
    expect(after.receipts[0]).toMatchObject({ status: 'rejected', errorCode: 'DOMAIN_REJECTED' });
  });

  it('runs registered phase systems in phase then registration order', () => {
    const engine = createEngine({ initialState: { order: [] } }, 7);
    const order: string[] = [];
    engine.registerPhaseSystem('production', 'second', (draft) => {
      order.push('production-second');
      (draft.order as string[]).push('production-second');
    });
    engine.registerPhaseSystem('production', 'first', (draft) => {
      order.push('production-first');
      (draft.order as string[]).push('production-first');
    });
    engine.registerPhaseSystem('infrastructure', 'only', (draft) => {
      order.push('infrastructure');
      (draft.order as string[]).push('infrastructure');
    });
    engine.step();
    expect(order).toEqual(['infrastructure', 'production-first', 'production-second']);
    expect(engine.getState().domain.order).toEqual(order);
  });

  it('does not allow random draws outside an active tick', () => {
    const engine = createEngine({}, 7);
    const before = engine.snapshotText();
    expect(() => engine.drawRandom()).toThrow(/active tick/i);
    expect(engine.snapshotText()).toBe(before);
  });

  it('rejects malformed snapshots atomically', () => {
    const engine = createEngine({ initialState: { balances: { a: 10 } } }, 7);
    const before = engine.snapshotText();
    const malformed = {
      ...engine.snapshot(),
      queue: [{ commandId: 'duplicate' }, { commandId: 'duplicate' }],
    };
    expect(() => engine.restore(malformed)).toThrow();
    expect(engine.snapshotText()).toBe(before);
  });

  it('deduplicates identical command IDs and rejects conflicting envelopes', () => {
    const engine = createEngine({}, 9);
    const command = {
      commandId: 'same',
      requestedTick: 1,
      type: 'transfer',
      payload: { from: 'a', to: 'b', amount: 2 },
    };
    const first = engine.submit(command);
    expect(engine.submit(command)).toEqual(first);
    const conflicting = engine.submit({ ...command, payload: { from: 'a', to: 'b', amount: 3 } });
    expect(conflicting.errorCode).toBe('DUPLICATE_CONFLICT');
    expect(engine.snapshot().nextSequence).toBe(2);
  });

  it('rejects handler attempts to enqueue a command reentrantly', () => {
    const engine = createEngine({}, 7);
    engine.registerCommandHandler('reentrant', () => {
      engine.submit({ commandId: 'nested', requestedTick: 2, type: 'transfer', payload: null });
    });
    engine.submit({ commandId: 'outer', requestedTick: 1, type: 'reentrant', payload: null });
    const before = engine.snapshotText();
    expect(() => engine.step()).toThrow(/mutation is not allowed/);
    expect(engine.snapshotText()).toBe(before);
  });

  it('queues and applies a bounded transfer atomically at the next tick', () => {
    const engine = createEngine({ initialState: { balances: { a: 10, b: 0 } } }, 7);
    const receipt = engine.submit({
      commandId: 'transfer-1',
      requestedTick: 1,
      type: 'transfer',
      payload: { from: 'a', to: 'b', amount: 4 },
    });

    expect(receipt.status).toBe('queued');
    expect(receipt).toHaveProperty('receiptVersion', 1);
    expect(engine.snapshot().envelopes[0]).toMatchObject({
      commandVersion: 1,
      worldId: 'default',
      sequence: 1,
    });
    engine.step();
    expect(engine.getState().domain).toEqual({ balances: { a: 6, b: 4 } });
    expect(engine.getState().tick).toBe(1);
    expect(engine.events()).toHaveLength(1);
  });
  it('runs due commands before phase systems in stable order, then stops and resumes', () => {
    const engine = createEngine({ initialState: { balances: { a: 5, b: 0 }, seen: [] } }, 3);
    engine.registerPhaseSystem('commands', 'z-later', (draft) => {
      (draft.seen as number[]).push((draft.balances as Record<string, number>).b!);
    });
    engine.registerPhaseSystem('commands', 'a-first', (draft) => {
      (draft.seen as number[]).push((draft.balances as Record<string, number>).a!);
    });
    engine.submit({
      commandId: 'pay',
      requestedTick: 1,
      type: 'transfer',
      payload: { from: 'a', to: 'b', amount: 2 },
    });
    engine.pause();
    expect(() => engine.step()).toThrow(/paused/);
    expect(engine.getState().tick).toBe(0);
    engine.resume();
    engine.step();
    expect(engine.getState().domain).toEqual({ balances: { a: 3, b: 2 }, seen: [3, 2] });
  });
});
