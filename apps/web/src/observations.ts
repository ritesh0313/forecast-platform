import type { Observation } from './types.ts';

/** Accept an ISO date-time with an explicit timezone, then normalize to UTC. */
export function parseObservations(source: string): Observation[] {
  const text = source.trim().replace(/^\uFEFF/, '');
  if (!text) throw new Error('Add a JSON array or CSV with timestamp,value columns.');
  let rows: unknown[];
  if (text.startsWith('[') || text.startsWith('{')) {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : parsed.observations;
    if (!Array.isArray(rows))
      throw new Error('JSON must be an array or an object with an observations array.');
  } else {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const header = lines
      .shift()
      ?.split(',')
      .map((cell) => cell.trim().toLowerCase());
    if (header?.length !== 2 || header[0] !== 'timestamp' || header[1] !== 'value')
      throw new Error('CSV header must be timestamp,value (two columns).');
    rows = lines.map((line, index) => {
      const cells = line.split(',').map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
      if (cells.length !== 2 || cells[1] === '')
        throw new Error(`CSV row ${index + 2} must contain a timestamp and value.`);
      return { timestamp: cells[0], value: Number(cells[1]) };
    });
  }
  if (rows.length === 0 || rows.length > 10000)
    throw new Error('Import between 1 and 10,000 observations at a time.');
  const seen = new Set<string>();
  const result = rows.map((row, index) => {
    if (!row || typeof row !== 'object')
      throw new Error(`Observation ${index + 1} must be an object.`);
    const record = row as Record<string, unknown>;
    if (
      typeof record.timestamp !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(record.timestamp)
    )
      throw new Error(
        `Observation ${index + 1} needs an ISO date-time with timezone, such as 2025-01-01T00:00:00Z.`,
      );
    const date = new Date(record.timestamp);
    if (!Number.isFinite(date.getTime()))
      throw new Error(`Observation ${index + 1} has an invalid timestamp.`);
    // Date.parse normalizes impossible calendar days; reject them before normalization.
    const day = Number(record.timestamp.slice(8, 10));
    const month = Number(record.timestamp.slice(5, 7));
    const year = Number(record.timestamp.slice(0, 4));
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > maxDay)
      throw new Error(`Observation ${index + 1} has an invalid calendar date.`);
    if (typeof record.value !== 'number' || !Number.isFinite(record.value))
      throw new Error(`Observation ${index + 1} needs a finite numeric value.`);
    const timestamp = date.toISOString();
    if (seen.has(timestamp)) throw new Error(`Duplicate timestamp: ${timestamp}.`);
    seen.add(timestamp);
    return { timestamp, value: record.value };
  });
  return result.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export function validateCadence(rows: Observation[], frequency: 'D' | 'h') {
  const step = frequency === 'D' ? 86400000 : 3600000;
  for (let i = 1; i < rows.length; i++) {
    if (new Date(rows[i].timestamp).getTime() - new Date(rows[i - 1].timestamp).getTime() !== step)
      throw new Error(
        `Imported timestamps must be consecutive ${frequency === 'D' ? 'daily' : 'hourly'} observations. Gaps are rejected by training.`,
      );
  }
}

export function formatMetric(value: number | null | undefined, suffix = '') {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${new Intl.NumberFormat('en', { maximumFractionDigits: 2 }).format(value)}${suffix}`
    : '—';
}
