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
const METRICS_VERSION = 1;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const METRICS_FRAME = /^(\d+)\|([^|]+)\|([\d,]+)\|([\d,]+)$/;

interface DecodedFrame {
  readonly tick: number;
  readonly cityIds: readonly string[];
  readonly kingdomIds: readonly string[];
  readonly cities: readonly (readonly number[])[];
  readonly treasuries: readonly number[];
  readonly staples: readonly number[];
}

function decodeFrame(line: string): DecodedFrame {
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
  return {
    tick: Number(match[1]),
    cityIds: [],
    kingdomIds: [],
    cities,
    treasuries,
    staples,
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

function readFrames(metrics: unknown): {
  frames: readonly DecodedFrame[];
  cityIds: string[];
  kingdomIds: string[];
} {
  const source = isRecord(metrics) && METRICS_KEY in metrics ? metrics : undefined;
  if (!source) throw new RangeError('metrics domain key not found');
  const raw: unknown = source[METRICS_KEY];
  if (!isRecord(raw) || raw.version !== METRICS_VERSION)
    throw new RangeError(`unsupported metrics version (expected ${METRICS_VERSION})`);
  if (!Array.isArray(raw.series)) throw new RangeError('metrics series must be an array');
  const domain = source as Readonly<Record<string, unknown>>;
  const { cityIds, kingdomIds } = idOrder(domain);
  const frames = (raw.series as readonly string[]).map((line) => {
    const frame = decodeFrame(String(line));
    if (frame.cities.length !== cityIds.length || cityIds.length === 0)
      throw new RangeError('metrics frame city count does not match domain cities');
    if (frame.treasuries.length !== kingdomIds.length || kingdomIds.length === 0)
      throw new RangeError('metrics frame kingdom count does not match domain kingdoms');
    return { ...frame, cityIds, kingdomIds };
  });
  return { frames, cityIds, kingdomIds };
}

/** Reads the fixture metrics domain key (accepts the domain), validates the version, decodes frames. */
export function projectSeries(metrics: unknown): SeriesFrame[] {
  const { frames } = readFrames(metrics);
  const out: SeriesFrame[] = [];
  for (const frame of frames) {
    const cities: Record<string, CityProjection> = {};
    for (const [index, cityId] of frame.cityIds.entries()) {
      const numbers = frame.cities[index]!;
      cities[cityId] = {
        produced: numbers[0]!,
        consumed: numbers[1]!,
        unmet: numbers[2]!,
        departed: numbers[3]!,
        arrived: numbers[4]!,
        prices: {},
      };
    }
    const kingdoms: Record<string, { treasury: number }> = {};
    const stapleMap: Record<string, Record<string, number>> = {};
    for (const [index, kingdomId] of frame.kingdomIds.entries()) {
      kingdoms[kingdomId] = { treasury: frame.treasuries[index]! };
      stapleMap[kingdomId] = { grain: frame.staples[index]! };
    }
    out.push({ tick: frame.tick, cities, kingdoms, staples: stapleMap });
  }
  return out;
}

/**
 * Projects the latest metrics sample into a reconciled world view.
 * Reconciliation rule: city sums == kingdom sums == world totals (exact integer arithmetic,
 * computed from the same source frames so the identity holds by construction).
 */
export function projectWorld(
  domain: Readonly<Record<string, unknown>>,
  tick: number,
): WorldProjection {
  if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('tick must be a safe integer');
  const { frames, kingdomIds } = readFrames(domain);
  if (!frames.length) throw new RangeError('metrics series is empty');
  const framesOut = projectSeries(domain);
  const frame = framesOut[framesOut.length - 1]!;

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
  for (const kingdomId of kingdomIds) {
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
