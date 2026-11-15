/** Pure timing transitions shared by the legacy route network and engine logistics. */
export type PausableRouteShipment = { readonly arrivalTick: number };
export type PausedRouteShipment<T extends PausableRouteShipment> = T & {
  readonly pausedRemainingTicks: number;
};
export type ResumableRouteShipment = {
  readonly arrivalTick: number;
  readonly pausedRemainingTicks: number;
};

export function pauseRouteShipment<T extends PausableRouteShipment>(
  shipment: T,
  transitionTick: number,
): PausedRouteShipment<T> {
  return {
    ...shipment,
    pausedRemainingTicks: Math.max(0, shipment.arrivalTick - transitionTick),
  };
}

export function resumeRouteShipment<T extends ResumableRouteShipment>(
  shipment: T,
  transitionTick: number,
): Omit<T, 'pausedRemainingTicks'> {
  const { pausedRemainingTicks, ...active } = shipment;
  return { ...active, arrivalTick: transitionTick + pausedRemainingTicks };
}

export interface PaidObstructionRerouteEligibility {
  readonly isInTransit: boolean;
  readonly isBlocked: boolean;
  readonly hasBlockTick: boolean;
  readonly isPaid: boolean;
  readonly alreadyRerouted: boolean;
  readonly sameOrigin: boolean;
  readonly differentDestination: boolean;
  readonly alternateRouteOpen: boolean;
}

/** Shared policy predicate for the paid obstruction-reroute transition. */
export function isPaidObstructionRerouteEligible(
  candidate: PaidObstructionRerouteEligibility,
): boolean {
  return (
    candidate.isInTransit &&
    candidate.isBlocked &&
    candidate.hasBlockTick &&
    candidate.isPaid &&
    !candidate.alreadyRerouted &&
    candidate.sameOrigin &&
    candidate.differentDestination &&
    candidate.alternateRouteOpen
  );
}

/** Cumulative active outward ticks, excluding any paused obstruction/closure time. */
export function activeOutwardElapsedTicks(
  originalTravelTicks: number,
  remainingAtReroute: number,
  activeTicksOnCurrentLeg: number,
): number {
  return originalTravelTicks - remainingAtReroute + activeTicksOnCurrentLeg;
}

/** Add return travel to its transition tick while safely guarding integer overflow. */
export function returnDueTick(transitionTick: number, elapsedTicks: number): number | undefined {
  if (
    !Number.isSafeInteger(transitionTick) ||
    !Number.isSafeInteger(elapsedTicks) ||
    transitionTick < 0 ||
    elapsedTicks < 0 ||
    elapsedTicks > Number.MAX_SAFE_INTEGER - transitionTick
  )
    return undefined;
  return transitionTick + elapsedTicks;
}
