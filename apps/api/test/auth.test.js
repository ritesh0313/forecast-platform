import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { authenticate, trainer } from '../src/auth.js';

const secret = 'test-only-secret-with-more-than-32-bytes';
const key = new TextEncoder().encode(secret);
async function token(payload, options = {}) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: options.algorithm || 'HS256' })
    .setIssuer(options.issuer || 'forecast-platform')
    .setAudience(options.audience || 'forecast-api')
    .setIssuedAt()
    .setExpirationTime(options.expires || '1h')
    .sign(key);
}
async function verify(value) {
  const request = { headers: { authorization: value ? `Bearer ${value}` : undefined } };
  let error;
  await authenticate(secret)(request, {}, (received) => {
    error = received;
  });
  return { request, error };
}
const claims = { tenant_id: '11111111-1111-4111-8111-111111111111', role: 'trainer' };

test('JWT restricts algorithm, issuer, audience, expiry and tenant role claims', async () => {
  const valid = await verify(await token(claims));
  assert.equal(valid.error, undefined);
  assert.deepEqual(valid.request.auth, { tenantId: claims.tenant_id, role: 'trainer' });
  const invalid = [
    undefined,
    await token(claims, { algorithm: 'HS384' }),
    await token(claims, { issuer: 'other' }),
    await token(claims, { audience: 'other' }),
    await token(claims, { expires: '-1h' }),
    await token({ ...claims, role: 'admin' }),
    await token({ ...claims, tenant_id: 'anything' }),
  ];
  for (const value of invalid) assert.equal((await verify(value)).error.status, 401);
});

test('reader role cannot mutate a series', () => {
  let error;
  trainer({ auth: { role: 'reader' } }, {}, (received) => {
    error = received;
  });
  assert.equal(error.status, 403);
});
