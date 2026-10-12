import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busLoadKg, gradientClass, loadClass, roadShape, speedBand, timeOfDay, trafficClass } from '../src/conditions';

test('speed bands cover every speed', () => {
  assert.equal(speedBand(0), '0-20');
  assert.equal(speedBand(19.9), '0-20');
  assert.equal(speedBand(20), '20-40');
  assert.equal(speedBand(79), '60-80');
  assert.equal(speedBand(130), '100+');
});

test('gradient: above 2% is uphill, below -2% downhill', () => {
  assert.equal(gradientClass(4), 'uphill');
  assert.equal(gradientClass(1.5), 'flat');
  assert.equal(gradientClass(-6), 'downhill');
});

test('traffic: stops make stop-start, low speed makes slow', () => {
  assert.equal(trafficClass(15, 3), 'stop_start');
  assert.equal(trafficClass(25, 0), 'slow');
  assert.equal(trafficClass(70, 0), 'free');
});

test('road shape from heading change per km', () => {
  assert.equal(roadShape(30, 1), 'straight');
  assert.equal(roadShape(300, 1), 'winding');
});

test('time of day uses Zambian local time (UTC+2)', () => {
  // Monday 05:30 UTC = 07:30 local → peak
  assert.equal(timeOfDay('2026-10-12T05:30:00Z'), 'peak');
  // Monday 10:00 UTC = 12:00 local
  assert.equal(timeOfDay('2026-10-12T10:00:00Z'), 'off_peak');
  // 20:00 UTC = 22:00 local
  assert.equal(timeOfDay('2026-10-12T20:00:00Z'), 'night');
  // Saturday 07:30 local is not peak
  assert.equal(timeOfDay('2026-10-10T05:30:00Z'), 'off_peak');
});

test('load class from share of max payload, buses from passengers', () => {
  assert.equal(loadClass(500, 30000), 'empty');
  assert.equal(loadClass(15000, 30000), 'partial');
  assert.equal(loadClass(29000, 30000), 'full');
  assert.equal(loadClass(undefined, 30000), null);
  assert.equal(busLoadKg(60), 5100);
});
