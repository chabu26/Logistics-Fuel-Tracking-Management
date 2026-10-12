import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFuelEvents, findDataGaps, segmentTrip } from '../src/segmentation';
import { consumptionInsight } from '../src/consumption';
import { drive } from './helpers';

const ctx = { vehicleId: 'v1', tripId: 't1', loadKg: 28000, maxLoadKg: 30000 };

test('a trip is cut into ~1 km moving segments with the litres each used', () => {
  // 30 min at 60 km/h = 30 km, burning 18 L/h = 9 L → 30 L/100km
  const r = drive([{ durationS: 1800, speedKmh: 60, lPerHour: 18 }]);
  const segs = segmentTrip(r, ctx);
  const moving = segs.filter((s) => s.kind === 'moving');
  // a segment closes on the first reading past 1 km, so segments run 1.0–1.2 km at this speed
  assert.ok(moving.length >= 24 && moving.length <= 30, `got ${moving.length} segments`);
  assert.ok(moving.slice(0, -1).every((s) => s.distanceKm >= 1 && s.distanceKm < 1.25));
  const km = moving.reduce((a, s) => a + s.distanceKm, 0);
  const l = moving.reduce((a, s) => a + s.fuelUsedL, 0);
  assert.ok(Math.abs(km - 30) < 0.5);
  assert.ok(Math.abs(l - 9) < 0.2);
  assert.equal(moving[0].speedBand, '60-80');
  assert.equal(moving[0].loadClass, 'full');
  assert.equal(moving[0].fuelSource, 'can_counter');
});

test('uphill and downhill are tagged from altitude change', () => {
  const r = drive([
    { durationS: 600, speedKmh: 40, climbMPerKm: 50, lPerHour: 40 }, // +5% grade
    { durationS: 600, speedKmh: 40, climbMPerKm: -50, lPerHour: 4 },
  ]);
  const segs = segmentTrip(r, ctx).filter((s) => s.kind === 'moving');
  assert.ok(segs.slice(0, 5).every((s) => s.gradient === 'uphill'));
  assert.ok(segs.slice(-5).every((s) => s.gradient === 'downhill'));
});

test('a long stop with the engine on becomes an idle segment', () => {
  const r = drive([
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
    { durationS: 900, speedKmh: 0, lPerHour: 3 },
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
  ]);
  const idle = segmentTrip(r, ctx).filter((s) => s.kind === 'idle');
  assert.equal(idle.length, 1);
  assert.ok(Math.abs(idle[0].durationS - 900) <= 10);
  assert.ok(Math.abs(idle[0].fuelUsedL - 0.75) < 0.05);
});

test('without a CAN counter, litres come from the smoothed tank sensor', () => {
  const r = drive([{ durationS: 1800, speedKmh: 60, lPerHour: 18 }], { can: false });
  const moving = segmentTrip(r, ctx).filter((s) => s.kind === 'moving');
  assert.equal(moving[0].fuelSource, 'level_sensor');
  const l = moving.reduce((a, s) => a + s.fuelUsedL, 0);
  assert.ok(Math.abs(l - 9) < 0.6, `got ${l}`);
});

test('consumption insight finds the worst and best conditions', () => {
  const r = drive([
    { durationS: 1200, speedKmh: 30, climbMPerKm: 50, lPerHour: 24 }, // uphill slow: 80 L/100km
    { durationS: 1200, speedKmh: 70, lPerHour: 21 }, // flat: 30 L/100km
    { durationS: 1200, speedKmh: 70, climbMPerKm: -40, lPerHour: 7 }, // downhill: 10 L/100km
  ]);
  const insight = consumptionInsight(segmentTrip(r, ctx), ['gradient', 'speedBand']);
  assert.deepEqual(insight.worst?.conditions, { gradient: 'uphill', speedBand: '20-40' });
  assert.deepEqual(insight.best?.conditions, { gradient: 'downhill', speedBand: '60-80' });
  assert.ok(Math.abs((insight.worst?.lPer100km ?? 0) - 80) < 2);
});

test('refuels and drops while parked are found in the tank level', () => {
  const r = drive(
    [
      { durationS: 600, speedKmh: 60, lPerHour: 18 },
      { durationS: 600, speedKmh: 0, lPerHour: 0, ignition: false, tankChangeL: 150 }, // refuel
      { durationS: 600, speedKmh: 60, lPerHour: 18 },
      { durationS: 1800, speedKmh: 0, lPerHour: 0, ignition: false, tankChangeL: -40 }, // siphoned
    ],
    { startLevelL: 100 },
  );
  const events = detectFuelEvents(r);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'rise');
  assert.ok(Math.abs(events[0].litres - 150) < 3);
  assert.ok(events[0].levelBeforeL < 100);
  assert.equal(events[1].type, 'drop_while_parked');
  assert.ok(Math.abs(events[1].litres - 40) < 3);
});

test('a siphon overnight and a refuel the next morning in the same stop are two separate events', () => {
  const r = drive(
    [
      { durationS: 600, speedKmh: 60, lPerHour: 18 },
      { durationS: 3600, speedKmh: 0, lPerHour: 0, ignition: false },
      { durationS: 1200, speedKmh: 0, lPerHour: 0, ignition: false, tankChangeL: -70 }, // siphoned at night
      { durationS: 3600, speedKmh: 0, lPerHour: 0, ignition: false },
      { durationS: 600, speedKmh: 0, lPerHour: 0, ignition: false, tankChangeL: 200 }, // morning refuel
      { durationS: 600, speedKmh: 0, lPerHour: 0, ignition: false },
      { durationS: 600, speedKmh: 60, lPerHour: 18 },
    ],
    { startLevelL: 150, stepS: 60 },
  );
  const events = detectFuelEvents(r);
  assert.deepEqual(events.map((e) => e.type), ['drop_while_parked', 'rise']);
  assert.ok(Math.abs(events[0].litres - 70) < 2, `drop ${events[0].litres}`);
  assert.ok(Math.abs(events[1].litres - 200) < 2, `rise ${events[1].litres}`);
  assert.ok(Math.abs(events[1].levelBeforeL - 77) < 3, `level before refuel ${events[1].levelBeforeL}`);
});

test('fuel burned while idling with the engine on is not a drop', () => {
  const r = drive([
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
    { durationS: 7200, speedKmh: 0, lPerHour: 6 }, // 12 L burned idling over 2 hours
    { durationS: 600, speedKmh: 60, lPerHour: 18 },
  ]);
  assert.equal(detectFuelEvents(r).length, 0);
});

test('a gap in readings while the vehicle moved is reported', () => {
  const r = drive([{ durationS: 1800, speedKmh: 60, lPerHour: 18 }]);
  const withGap = [...r.slice(0, 50), ...r.slice(120)]; // ~700 s missing, ~11.7 km covered
  const gaps = findDataGaps(withGap);
  assert.equal(gaps.length, 1);
  assert.ok(gaps[0].distanceKm > 11 && gaps[0].distanceKm < 12.5);
});

test('a noisy tank sensor does not inflate fuel used', () => {
  // 60 km at 60 km/h burning 18 L/h = 18 L; the sensor wobbles ±1.5 L around the true level
  const clean = drive([{ durationS: 3600, speedKmh: 60, lPerHour: 18 }], { can: false });
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31 - 0.5) * 3;
  const noisy = clean.map((r) => ({ ...r, fuelLevelL: r.fuelLevelL + noise() }));
  const used = segmentTrip(noisy, ctx).reduce((a, s) => a + s.fuelUsedL, 0);
  assert.ok(Math.abs(used - 18) < 1, `got ${used.toFixed(2)} L`);
});
