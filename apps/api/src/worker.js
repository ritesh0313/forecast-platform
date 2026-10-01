import { setTimeout as sleep } from 'node:timers/promises';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { claimJob, heartbeat, publishRun, failJob } from './queue.js';
import { trainModel, ModelError } from './model-client.js';

const config = loadConfig(process.env, { worker: true });
const pool = createPool(config.databaseUrl);
let stopping = false;
let activeController;
const stop = () => {
  stopping = true;
  activeController?.abort();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log('Forecast training worker started.');
try {
  while (!stopping) {
    let job;
    try {
      job = await claimJob(pool, config.leaseSeconds);
    } catch {
      console.error('Worker could not claim a job.');
      await sleep(config.pollMs);
      continue;
    }
    if (!job) {
      await sleep(config.pollMs);
      continue;
    }
    const controller = new AbortController();
    activeController = controller;
    let ownsLease = true;
    let heartbeatPending = false;
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const timer = setInterval(
      async () => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        try {
          ownsLease = await heartbeat(pool, job, config.leaseSeconds);
        } catch {
          ownsLease = false;
        }
        if (!ownsLease) controller.abort();
        heartbeatPending = false;
      },
      Math.floor((config.leaseSeconds * 1000) / 3),
    );
    try {
      const result = await trainModel(config, job, controller.signal);
      if (ownsLease) {
        const published = await publishRun(pool, job, result);
        console.log(
          published ? 'Training result published.' : 'Expired training result discarded.',
          { job_id: job.id },
        );
      }
    } catch (error) {
      const safeError =
        error instanceof ModelError ? error : new ModelError('Training could not be completed.');
      if (ownsLease) {
        try {
          await failJob(pool, job, safeError.message, safeError.retryable);
        } catch {
          console.error('Worker could not record job failure; lease recovery will retry.');
        }
      }
      console.error('Training attempt failed.', { job_id: job.id, retryable: safeError.retryable });
    } finally {
      clearTimeout(timeout);
      clearInterval(timer);
      activeController = undefined;
    }
  }
} finally {
  await pool.end();
}
