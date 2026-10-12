import type { ConditionDimension } from './consumption';

/** Plain-language names for condition values, used in headlines, reports and the apps. */
export const CONDITION_LABELS: Record<string, Record<string, string>> = {
  gradient: { uphill: 'uphill', flat: 'flat road', downhill: 'downhill' },
  traffic: { free: 'free-flowing traffic', slow: 'slow traffic', stop_start: 'stop-start traffic' },
  roadShape: { straight: 'straight road', winding: 'winding road' },
  timeOfDay: { peak: 'peak hours', off_peak: 'off-peak', night: 'at night' },
  loadClass: { empty: 'empty', partial: 'part load', full: 'full load' },
  surface: { tar: 'tarred road', gravel: 'gravel road' },
  weather: { dry: 'dry weather', rain: 'rain' },
};

export const DIMENSION_LABELS: Record<ConditionDimension, string> = {
  speedBand: 'Speed',
  gradient: 'Gradient',
  traffic: 'Traffic',
  roadShape: 'Road shape',
  timeOfDay: 'Time of day',
  loadClass: 'Load',
  surface: 'Road surface',
  weather: 'Weather',
  routeId: 'Route',
  driverId: 'Driver',
};

/**
 * Describe a combination of conditions in words, e.g. "uphill, 20–40 km/h, full load, on LSK-CHR".
 * `names` turns route and driver ids into readable names.
 */
export function describeConditions(conditions: Partial<Record<ConditionDimension, string | null>>, names: Record<string, string> = {}): string {
  const parts: string[] = [];
  for (const [dim, value] of Object.entries(conditions) as [ConditionDimension, string | null][]) {
    if (value == null) continue;
    if (dim === 'speedBand') parts.push(`${value.replace('-', '–')} km/h`);
    else if (dim === 'routeId') parts.push(`on ${names[value] ?? 'an unnamed route'}`);
    else if (dim === 'driverId') parts.push(`driven by ${names[value] ?? 'an unknown driver'}`);
    else parts.push(CONDITION_LABELS[dim]?.[value] ?? value);
  }
  return parts.join(', ');
}
