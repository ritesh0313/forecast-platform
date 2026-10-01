import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const target = fileURLToPath(new URL('../.env', import.meta.url));
const secret = () => randomBytes(32).toString('hex');
try {
  writeFileSync(target, `POSTGRES_PASSWORD=${secret()}\nJWT_SECRET=${secret()}\nMODEL_SERVICE_TOKEN=${secret()}\nPORT=3000\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env with unique local secrets. Existing secrets are never overwritten.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env already exists; kept its secrets.');
  else throw error;
}
