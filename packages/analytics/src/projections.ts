/**
 * Pure projections over the three-nations fixture metrics domain key.
 * No engine registration, no I/O; depends on @epcse/simulation-core for TYPES only.
 */

export interface CityProjection {
  readonly produced: number;
  readonly consumed: number;
  readonly unmet: number;
  readonly departed: number;
  readonly arrived: number;
  readonly prices: Readonly<Record<string, number>>;
}

export interface KingdomProjection {
  readonly treasury: number;
  readonly produced: number;
  readonly consumed: number;
  readonly unmet: number;
  readonly departed: number;
  readonly arrived: number;
  readonly staplePrice: number;
}

export interface WorldTotals {
  readonly treasury: number;
  readonly produced: number;
  readonly consumed: number;
  readonly unmet: number;
  readonly departed: number;
  readonly arrived: number;
}

/** Optional projection filter. Unknown ids throw RangeError — no silent narrowing. */
export interface ProjectionFilter {
  readonly cityIds?: readonly string[];
  readonly kingdomIds?: readonly string[];
  readonly tickFrom?: number;
  readonly tickTo?: number;
}

export interface WorldProjection {
  readonly tick: number;
  readonly cities: Readonly<Record<string, CityProjection>>;
  readonly kingdoms: Readonly<Record<string, KingdomProjection>>;
  readonly world: WorldTotals;
}

export interface SeriesFrame {
  readonly tick: number;
  readonly cities: Readonly<Record<string, CityProjection>>;
  readonly kingdoms: Readonly<Record<string, { readonly treasury: number }>>;
  readonly staples: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const METRICS_KEY = 'three-nations:metrics';
/** Supported metrics versions: 1 (no samples segment) and 2 (sparse city price samples). */
const SUPPORTED_VERSIONS = [1, 2] as const;

type MetricsVersion = (typeof SUPPORTED_VERSIONS)[number];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// Frame shape: `<tick>|<5 counters per city, ';'-joined>|<treasury per kingdom>|<staple per
// kingdom>[|<sparse city price samples>]`. Version 2 frames always carry the 5th segment
// (possibly empty); version 1 frames have exactly four segments.
const METRICS_FRAME = /^(\d+)\|([^|]+)\|([\d,]+)\|([\d,]+)(?:\|([^|]*))?$/;

interface DecodedFrame {
  readonly tick: number;
  readonly cityIds: readonly string[];
  readonly kingdomIds: readonly string[];
  readonly cities: readonly (readonly number[])[];
  readonly treasuries: readonly number[];
  readonly staples: readonly number[];
  /** Parsed sparse samples for version 2; empty for version 1. */
  readonly samples: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

/** Parses the samples segment: "cityId:commodity:price" entries joined by ';', alphabetical. */
function decodeSamples(
  segment: string | undefined,
  version: MetricsVersion,
  cityIds: readonly string[],
): Record<string, Record<string, number>> {
  if (segment === undefined) {
    if (version >= 2) throw new RangeError('version 2 metrics frame requires a samples segment');
    return {};
  }
  if (segment === '') return {};
  const samples: Record<string, Record<string, number>> = {};
  let lastCity: string | undefined;
  let lastCommodity: string | undefined;
  for (const entry of segment.split(';')) {
    const parts = entry.split(':');
    if (parts.length !== 3) throw new RangeError('malformed metrics price sample');
    const [cityId, commodityId, rawPrice] = parts as [string, string, string];
    const price = Number(rawPrice);
    if (!Number.isSafeInteger(price) || price < 0)
      throw new RangeError('malformed metrics price sample');
    if (!cityIds.includes(cityId)) throw new RangeError('metrics sample references unknown city');
    if (lastCity !== undefined && cityId === lastCity && commodityId <= lastCommodity!)
      throw new RangeError('metrics samples must be sorted by commodity within a city');
    if (lastCity !== undefined && cityId < lastCity)
      throw new RangeError('metrics samples must be sorted by city');
    (samples[cityId] ??= {})[commodityId] = price;
    lastCity = cityId;
    lastCommodity = commodityId;
  }
  return samples;
}

function decodeFrame(
  line: string,
  version: MetricsVersion,
  cityIds: readonly string[],
): DecodedFrame {
  const match = METRICS_FRAME.exec(line);
  if (!match) throw new RangeError('malformed metrics frame');
  const cityGroups = match[2]!.split(';');
  const cities = cityGroups.map((group) => {
    const numbers = group.split(',').map(Number);
    if (numbers.length !== 5 || numbers.some((n) => !Number.isFinite(n) || n < 0))
      throw new RangeError('malformed metrics city counters');
    return numbers;
  });
  const treasuries = match[3]!.split(',').map(Number);
  const staples = match[4]!.split(',').map(Number);
  if (
    treasuries.some((n) => !Number.isFinite(n) || n < 0) ||
    staples.some((n) => !Number.isFinite(n) || n < 0)
  )
    throw new RangeError('malformed metrics kingdom data');
  const samples = decodeSamples(match[5], version, cityIds);
  return {
    tick: Number(match[1]),
    cityIds: [],
    kingdomIds: [],
    cities,
    treasuries,
    staples,
    samples,
  };
}

/** Deterministic id order shared with the fixture writer: alphabetical. */
function idOrder(domain: Readonly<Record<string, unknown>>): {
  cityIds: string[];
  kingdomIds: string[];
} {
  const logistics = domain.logistics as
    { cityKingdomIds?: Readonly<Record<string, string>> } | undefined;
  const cityKingdomIds = logistics?.cityKingdomIds ?? {};
  const cityIds = Object.keys(cityKingdomIds).sort();
  const kingdomIds = [...new Set(Object.values(cityKingdomIds))].sort();
  return { cityIds, kingdomIds };
}

interface ResolvedFilter {
  readonly cityIds?: ReadonlySet<string>;
  readonly kingdomIds?: ReadonlySet<string>;
  readonly tickFrom?: number;
  readonly tickTo?: number;
}

/** Validates a filter against the domain ids; unknown ids are an explicit RangeError. */
function resolveFilter(
  domain: Readonly<Record<string, unknown>>,
  filter: ProjectionFilter | undefined,
): ResolvedFilter {
  if (!filter) return {};
  const { cityIds: allCityIds, kingdomIds: allKingdomIds } = idOrder(domain);
  const validate = (
    ids: readonly string[],
    known: readonly string[],
    kind: string,
  ): Set<string> => {
    const set = new Set<string>();
    for (const id of ids) {
      if (!known.includes(id)) throw new RangeError(`unknown ${kind} id in filter: ${id}`);
      set.add(id);
    }
    return set;
  };
  const tickFrom = filter.tickFrom;
  const tickTo = filter.tickTo;
  if (
    (tickFrom !== undefined && (!Number.isSafeInteger(tickFrom) || tickFrom < 0)) ||
    (tickTo !== undefined && (!Number.isSafeInteger(tickTo) || tickTo < 0))
  )
    throw new RangeError('filter tick bounds must be nonnegative safe integers');
  if (tickFrom !== undefined && tickTo !== undefined && tickFrom > tickTo)
    throw new RangeError('filter tickFrom must be <= tickTo');
  return {
    cityIds: filter.cityIds ? validate(filter.cityIds, allCityIds, 'city') : undefined,
    kingdomIds: filter.kingdomIds
      ? validate(filter.kingdomIds, allKingdomIds, 'kingdom')
      : undefined,
    tickFrom,
    tickTo,
  };
}

function readFrames(
  metrics: unknown,
  filter?: ResolvedFilter,
): {
  frames: readonly DecodedFrame[];
  cityIds: string[];
  kingdomIds: string[];
} {
  const source = isRecord(metrics) && METRICS_KEY in metrics ? metrics : undefined;
  if (!source) throw new RangeError('metrics domain key not found');
  const raw: unknown = source[METRICS_KEY];
  if (!isRecord(raw) || !SUPPORTED_VERSIONS.includes(raw.version as MetricsVersion))
    throw new RangeError(
      `unsupported metrics version (expected one of ${SUPPORTED_VERSIONS.join(', ')})`,
    );
  const version = raw.version as MetricsVersion;
  if (!Array.isArray(raw.series)) throw new RangeError('metrics series must be an array');
  const domain = source as Readonly<Record<string, unknown>>;
  const { cityIds, kingdomIds } = idOrder(domain);
  const frames = (raw.series as readonly string[])
    .map((line) => {
      const frame = decodeFrame(String(line), version, cityIds);
      if (frame.cities.length !== cityIds.length || cityIds.length === 0)
        throw new RangeError('metrics frame city count does not match domain cities');
      if (frame.treasuries.length !== kingdomIds.length || kingdomIds.length === 0)
        throw new RangeError('metrics frame kingdom count does not match domain kingdoms');
      return { ...frame, cityIds, kingdomIds };
    })
    .filter(
      (frame) =>
        (filter?.tickFrom === undefined || frame.tick >= filter.tickFrom) &&
        (filter?.tickTo === undefined || frame.tick <= filter.tickTo),
    );
  return { frames, cityIds, kingdomIds };
}

/** Reads the fixture metrics domain key, validates the version, decodes and filters frames. */
export function projectSeries(metrics: unknown, filter?: ProjectionFilter): SeriesFrame[] {
  const domain = metrics as Readonly<Record<string, unknown>>;
  const resolved = resolveFilter(domain, filter);
  const { frames } = readFrames(metrics, resolved);
  const citySet = resolved.cityIds;
  const kingdomSet = resolved.kingdomIds;
  const logistics = domain.logistics as
    { cityKingdomIds?: Readonly<Record<string, string>> } | undefined;
  const kingdomOf = (cityId: string): string | undefined => logistics?.cityKingdomIds?.[cityId];
  const out: SeriesFrame[] = [];
  for (const frame of frames) {
    const cities: Record<string, CityProjection> = {};
    const includedKingdoms = new Set<string>();
    for (const [index, cityId] of frame.cityIds.entries()) {
      if (citySet && !citySet.has(cityId)) continue;
      const kingdomId = kingdomOf(cityId);
      if (kingdomSet && (kingdomId === undefined || !kingdomSet.has(kingdomId))) continue;
      if (kingdomId) includedKingdoms.add(kingdomId);
      const numbers = frame.cities[index]!;
      cities[cityId] = {
        produced: numbers[0]!,
        consumed: numbers[1]!,
        unmet: numbers[2]!,
        departed: numbers[3]!,
        arrived: numbers[4]!,
        prices: frame.samples[cityId] ?? {},
      };
    }
    const kingdoms: Record<string, { treasury: number }> = {};
    const stapleMap: Record<string, Record<string, number>> = {};
    for (const [index, kingdomId] of frame.kingdomIds.entries()) {
      if (kingdomSet && !kingdomSet.has(kingdomId)) continue;
      // a city filter implies only kingdoms owning included cities appear
      if (citySet && !includedKingdoms.has(kingdomId)) continue;
      kingdoms[kingdomId] = { treasury: frame.treasuries[index]! };
      stapleMap[kingdomId] = { grain: frame.staples[index]! };
    }
    out.push({ tick: frame.tick, cities, kingdoms, staples: stapleMap });
  }
  return out;
}

/**
 * Projects the requested metrics sample into a reconciled world view.
 * Reconciliation rule: city sums == kingdom sums == world totals (exact integer arithmetic,
 * computed from the same source frames so the identity holds by construction).
 */
export function projectWorld(
  domain: Readonly<Record<string, unknown>>,
  tick: number,
  filter?: ProjectionFilter,
): WorldProjection {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('tick must be a safe integer');
  const resolved = resolveFilter(domain, filter);
  if (resolved.tickFrom !== undefined && tick < resolved.tickFrom)
    throw new RangeError(`tick ${tick} is before the filter window`);
  if (resolved.tickTo !== undefined && tick > resolved.tickTo)
    throw new RangeError(`tick ${tick} is after the filter window`);
  const { frames } = readFrames(domain);
  if (!frames.length) throw new RangeError('metrics series is empty');
  const framesOut = projectSeries(domain, filter);
  const frame = framesOut.find((sample) => sample.tick === tick);
  if (!frame) throw new RangeError(`metrics sample not found for tick ${tick}`);

  const kingdomOf = (cityId: string): string | undefined => {
    const logistics = domain.logistics as
      { cityKingdomIds?: Readonly<Record<string, string>> } | undefined;
    return logistics?.cityKingdomIds?.[cityId];
  };

  interface MutableKingdomAccumulator {
    treasury: number;
    produced: number;
    consumed: number;
    unmet: number;
    departed: number;
    arrived: number;
    staplePrice: number;
  }

  const cities: Record<string, CityProjection> = {};
  const kingdomAccumulators: Record<string, MutableKingdomAccumulator> = {};
  // frame.cities/frame.kingdoms are already filter-restricted, so restricted views only
  // accumulate included entities and their totals stay internally consistent by construction.
  for (const kingdomId of Object.keys(frame.kingdoms)) {
    kingdomAccumulators[kingdomId] = {
      treasury: frame.kingdoms[kingdomId]?.treasury ?? 0,
      produced: 0,
      consumed: 0,
      unmet: 0,
      departed: 0,
      arrived: 0,
      staplePrice: Object.values(frame.staples[kingdomId] ?? {})[0] ?? 0,
    };
  }
  for (const [cityId, city] of Object.entries(frame.cities)) {
    cities[cityId] = city;
    const kingdomId = kingdomOf(cityId) ?? 'unassigned';
    const target = (kingdomAccumulators[kingdomId] ??= {
      treasury: 0,
      produced: 0,
      consumed: 0,
      unmet: 0,
      departed: 0,
      arrived: 0,
      staplePrice: 0,
    });
    target.produced += city.produced;
    target.consumed += city.consumed;
    target.unmet += city.unmet;
    target.departed += city.departed;
    target.arrived += city.arrived;
  }

  const kingdomTotals: Record<string, KingdomProjection> = {};
  const worldAccumulator: { -readonly [K in keyof WorldTotals]: number } = {
    treasury: 0,
    produced: 0,
    consumed: 0,
    unmet: 0,
    departed: 0,
    arrived: 0,
  };
  for (const [kingdomId, acc] of Object.entries(kingdomAccumulators)) {
    kingdomTotals[kingdomId] = Object.freeze({ ...acc });
    worldAccumulator.treasury += acc.treasury;
    worldAccumulator.produced += acc.produced;
    worldAccumulator.consumed += acc.consumed;
    worldAccumulator.unmet += acc.unmet;
    worldAccumulator.departed += acc.departed;
    worldAccumulator.arrived += acc.arrived;
  }
  const world: WorldTotals = Object.freeze({ ...worldAccumulator });
  return { tick, cities, kingdoms: kingdomTotals, world };
}
