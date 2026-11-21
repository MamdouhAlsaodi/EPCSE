// SC-14 — three-nations fixture variant: committed autonomous spending exceeding revenue declines
// the treasury until the reserve floor, where the engine's own policy records reduced/refused
// funding; the treasury never goes negative.
import { describe, expect, it } from 'vitest';
import { createThreeNations } from '../../packages/scenarios/src/three-nations-trade-and-politics.js';

function drive(
  ticks: number,
  variant?: NonNullable<Parameters<typeof createThreeNations>[0]>['variant'],
) {
  const fixture = createThreeNations({ ticks, variant });
  const commands = [];
  for (let tick = 1; tick <= ticks; tick++) commands.push(...fixture.commandsForTick(tick));
  for (const command of commands) fixture.engine.submit(command);
  fixture.engine.run(ticks);
  return fixture;
}

interface MetricsView {
  series: string[];
}
const treasuryOf = (frame: string, kingdomIndex: number): number =>
  Number(frame.split('|')[2]!.split(',')[kingdomIndex]);

describe('SC-14 reserve floor under committed spending', () => {
  it('declines the treasury to the floor, records the reduced decision, never overdraws', () => {
    const domain = drive(30, { reserveFloor: true }).engine.getState().domain;
    const metrics = domain['three-nations:metrics'] as MetricsView;
    // mountains treasury index in the alphabetical kingdom order (coast, mountains, plains)
    const series = metrics.series.map((frame) => treasuryOf(frame, 1));
    expect(series[0]).toBeLessThan(1000);
    const declines = series.slice(1).filter((value, index) => value < series[index]!);
    expect(declines.length).toBeGreaterThan(0);
    expect(series.every((value) => value >= 400)).toBe(true);
    expect(series.every((value) => value >= 0)).toBe(true);

    const government = domain.government as {
      decisions: Array<{ kingdomId: string; selected: string; reason: string }>;
    };
    const floorDecisions = government.decisions.filter(
      (d) => d.kingdomId === 'mountains' && d.selected !== 'fund',
    );
    expect(floorDecisions.length).toBeGreaterThan(0);
    expect(
      floorDecisions.some((d) => d.reason.includes('insufficient') || d.reason.includes('reserve')),
    ).toBe(true);
    // Control pairing (spec-stated): the same run WITHOUT the reserve-floor lever never records a
    // refused/reduced funding decision for mountains — the floor policy is the only difference.
    const control = drive(30).engine.getState().domain;
    const controlDecisions = (
      control.government as { decisions: Array<{ kingdomId: string; selected: string }> }
    ).decisions.filter((d) => d.kingdomId === 'mountains' && d.selected !== 'fund');
    expect(controlDecisions).toHaveLength(0);
  }, 900000);
});
