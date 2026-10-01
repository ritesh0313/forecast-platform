import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createPool } from '../src/db.js';
import { ingestObservations } from '../src/repository.js';
import { normalizedObservations } from '../src/validation.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const tenantId = z
  .uuid()
  .parse(process.env.DEMO_TENANT_ID || '11111111-1111-4111-8111-111111111111');
const seriesId = '22222222-2222-4222-8222-222222222222';
const csv = await readFile(
  fileURLToPath(new URL('../../../data/demo.csv', import.meta.url)),
  'utf8',
);
const [header, ...rows] = csv.trim().split(/\r?\n/);
const columns = header.split(',');
const timestampIndex = columns.indexOf('timestamp');
const valueIndex = columns.indexOf('value');
if (timestampIndex === -1 || valueIndex === -1)
  throw new Error('Demo CSV requires timestamp,value columns.');
const observations = normalizedObservations({
  observations: rows.map((row) => {
    const cells = row.split(',');
    return { timestamp: cells[timestampIndex], value: Number(cells[valueIndex]) };
  }),
});
const pool = createPool(process.env.DATABASE_URL);
try {
  // Fixed UUID makes repeated demo setup idempotent. Do not use the synthetic
  // tenant/series IDs for user data in production.
  const inserted = await pool.query(
    `INSERT INTO series (id, tenant_id, name, frequency) VALUES ($1,$2,'Synthetic daily demand','D') ON CONFLICT (id) DO NOTHING`,
    [seriesId, tenantId],
  );
  if (!inserted.rowCount) {
    const existing = await pool.query('SELECT 1 FROM series WHERE id = $1 AND tenant_id = $2', [
      seriesId,
      tenantId,
    ]);
    if (!existing.rowCount)
      throw new Error('Demo series ID already belongs to a different tenant.');
  }
  const count = await ingestObservations(pool, tenantId, seriesId, observations);
  console.log(`Synthetic demo series ready; ${count} observations inserted.`);
} finally {
  await pool.end();
}
