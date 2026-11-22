export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** HMAC verification failure: tampered payload, wrong key, or missing writer identity. */
export class SnapshotProvenanceError extends SnapshotError {
  constructor(message = 'snapshot provenance verification failed') {
    super(message);
  }
}

/** Stored snapshot version tuple is missing or outside the supported set. */
export class SnapshotIncompatibleError extends SnapshotError {
  constructor(message = 'snapshot version tuple is missing or incompatible') {
    super(message);
  }
}

/** Stored text is not safe canonical JSON (parse failure, duplicate keys, trailing input). */
export class SnapshotCorruptError extends SnapshotError {
  constructor(message = 'snapshot text is corrupt or not canonical JSON') {
    super(message);
  }
}

/** Snapshot exceeds the configured byte budget. */
export class SnapshotSizeError extends SnapshotError {
  constructor(maxBytes: number) {
    super(`snapshot exceeds the configured maximum of ${maxBytes} bytes`);
  }
}

/** Run-level conflicts: second active run per world, or duplicate command replay. */
export class RunConflictError extends SnapshotError {
  constructor(
    message = 'run conflict: an active run already exists or the command was already applied',
  ) {
    super(message);
  }
}
