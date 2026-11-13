export interface Kingdom {
  readonly id: string;
}

export interface City {
  readonly id: string;
  readonly kingdomId: string;
}

export interface Establishment {
  readonly id: string;
  readonly cityId: string;
  readonly ownerKingdomId: string;
}

export interface WorldDomainInput {
  readonly kingdoms: readonly Kingdom[];
  readonly cities: readonly City[];
  readonly establishments: readonly Establishment[];
}

export type WorldDomainSnapshot = WorldDomainInput;

export interface WorldDomain {
  getState(): WorldDomainSnapshot;
}

export function createWorldDomain(input: WorldDomainInput): WorldDomain {
  const kingdomIds = new Set<string>();
  const cityIds = new Set<string>();
  const establishmentIds = new Set<string>();
  const validateId = (id: string, entity: string): void => {
    if (typeof id !== 'string') throw new TypeError(`${entity} id must be a string`);
    if (id.length === 0) throw new RangeError(`${entity} id must be nonempty`);
  };

  for (const kingdom of input.kingdoms) {
    validateId(kingdom.id, 'kingdom');
    if (kingdomIds.has(kingdom.id)) throw new RangeError(`duplicate kingdom id: ${kingdom.id}`);
    kingdomIds.add(kingdom.id);
  }
  for (const city of input.cities) {
    validateId(city.id, 'city');
    validateId(city.kingdomId, 'city kingdom');
    if (cityIds.has(city.id)) throw new RangeError(`duplicate city id: ${city.id}`);
    if (!kingdomIds.has(city.kingdomId)) throw new RangeError(`unknown kingdom: ${city.kingdomId}`);
    cityIds.add(city.id);
  }
  for (const establishment of input.establishments) {
    validateId(establishment.id, 'establishment');
    validateId(establishment.cityId, 'establishment city');
    validateId(establishment.ownerKingdomId, 'establishment owner kingdom');
    if (establishmentIds.has(establishment.id)) {
      throw new RangeError(`duplicate establishment id: ${establishment.id}`);
    }
    if (!cityIds.has(establishment.cityId))
      throw new RangeError(`unknown city: ${establishment.cityId}`);
    if (!kingdomIds.has(establishment.ownerKingdomId)) {
      throw new RangeError(`unknown owner kingdom: ${establishment.ownerKingdomId}`);
    }
    establishmentIds.add(establishment.id);
  }

  const state: WorldDomainSnapshot = {
    kingdoms: input.kingdoms.map(({ id }) => ({ id })),
    cities: input.cities.map(({ id, kingdomId }) => ({ id, kingdomId })),
    establishments: input.establishments.map(({ id, cityId, ownerKingdomId }) => ({
      id,
      cityId,
      ownerKingdomId,
    })),
  };
  return {
    getState: () => ({
      kingdoms: state.kingdoms.map(({ id }) => ({ id })),
      cities: state.cities.map(({ id, kingdomId }) => ({ id, kingdomId })),
      establishments: state.establishments.map(({ id, cityId, ownerKingdomId }) => ({
        id,
        cityId,
        ownerKingdomId,
      })),
    }),
  };
}
