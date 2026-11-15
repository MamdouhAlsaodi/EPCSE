import type { EngineCommand, CommandReceipt } from '../models/commands.js';
import { canonical } from '../shared/canonical.js';
export interface QueuedCommand extends EngineCommand {
  readonly sequence: number;
}
export const compareCommands = (a: QueuedCommand, b: QueuedCommand): number =>
  a.requestedTick - b.requestedTick || a.sequence - b.sequence;
export function sameEnvelope(a: EngineCommand, b: EngineCommand): boolean {
  return (
    a.commandVersion === b.commandVersion &&
    a.worldId === b.worldId &&
    a.requestedTick === b.requestedTick &&
    a.type === b.type &&
    canonical(a.payload) === canonical(b.payload)
  );
}
export function queuedReceipt(command: QueuedCommand): CommandReceipt {
  return {
    receiptVersion: 1,
    commandId: command.commandId,
    status: 'queued',
    requestedTick: command.requestedTick,
    appliedTick: null,
    sequence: command.sequence,
    errorCode: null,
  };
}
