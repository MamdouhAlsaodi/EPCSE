export interface EngineCommand {
  readonly commandId: string;
  readonly commandVersion?: 1;
  readonly worldId?: string;
  readonly requestedTick: number;
  readonly type: string;
  readonly payload: unknown;
  readonly sequence?: number;
}
export interface CommandReceipt {
  readonly receiptVersion: 1;
  readonly commandId: string;
  readonly status: 'queued' | 'applied' | 'rejected';
  readonly requestedTick: number;
  readonly appliedTick: number | null;
  readonly sequence: number | null;
  readonly errorCode: string | null;
}
export class DomainCommandRejection extends Error {
  readonly code: string;

  constructor(code = 'DOMAIN_REJECTED') {
    super(code);
    this.name = 'DomainCommandRejection';
    this.code = code;
  }
}

export type CommandHandler = (draft: Record<string, unknown>, payload: unknown) => void;
