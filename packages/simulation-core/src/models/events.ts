export interface EngineEvent {
  readonly eventId: string;
  readonly tick: number;
  readonly phase: number;
  readonly sequence: number;
  readonly type: string;
  readonly commandId: string;
}
