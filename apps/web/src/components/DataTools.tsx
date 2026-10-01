import { useState } from 'react';
import { formatMetric, parseObservations, validateCadence } from '../observations';
import type { Job, Observation, Series, TrainingConfig } from '../types';
import { Icon } from './Icon';

interface Props {
  enabled: boolean;
  demo: boolean;
  selected: Series | undefined;
  history: Observation[];
  jobs: Job[];
  request: <T>(path: string, body?: unknown) => Promise<T>;
  onChange: () => void;
  onSelect: (id: string) => void;
}

export function DataTools({
  enabled,
  demo,
  selected,
  history,
  jobs,
  request,
  onChange,
  onSelect,
}: Props) {
  const [source, setSource] = useState('');
  const [name, setName] = useState('');
  const [frequency, setFrequency] = useState<'D' | 'h'>('D');
  const [config, setConfig] = useState<TrainingConfig>({ horizon: 7, epochs: 80, seed: 42 });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const active = jobs.some((job) => ['queued', 'running'].includes(job.status));
  const perform = async (action: string, work: () => Promise<void>) => {
    setBusy(action);
    setError('');
    setMessage('');
    try {
      await work();
      onChange();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The operation failed.');
    } finally {
      setBusy('');
    }
  };
  return (
    <section id="data" className="data-section">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ITERATE & IMPROVE</span>
          <h2>Your data, your next model</h2>
        </div>
        <span className={`badge ${enabled ? 'teal' : 'neutral'}`}>
          <Icon name={enabled ? 'check' : 'lock'} size={13} />
          {demo ? 'Demo is read only' : enabled ? 'Trainer access' : 'Read only'}
        </span>
      </div>
      {!enabled && (
        <p className="section-note">
          {demo
            ? 'Connect your workspace with a trainer token to add data and start a reproducible training run.'
            : 'A trainer access token is required to add data or train models.'}
        </p>
      )}
      {error && (
        <div className="notice error" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="notice success" role="status">
          <Icon name="check" size={17} />
          {message}
        </div>
      )}
      <div className="data-grid">
        <article className="panel">
          <div className="panel-heading">
            <div className="panel-title">
              <Icon name="data" />
              <h3>Observations</h3>
            </div>
            <span className="subtle">JSON or CSV</span>
          </div>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform('import', async () => {
                if (!selected) throw new Error('Select a series first.');
                const observations = parseObservations(source);
                validateCadence(observations, selected.frequency);
                const result = await request<{ inserted: number }>(
                  `/series/${selected.id}/observations`,
                  { observations },
                );
                setMessage(
                  `${result.inserted} observations imported. Retrain to include this data in forecasts.`,
                );
                setSource('');
              });
            }}
          >
            <label htmlFor="observation-source">Paste observations</label>
            <textarea
              id="observation-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={!enabled || !!busy}
              rows={5}
              spellCheck={false}
              placeholder={'timestamp,value\n2025-01-01T00:00:00Z,120\n2025-01-02T00:00:00Z,125'}
            />
            <p className="field-help">
              Use UTC or a timezone offset. One finite numeric value per timestamp; daily or hourly,
              with no gaps. Up to 10,000 rows.
            </p>
            <div className="form-actions">
              <label className={`file-button ${!enabled || !!busy ? 'disabled' : ''}`}>
                <Icon name="upload" size={15} />
                Choose a file
                <input
                  type="file"
                  accept=".csv,.json,text/csv,application/json"
                  disabled={!enabled || !!busy}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    if (!file) return;
                    if (file.size > 2000000) {
                      setError('Choose a file under 2 MB.');
                      return;
                    }
                    try {
                      setSource(await file.text());
                      setError('');
                    } catch {
                      setError('Unable to read the file.');
                    }
                    event.target.value = '';
                  }}
                />
              </label>
              <button
                className="button primary small"
                disabled={!enabled || !selected || !!busy || !source.trim()}
              >
                {busy === 'import' ? 'Importing…' : 'Import data'}
                <Icon name="arrow" size={15} />
              </button>
            </div>
          </form>
          {history.length > 0 && (
            <details className="observation-preview">
              <summary>
                Latest observations ·{' '}
                {selected?.observation_count?.toLocaleString() ?? history.length.toLocaleString()}{' '}
                total
              </summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Timestamp (UTC)</th>
                      <th>Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history
                      .slice(-10)
                      .reverse()
                      .map((row) => (
                        <tr key={row.timestamp}>
                          <th scope="row">{row.timestamp}</th>
                          <td>{formatMetric(row.value)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <details className="create-series">
            <summary>Create a new series</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void perform('create', async () => {
                  const result = await request<{ series: Series }>('/series', {
                    name: name.trim(),
                    frequency,
                  });
                  onSelect(result.series.id);
                  setName('');
                  setMessage(
                    `Created ${result.series.name}. Import observations to start training.`,
                  );
                });
              }}
            >
              <label htmlFor="series-name">Series name</label>
              <input
                id="series-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                disabled={!enabled || !!busy}
                required
                placeholder="e.g. Daily store demand"
              />
              <label htmlFor="new-frequency">Frequency</label>
              <select
                id="new-frequency"
                value={frequency}
                onChange={(event) => setFrequency(event.target.value as 'D' | 'h')}
                disabled={!enabled || !!busy}
              >
                <option value="D">Daily</option>
                <option value="h">Hourly</option>
              </select>
              <button
                className="button secondary small"
                disabled={!enabled || !!busy || !name.trim()}
              >
                {busy === 'create' ? 'Creating…' : 'Create series'}
              </button>
            </form>
          </details>
        </article>
        <article className="panel">
          <div className="panel-heading">
            <div className="panel-title">
              <Icon name="layers" />
              <h3>Train a model</h3>
            </div>
            <span className="subtle">Versioned runs</span>
          </div>
          <p className="body-copy">
            Compare baselines and a neural model using chronological splits. Select on tuning
            validation; report performance on the held-out test set.
          </p>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void perform('train', async () => {
                if (!selected) throw new Error('Select a series first.');
                const result = await request<{ job: Job }>(`/series/${selected.id}/retrain`, {
                  config,
                });
                setMessage(
                  `Training ${result.job.status}. The current observation snapshot is fixed for this run.`,
                );
              });
            }}
          >
            <div className="config-fields">
              <div>
                <label htmlFor="horizon">Forecast horizon</label>
                <input
                  id="horizon"
                  type="number"
                  min="1"
                  max="90"
                  step="1"
                  value={config.horizon}
                  disabled={!enabled || !!busy}
                  onChange={(event) =>
                    setConfig({ ...config, horizon: Number(event.target.value) })
                  }
                  required
                />
                <small>{selected?.frequency === 'h' ? 'hours ahead' : 'days ahead'}</small>
              </div>
              <div>
                <label htmlFor="epochs">Training epochs</label>
                <input
                  id="epochs"
                  type="number"
                  min="1"
                  max="500"
                  step="1"
                  value={config.epochs}
                  disabled={!enabled || !!busy}
                  onChange={(event) => setConfig({ ...config, epochs: Number(event.target.value) })}
                  required
                />
                <small>neural model limit</small>
              </div>
              <div>
                <label htmlFor="seed">Random seed</label>
                <input
                  id="seed"
                  type="number"
                  min="0"
                  max="2147483647"
                  step="1"
                  value={config.seed}
                  disabled={!enabled || !!busy}
                  onChange={(event) => setConfig({ ...config, seed: Number(event.target.value) })}
                  required
                />
                <small>reproducible runs</small>
              </div>
            </div>
            <div className="training-note">
              <Icon name="lock" size={16} />
              <span>
                Every run uses an immutable data snapshot. New observations take effect after
                retraining.
              </span>
            </div>
            <button
              className="button primary full-width"
              disabled={!enabled || !selected || !!busy || active}
            >
              {busy === 'train'
                ? 'Submitting…'
                : active
                  ? 'Training in progress…'
                  : 'Start training run'}
              <Icon name="spark" size={17} />
            </button>
          </form>
          <div className="jobs-list">
            <div className="jobs-title">
              <h4>Recent jobs</h4>
              {active && <span className="subtle">Updates every 3 seconds</span>}
            </div>
            {jobs.length ? (
              jobs.slice(0, 4).map((job) => (
                <div className="job-row" key={job.id}>
                  <div className="job-icon">
                    <Icon
                      name={
                        job.status === 'succeeded' || job.status === 'completed' ? 'check' : 'clock'
                      }
                      size={16}
                    />
                  </div>
                  <div>
                    <strong>Run {job.id.slice(0, 8)}</strong>
                    <small>
                      {new Date(job.created_at).toLocaleString('en', {
                        timeZone: 'UTC',
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}{' '}
                      UTC
                    </small>
                    {job.error && <p className="job-error">{job.error}</p>}
                  </div>
                  <span
                    className={`badge ${job.status === 'failed' ? 'amber' : ['succeeded', 'completed'].includes(job.status) ? 'teal' : 'neutral'}`}
                  >
                    {job.status}
                  </span>
                </div>
              ))
            ) : (
              <p className="empty-jobs">
                {demo ? 'Jobs appear here after you connect and train.' : 'No training jobs yet.'}
              </p>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}
