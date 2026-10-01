import test from 'node:test';
import assert from 'node:assert/strict';
import { securityHeaders } from '../src/app.js';

async function collectHeaders(localHttp) {
  const headers = new Map();
  const response = {
    headersSent: false,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
  };
  const request = {
    method: 'GET',
    url: '/',
    headers: {},
    protocol: 'http',
    secure: false,
  };
  await new Promise((resolve, reject) => {
    securityHeaders(localHttp)(request, response, (error) => (error ? reject(error) : resolve()));
  });
  return headers;
}

test('local HTTP mode keeps CSP protections while omitting HTTPS-only headers', async () => {
  const headers = await collectHeaders(true);
  const csp = headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/);
  assert.equal(headers.get('strict-transport-security'), undefined);
});

test('default HTTPS mode keeps HTTPS-only headers independent of request metadata', async () => {
  const headers = await collectHeaders(false);
  assert.match(headers.get('content-security-policy'), /upgrade-insecure-requests/);
  assert.match(headers.get('strict-transport-security'), /max-age=/);
});
