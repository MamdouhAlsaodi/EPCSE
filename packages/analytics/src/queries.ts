/**
 * Pure, stable-order filters and pagination over engine events and accounting journal entries.
 * Pagination is a slice: input order is preserved, nothing is reordered or silently deduped.
 */

import type { AccountingJournalEntry, EngineEvent } from '@epcse/simulation-core';

export interface EventFilter {
  readonly types?: readonly string[];
  readonly tickFrom?: number;
  readonly tickTo?: number;
  readonly commandId?: string;
}

export interface JournalFilter {
  readonly causePrefix?: string;
  readonly type?: string;
}

export interface Page {
  readonly size: number;
  readonly offset: number;
}

export interface QueryResult<T> {
  readonly total: number;
  readonly items: T[];
  readonly hasMore: boolean;
}

function validatePage(page: Page): { size: number; offset: number } {
  const { size, offset } = page ?? ({} as Page);
  if (
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > 1000 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  )
    throw new RangeError('page size must be 1..1000 and offset a nonnegative safe integer');
  return { size, offset };
}

function paginate<T>(filtered: readonly T[], page: Page): QueryResult<T> {
  const { size, offset } = validatePage(page);
  const items = filtered.slice(offset, offset + size);
  return { total: filtered.length, items, hasMore: offset + size < filtered.length };
}

export function queryEvents(
  events: readonly EngineEvent[],
  filter: EventFilter,
  page: Page,
): QueryResult<EngineEvent> {
  const types = filter?.types ? new Set(filter.types) : undefined;
  const filtered = events.filter(
    (event) =>
      (!types || types.has(event.type)) &&
      (filter?.tickFrom === undefined || event.tick >= filter.tickFrom) &&
      (filter?.tickTo === undefined || event.tick <= filter.tickTo) &&
      (filter?.commandId === undefined || event.commandId === filter.commandId),
  );
  return paginate(filtered, page);
}

export function queryJournal(
  entries: readonly AccountingJournalEntry[],
  filter: JournalFilter,
  page: Page,
): QueryResult<AccountingJournalEntry> {
  const filtered = entries.filter(
    (entry) =>
      (!filter?.causePrefix || entry.causeId.startsWith(filter.causePrefix)) &&
      (!filter?.type || entry.type === filter.type),
  );
  return paginate(filtered, page);
}
