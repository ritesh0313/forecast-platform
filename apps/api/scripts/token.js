import { SignJWT } from 'jose';
import { z } from 'zod';
import { requireSecret } from '../src/config.js';

const tenantId = z
  .uuid()
  .parse(process.argv[2] || process.env.DEMO_TENANT_ID || '11111111-1111-4111-8111-111111111111');
const role = z.enum(['reader', 'trainer']).parse(process.argv[3] || 'trainer');
const secret = requireSecret(process.env.JWT_SECRET, 'JWT_SECRET');
const token = await new SignJWT({ tenant_id: tenantId, role })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuer('forecast-platform')
  .setAudience('forecast-api')
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(secret));
console.log(token);
