import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abnormalConsumptionAlert,
  buildBaseline,
  depotStock,
  fuelAlerts,
  fuelBalance,
  idlingAlerts,
  matchRefuels,
} from '../src/reconciliation';
import { findIdlePeriods } from '../src/segmentation';
import type { FuelLevelEvent, Segment } from '../src/types';
import { drive } from './helpers';

const rise = (startedAt: string, litres: number, levelBeforeL = 100): FuelLevelEvent => ({
  type: 'rise',
  startedAt,
  endedAt: new Date(Date.parse(startedAt) + 10 * 60_000).toISOString(),
  litres,
  levelBeforeL,
  levelAfterL: levelBeforeL + litres,
  lat: -15.43,
  lon: 28.25,
});

test('refuel records match the closest sensor rise in time', () => {
  const rises = [rise('2026-10-06T06:00:00Z', 200), rise('2026-10-06T14:00:00Z', 150)];
  const refuels = [
    { id: 'a', source: 'depot' as const, litres: 200, occurredAt: '2026-10-06T06:05:00Z' },
    { id: 'b', source: 'cash' as const, litres: 150, occurredAt: '2026-10-06T14:20:00Z' },
  ];
  const m = matchRefuels(refuels, rises);
  assert.equal(m.matches.length, 2);
  assert.equal(m.matches[0].riseIndex, 0);
  assert.equal(m.matches[1].riseIndex, 1);
  assert.equal(m.unmatchedRefuels.length, 0);
  assert.equal(m.unmatchedRises.length, 0);
});

test('an inflated receipt raises a refuel mismatch', () => {
  const { alerts } = fuelAlerts({
    vehicleId: 'v1',
    tankCapacityL: 300,
    refuels: [{ id: 'r1', source: 'cash', litres: 180, occurredAt: '2026-10-06T14:05:00Z' }],
    events: [rise('2026-10-06T14:00:00Z', 120, 60)],
  });
  const mismatch = alerts.find((a) => a.type === 'refuel_mismatch');
  assert.ok(mismatch);
  assert.equal(mismatch.litres, 60);
  assert.equal(mismatch.severity, 'critical');
});

test('small differences inside the tolerance are not flagged', () => {
  const { alerts } = fuelAlerts({
    vehicleId: 'v1',
    tankCapacityL: 600,
    refuels: [{ id: 'r1', source: 'depot', litres: 400, occurredAt: '2026-10-06T06:05:00Z' }],
    events: [rise('2026-10-06T06:00:00Z', 396, 150)],
  });
  assert.equal(alerts.length, 0);
});

test('a receipt bigger than the room in the tank is flagged', () => {
  const { alerts } = fuelAlerts({
    vehicleId: 'v1',
    tankCapacityL: 300,
    refuels: [{ id: 'r1', source: 'cash', litres: 260, occurredAt: '2026-10-06T14:05:00Z' }],
    events: [rise('2026-10-06T14:00:00Z', 140, 150)],
  });
  assert.ok(alerts.some((a) => a.type === 'refuel_over_capacity'));
  assert.ok(alerts.some((a) => a.type === 'refuel_mismatch'));
});

test('a record with no rise, a rise with no record, and a drop while parked are all flagged', () => {
  const drop: FuelLevelEvent = { ...rise('2026-10-07T00:30:00Z', 60, 200), type: 'drop_while_parked', levelAfterL: 140 };
  const { alerts } = fuelAlerts({
    vehicleId: 'v1',
    tankCapacityL: 400,
    refuels: [{ id: 'r1', source: 'fuel_card', litres: 100, occurredAt: '2026-10-06T09:00:00Z' }],
    events: [rise('2026-10-06T16:00:00Z', 80), drop],
  });
  const types = alerts.map((a) => a.type).sort();
  assert.deepEqual(types, ['drop_while_parked', 'refuel_mismatch', 'refuel_without_record']);
});

const seg = (over: Partial<Segment>): Segment => ({
  kind: 'moving',
  startedAt: '2026-10-06T06:00:00Z',
  endedAt: '2026-10-06T06:01:00Z',
  distanceKm: 1,
  durationS: 60,
  fuelUsedL: 0.35,
  fuelSource: 'can_counter',
  avgSpeedKmh: 60,
  speedBand: '60-80',
  gradientPct: 0,
  gradient: 'flat',
  traffic: 'free',
  roadShape: 'straight',
  timeOfDay: 'off_peak',
  loadClass: 'full',
  harshEvents: 0,
  startLat: -15.4,
  startLon: 28.3,
  vehicleId: 'v1',
  tripId: 't2',
  ...over,
});

test('a trip using far more than the vehicle normally uses in the same conditions is abnormal', () => {
  const history = Array.from({ length: 500 }, () => seg({ tripId: 't1' }));
  const baseline = buildBaseline(history);
  assert.equal(baseline.overallLPer100km, 35);
  const normalTrip = Array.from({ length: 50 }, () => seg({ fuelUsedL: 0.36 }));
  assert.equal(abnormalConsumptionAlert(normalTrip, baseline), null);
  const badTrip = Array.from({ length: 50 }, () => seg({ fuelUsedL: 0.5 }));
  const alert = abnormalConsumptionAlert(badTrip, baseline);
  assert.ok(alert);
  assert.equal(alert.details.expectedL, 17.5);
  assert.equal(alert.litres, 7.5);
});

test('an unseen speed on a known climb and load uses the climb rate for that load', () => {
  const flat = Array.from({ length: 500 }, () => seg({ tripId: 't1', loadKg: 28000 })); // 35 L/100km
  const climbs = Array.from({ length: 20 }, () => seg({ tripId: 't1', gradient: 'uphill', speedBand: '20-40', loadKg: 28000, fuelUsedL: 1.2 }));
  const baseline = buildBaseline([...flat, ...climbs]);
  // climbing at 40–60 was never seen: priced from uphill + 28 t (≈120 L/100km), not the 42 L/100km average
  const trip = Array.from({ length: 30 }, () => seg({ gradient: 'uphill', speedBand: '40-60', loadKg: 28000, fuelUsedL: 1.25 }));
  assert.equal(abnormalConsumptionAlert(trip, baseline), null);
});

test('a load the vehicle has never carried is not judged', () => {
  const history = Array.from({ length: 500 }, () => seg({ tripId: 't1', loadKg: 2000 }));
  const heavyTrip = Array.from({ length: 50 }, () => seg({ loadKg: 19000, fuelUsedL: 0.6 }));
  assert.equal(abnormalConsumptionAlert(heavyTrip, buildBaseline(history)), null);
});

test('idling over the limit raises an alert', () => {
  const r = drive([
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
    { durationS: 1800, speedKmh: 0, lPerHour: 3 }, // 30 min idle
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
    { durationS: 300, speedKmh: 0, lPerHour: 3 }, // 5 min, fine
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
  ]);
  const periods = findIdlePeriods(r, 120);
  assert.equal(periods.length, 2);
  const alerts = idlingAlerts('v1', periods);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].details.durationMin, 30);
  assert.ok(Math.abs((alerts[0].litres ?? 0) - 1.5) < 0.05);
});

test('fuel balance shows fuel that left the tank without being burned', () => {
  const b = fuelBalance({ startLevelL: 200, endLevelL: 100, refueledRecordedL: 360, refueledSensorL: 300, usedL: 340 });
  assert.equal(b.unexplainedL, 60);
  assert.equal(b.unaccountedPurchasesL, 60);
});

test('depot stock gap compares expected stock with the dip', () => {
  const s = depotStock({ openingL: 5000, deliveredL: 10000, dispensedL: 8000, dipL: 6800 });
  assert.equal(s.expectedL, 7000);
  assert.equal(s.gapL, 200);
});

test('a vehicle with too little history is not judged yet', () => {
  const short = Array.from({ length: 100 }, () => seg({ tripId: 't1' })); // 100 km
  const badTrip = Array.from({ length: 50 }, () => seg({ fuelUsedL: 0.6 }));
  assert.equal(abnormalConsumptionAlert(badTrip, buildBaseline(short)), null);
});
