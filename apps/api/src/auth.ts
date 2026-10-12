import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export type Role = 'admin' | 'fleet_manager' | 'owner' | 'driver' | 'depot_attendant';

export interface AuthUser {
  userId: string;
  companyId: string;
  role: Role;
  name: string;
}

/** Who can do what. Routes pick one of these lists. */
export const CAN = {
  manageFleet: ['admin', 'fleet_manager'] as Role[],
  manageUsers: ['admin'] as Role[],
  viewAnalysis: ['admin', 'fleet_manager', 'owner'] as Role[],
  handleAlerts: ['admin', 'fleet_manager'] as Role[],
  logTrips: ['admin', 'fleet_manager', 'driver'] as Role[],
  logRefuels: ['admin', 'fleet_manager', 'driver', 'depot_attendant'] as Role[],
  manageDepot: ['admin', 'fleet_manager', 'depot_attendant'] as Role[],
  runProcessing: ['admin', 'fleet_manager'] as Role[],
};

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string | null): boolean {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const sign = (data: string) => createHmac('sha256', env.authSecret).update(data).digest('base64url');

/** A signed token in JWT format (HS256), so standard tools can read it. */
export function signToken(user: AuthUser): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ sub: user.userId, cid: user.companyId, role: user.role, name: user.name, iat: now, exp: now + env.tokenTtlHours * 3600 }));
  return `${header}.${payload}.${sign(`${header}.${payload}`)}`;
}

export function verifyToken(token: string): AuthUser | null {
  const [header, payload, sig] = token.split('.');
  if (!header || !payload || !sig) return null;
  const expected = Buffer.from(sign(`${header}.${payload}`));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof p.exp !== 'number' || p.exp < Date.now() / 1000) return null;
    return { userId: p.sub, companyId: p.cid, role: p.role, name: p.name };
  } catch {
    return null;
  }
}
