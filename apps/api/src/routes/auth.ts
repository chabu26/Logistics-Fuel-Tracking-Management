import { z } from 'zod';
import { signToken, verifyPassword, type Role } from '../auth';
import { queryOne } from '../db';
import { HttpError, parse, type Router } from '../http';
import { camel } from '../mappers';

const Login = z.object({ email: z.string().email(), password: z.string().min(1) });

export function authRoutes(r: Router) {
  r.post('/auth/login', { auth: 'none' }, async (ctx) => {
    const { email, password } = parse(Login, ctx.body);
    const user = await queryOne(
      `SELECT u.id, u.company_id, u.full_name, u.role, u.password_hash, c.name AS company_name
         FROM users u JOIN companies c ON c.id = u.company_id
        WHERE lower(u.email) = lower($1) AND u.active`,
      [email],
    );
    if (!user || !verifyPassword(password, user.password_hash)) throw new HttpError(401, 'Email or password is wrong');
    const token = signToken({ userId: user.id, companyId: user.company_id, role: user.role as Role, name: user.full_name });
    return { token, user: { id: user.id, name: user.full_name, role: user.role, companyId: user.company_id, companyName: user.company_name } };
  });

  r.get('/me', {}, async (ctx) => {
    const row = await queryOne(
      `SELECT u.id, u.full_name, u.email, u.phone, u.whatsapp, u.role, c.id AS company_id, c.name AS company_name, c.currency, c.country
         FROM users u JOIN companies c ON c.id = u.company_id WHERE u.id = $1`,
      [ctx.user.userId],
    );
    return camel(row!);
  });
}
