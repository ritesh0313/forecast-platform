import { jwtVerify } from 'jose';
import { z } from 'zod';
import { HttpError } from './errors.js';
import { requireSecret } from './config.js';

const claimsSchema = z.object({
  tenant_id: z.uuid(),
  role: z.enum(['reader', 'trainer']),
  exp: z.number().int(),
  iat: z.number().int(),
});
export function authenticate(secret) {
  const key = new TextEncoder().encode(requireSecret(secret, 'JWT_SECRET'));
  return async (request, _response, next) => {
    try {
      const authorization = request.headers.authorization;
      if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization))
        throw new Error('missing');
      const { payload } = await jwtVerify(authorization.slice(7), key, {
        algorithms: ['HS256'],
        issuer: 'forecast-platform',
        audience: 'forecast-api',
        requiredClaims: ['exp', 'iat', 'tenant_id', 'role'],
        maxTokenAge: '24h',
      });
      const claims = claimsSchema.parse(payload);
      request.auth = { tenantId: claims.tenant_id, role: claims.role };
      next();
    } catch {
      next(new HttpError(401, 'unauthorized', 'A valid access token is required.'));
    }
  };
}

export function trainer(request, _response, next) {
  if (request.auth.role !== 'trainer')
    return next(new HttpError(403, 'forbidden', 'The trainer role is required.'));
  next();
}
