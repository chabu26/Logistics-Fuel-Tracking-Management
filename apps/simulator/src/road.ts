import { bearingDeg, haversineKm } from '@fleetfuel/shared';
import type { DemoRoute } from '@fleetfuel/shared/demo';
import type { Rng } from './random';

export interface RoadPoint {
  km: number;
  lat: number;
  lon: number;
  altM: number;
  headingDeg: number;
  urban: boolean;
  winding: boolean;
}

/** A route turned into a dense line of points every `stepKm`, with terrain and bends added. */
export interface Road {
  code: string;
  lengthKm: number;
  points: RoadPoint[];
  stepKm: number;
}

const M_PER_DEG_LAT = 111_320;

/**
 * Build a drivable road from a route's waypoints. Altitude follows the waypoints with eased transitions
 * plus gentle rolling hills; winding sections get bends so the heading changes like a real escarpment road.
 */
export function buildRoad(route: DemoRoute, rng: Rng, reverse = false, stepKm = 0.1): Road {
  const orig = route.points;
  // a winding leg is winding in both directions: reversed leg i is original leg (n - 2 - i)
  const wps = reverse ? [...orig].reverse().map((p, i) => ({ ...p, winding: !!orig[orig.length - 2 - i]?.winding })) : orig;
  const hillPhase = rng.between(0, Math.PI * 2);
  const points: RoadPoint[] = [];
  let total = 0;
  const legs = wps.slice(1).map((b, i) => {
    const a = wps[i];
    // roads are ~12% longer than the straight line between towns
    const km = haversineKm(a.lat, a.lon, b.lat, b.lon) * 1.12;
    const leg = { a, b, startKm: total, km };
    total += km;
    return leg;
  });

  for (let km = 0; km <= total; km += stepKm) {
    const leg = legs.find((l) => km <= l.startKm + l.km) ?? legs[legs.length - 1];
    const f = Math.min(1, (km - leg.startKm) / leg.km);
    const ease = (1 - Math.cos(Math.PI * f)) / 2;
    let lat = leg.a.lat + (leg.b.lat - leg.a.lat) * f;
    let lon = leg.a.lon + (leg.b.lon - leg.a.lon) * f;
    const winding = !!leg.a.winding;
    if (winding) {
      // bends: sideways offset of ±150 m every ~1.2 km
      const off = 150 * Math.sin((2 * Math.PI * km) / 1.2);
      const brg = (bearingDeg(leg.a.lat, leg.a.lon, leg.b.lat, leg.b.lon) * Math.PI) / 180;
      lat += (off * -Math.sin(brg)) / M_PER_DEG_LAT;
      lon += (off * Math.cos(brg)) / (M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180));
    }
    // rolling terrain on top of the waypoint altitudes: ±10 m every ~3 km
    const altM = leg.a.altM + (leg.b.altM - leg.a.altM) * ease + 10 * Math.sin((2 * Math.PI * km) / 3 + hillPhase);
    const urban = km < route.urbanKm || km > total - route.urbanKm;
    points.push({ km, lat, lon, altM, headingDeg: 0, urban, winding });
  }
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    points[i].headingDeg = bearingDeg(a.lat, a.lon, b.lat, b.lon);
  }
  return { code: route.code, lengthKm: total, points, stepKm };
}

/** Position on the road at a given distance, interpolated between points. */
export function pointAt(road: Road, km: number): RoadPoint {
  const i = Math.min(road.points.length - 2, Math.max(0, Math.floor(km / road.stepKm)));
  const a = road.points[i];
  const b = road.points[i + 1];
  const f = Math.min(1, Math.max(0, (km - a.km) / road.stepKm));
  return { ...a, km, lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, altM: a.altM + (b.altM - a.altM) * f };
}

/** Gradient (rise over run) at a distance along the road. */
export function gradeAt(road: Road, km: number): number {
  const a = pointAt(road, Math.max(0, km - 0.1));
  const b = pointAt(road, Math.min(road.lengthKm, km + 0.1));
  const run = (b.km - a.km) * 1000;
  return run > 0 ? (b.altM - a.altM) / run : 0;
}
