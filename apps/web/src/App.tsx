import { useEffect, useState } from 'react';
import { tokenRole } from './api';
import { useForecast } from './useForecast';
import { formatMetric } from './observations';
import type { ModelRun, Series } from './types';
import { Icon } from './components/Icon';
import { ForecastChart } from './components/ForecastChart';
import { ConnectDialog } from './components/ConnectDialog';
import { DataTools } from './components/DataTools';

const modelName = (name: string) =>
  ({
    naive: 'Last value',
    seasonal_naive: 'Seasonal naive',
    ridge: 'Ridge regression',
    mlp: 'Neural network',
    lstm: 'LSTM',
    neural: 'Neural network',
  })[name] ?? name.replace(/_/g, ' ');
const date = (value: string | undefined) =>
  value
    ? new Date(value).toLocaleString('en', {
        timeZone: 'UTC',
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';

export function App() {
  const [token, setToken] = useState('');
  const [demo, setDemo] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [demoRun, setDemoRun] = useState<ModelRun | null>(null);
  const [demoError, setDemoError] = useState('');
  const [demoLoading, setDemoLoading] = useState(true);
  const live = useForecast(token);
  useEffect(() => {
    let cancelled = false;
    fetch('/demo-result.json')
      .then(async (response) => {
        if (!response.ok)
          throw new Error(
            'The synthetic demonstration run is unavailable. Connect your workspace to explore your own forecasts.',
          );
        const json = await response.json();
        const run = json.run ?? json;
        if (!Array.isArray(run.forecast) || !run.metrics || !Array.isArray(run.candidates))
          throw new Error('The demonstration artifact has an invalid format.');
        if (!cancelled) setDemoRun(run);
      })
      .catch((reason) => {
        if (!cancelled) setDemoError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setDemoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const run = demo ? demoRun : live.run;
  const loading = demo ? demoLoading : live.loading;
  const error = demo ? demoError : live.error;
  const demoSeries: Series = {
    id: demoRun?.series_id ?? 'demo',
    name: 'Synthetic demand',
    frequency: demoRun?.config.frequency === 'h' ? 'h' : 'D',
    observation_count: demoRun?.sample_count,
    last_timestamp: demoRun?.data_cutoff,
  };
  const selected = demo ? demoSeries : live.series.find((series) => series.id === live.selectedId);
  const stale =
    !!run &&
    (run.stale === true ||
      (typeof selected?.observation_count === 'number' &&
        selected.observation_count !== run.sample_count) ||
      (!!selected?.last_timestamp &&
        new Date(selected.last_timestamp).getTime() !== new Date(run.data_cutoff).getTime()));
  const role = tokenRole(token);
  const alpha = Number(run?.config.interval_alpha ?? 0.1);
  const intervalLabel =
    run && Number.isFinite(alpha)
      ? `${Math.round((1 - alpha) * 100)}% nominal interval`
      : 'Prediction interval';
  const candidates = [...(run?.candidates ?? [])].sort(
    (a, b) => (a.validation_mae ?? Infinity) - (b.validation_mae ?? Infinity),
  );
  const future = run?.forecast ?? [];
  const metrics = run?.metrics;
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="#overview" aria-label="Forecast Studio overview">
          <span className="brand-mark">
            <Icon name="chart" size={23} />
          </span>
          <span>
            Forecast<span className="brand-light">Studio</span>
          </span>
        </a>
        <div className="workspace-label">YOUR WORKSPACE</div>
        <div className="workspace-card">
          <span className="workspace-avatar">FS</span>
          <div>
            <strong>{demo ? 'Demo workspace' : 'Forecast workspace'}</strong>
            <small>{demo ? 'Explore the workflow' : 'Connected securely'}</small>
          </div>
        </div>
        <nav aria-label="Dashboard sections">
          <a className="nav-item active" href="#overview">
            <Icon name="grid" />
            Overview
            <span className="nav-dot" />
          </a>
          <a className="nav-item" href="#forecast">
            <Icon name="chart" />
            Forecasts
          </a>
          <a className="nav-item" href="#performance">
            <Icon name="layers" />
            Model performance
          </a>
          <a className="nav-item" href="#data">
            <Icon name="data" />
            Data & training
          </a>
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-note">
            <span className="sidebar-note-icon">
              <Icon name="spark" size={19} />
            </span>
            <strong>Built to improve.</strong>
            <p>A reproducible workflow from historical data to your next forecast.</p>
            <a href="#data">
              Explore training
              <Icon name="arrow" size={14} />
            </a>
          </div>
          <div className="sidebar-status">
            <span className="status-dot" />
            {demo ? 'Synthetic demonstration' : 'Authenticated API'}
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            Workspace<span>/</span>
            <strong>Overview</strong>
          </div>
          <div className="topbar-actions">
            <span className={`badge ${demo ? 'purple' : 'teal'}`}>
              <span className="tiny-dot" />
              {demo ? 'Read-only demo' : 'Live workspace'}
            </span>
            {demo ? (
              <button className="button secondary small" onClick={() => setConnecting(true)}>
                <Icon name="lock" size={14} />
                Connect workspace
              </button>
            ) : (
              <button
                className="button secondary small"
                onClick={() => {
                  setToken('');
                  setDemo(true);
                }}
              >
                Disconnect
              </button>
            )}
          </div>
        </header>
        <main id="overview">
          <section className="page-intro">
            <div>
              <span className="eyebrow">FORECAST OVERVIEW</span>
              <h1>A clearer view of what’s next.</h1>
              <p>Explore your forecast, understand its uncertainty, and keep improving.</p>
            </div>
            <div className="series-control">
              <label htmlFor="series-select">Current series</label>
              <select
                id="series-select"
                value={demo ? 'demo' : live.selectedId}
                onChange={(event) => live.setSelectedId(event.target.value)}
                disabled={demo || loading || !live.series.length}
              >
                {demo ? (
                  <option value="demo">Synthetic demand · Daily</option>
                ) : live.series.length ? (
                  live.series.map((series) => (
                    <option key={series.id} value={series.id}>
                      {series.name} · {series.frequency === 'D' ? 'Daily' : 'Hourly'}
                    </option>
                  ))
                ) : (
                  <option value="">No series yet</option>
                )}
              </select>
            </div>
          </section>
          {demo && (
            <div className="demo-banner">
              <div className="demo-banner-icon">
                <Icon name="spark" size={18} />
              </div>
              <div>
                <strong>You’re exploring a synthetic dataset.</strong>
                <span>
                  These results come from an actual Python training run. Connect your workspace to
                  use your own data.
                </span>
              </div>
              <button className="text-button" onClick={() => setConnecting(true)}>
                Connect
                <Icon name="arrow" size={16} />
              </button>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              {error}
              {!demo && (
                <button className="text-button" onClick={live.refresh}>
                  Retry
                </button>
              )}
            </div>
          )}
          {stale && (
            <div className="notice warning" role="status">
              <Icon name="clock" size={18} />
              <span>
                The stored observation history has changed since this run. The latest stored
                observation is <strong>{date(selected?.last_timestamp ?? undefined)} UTC</strong>;
                this forecast uses the snapshot through {date(run?.data_cutoff)} UTC. Retrain to
                include the changed history.
              </span>
            </div>
          )}
          {loading && (
            <div className="loading-state" role="status">
              <span className="loading-spinner" />
              Loading forecast results…
            </div>
          )}
          {!loading && !run && !error && (
            <div className="empty-state">
              <Icon name="chart" size={40} />
              <h2>Your next forecast starts here.</h2>
              <p>
                {live.series.length
                  ? 'Import regularly spaced observations and start your first training run.'
                  : 'Create a series, import your historical observations, then train your first model.'}
              </p>
              <a className="button primary" href="#data">
                Set up your data
                <Icon name="arrow" size={16} />
              </a>
            </div>
          )}
          <div className="metrics-heading">
            <span>HELD-OUT TEST PERFORMANCE · ALL HORIZONS</span>
            <span>
              {run ? `Selected model: ${modelName(run.selected_model)}` : 'Awaiting model run'}
            </span>
          </div>
          <section className="metrics-grid" aria-label="Selected model held-out test metrics">
            {[
              {
                key: 'mae',
                label: 'Mean absolute error',
                value: metrics?.mae,
                suffix: '',
                note: 'Average error in series units',
                symbol: '↔',
              },
              {
                key: 'rmse',
                label: 'Root mean squared error',
                value: metrics?.rmse,
                suffix: '',
                note: 'Sensitive to larger errors',
                symbol: '∿',
              },
              {
                key: 'smape',
                label: 'Symmetric MAPE',
                value: metrics?.smape,
                suffix: '%',
                note: 'Relative prediction error',
                symbol: '%',
              },
              {
                key: 'mase',
                label: 'Mean absolute scaled error',
                value: metrics?.mase,
                suffix: '',
                note: 'Below 1 improves on naive scale',
                symbol: '⌁',
              },
            ].map((metric, index) => (
              <article className={`metric-card metric-${index}`} key={metric.key}>
                <div className="metric-top">
                  <span>{metric.label}</span>
                  <span className="metric-symbol" aria-hidden="true">
                    {metric.symbol}
                  </span>
                </div>
                <div className="metric-value">{formatMetric(metric.value, metric.suffix)}</div>
                <span className="metric-note">{metric.note}</span>
              </article>
            ))}
          </section>
          {!!metrics?.by_horizon?.length && (
            <details className="horizon-metrics">
              <summary>
                Inspect performance by forecast horizon · {metrics.origin_count ?? '—'} test origins
              </summary>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Horizon</th>
                      <th scope="col">MAE</th>
                      <th scope="col">RMSE</th>
                      <th scope="col">sMAPE</th>
                      <th scope="col">MASE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.by_horizon.map((row) => (
                      <tr key={row.horizon}>
                        <th scope="row">
                          {row.horizon} {selected?.frequency === 'h' ? 'hour' : 'day'}
                          {row.horizon === 1 ? '' : 's'} ahead
                        </th>
                        <td>{formatMetric(row.mae)}</td>
                        <td>{formatMetric(row.rmse)}</td>
                        <td>{formatMetric(row.smape, '%')}</td>
                        <td>{formatMetric(row.mase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
          <section id="forecast" className="panel forecast-panel">
            <div className="panel-heading">
              <div>
                <div className="title-with-badge">
                  <h2>Forecast outlook</h2>
                  <span className="badge neutral">
                    {future.length || '—'} {selected?.frequency === 'h' ? 'hours' : 'days'} ahead
                  </span>
                </div>
                <p className="panel-subtitle">
                  Recent training history and the next {future.length || '—'} steps ·{' '}
                  {selected?.name ?? 'Select a series'}
                </p>
              </div>
              <div className="forecast-tools">
                <span className={`badge ${stale ? 'amber' : 'teal'}`}>
                  <span className="tiny-dot" />
                  {stale ? 'Retrain needed' : run ? 'Model trained' : 'No model'}
                </span>
                {!demo && (
                  <button
                    className="icon-button"
                    aria-label="Refresh forecasts and observations"
                    disabled={loading}
                    onClick={live.refresh}
                  >
                    <Icon name="refresh" size={18} />
                  </button>
                )}
              </div>
            </div>
            <ForecastChart history={run?.history} forecast={future} intervalLabel={intervalLabel} />
            <div className="chart-footer">
              <span>
                <Icon name="clock" size={14} />
                Data cutoff: {date(run?.data_cutoff)} UTC
              </span>
              <span>Forecasts update after a new training run.</span>
            </div>
          </section>
          <section id="performance" className="performance-grid">
            <article className="panel backtest-panel">
              <div className="panel-heading">
                <div>
                  <h2>Actual vs. predicted</h2>
                  <p className="panel-subtitle">
                    Rolling one-step predictions on held-out test data
                  </p>
                </div>
                <span className="badge purple">Test set</span>
              </div>
              <ForecastChart
                backtest={run?.backtest.filter((point) => point.horizon === 1) ?? []}
                intervalLabel={intervalLabel}
              />
              <p className="chart-footnote">
                Each prediction uses observations available at that point in time. This chart shows
                horizon 1. The core metrics above aggregate all forecast horizons; longer horizons
                can have different errors.
              </p>
            </article>
            <article className="panel model-panel">
              <div className="panel-heading">
                <div>
                  <h2>Model comparison</h2>
                  <p className="panel-subtitle">Selection uses tuning validation MAE</p>
                </div>
                <Icon name="layers" size={19} />
              </div>
              <div className="table-scroll">
                <table className="comparison-table">
                  <thead>
                    <tr>
                      <th scope="col">Candidate</th>
                      <th scope="col">Tune MAE</th>
                      <th scope="col">Test MAE</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candidates.length ? (
                      candidates.map((candidate) => (
                        <tr
                          className={candidate.name === run?.selected_model ? 'selected-model' : ''}
                          key={candidate.name}
                        >
                          <th scope="row">
                            <span>{modelName(candidate.name)}</span>
                            {candidate.name === run?.selected_model && <small>Selected</small>}
                          </th>
                          <td>{formatMetric(candidate.validation_mae)}</td>
                          <td>{formatMetric(candidate.test_metrics.mae)}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={3} className="empty-table">
                          Candidates appear after training.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="comparison-note">
                <Icon name="check" size={16} />
                <p>
                  The test set stays separate from tuning and interval calibration. Lower error is
                  better.
                </p>
              </div>
              <details className="candidate-details">
                <summary>All candidate test metrics</summary>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Candidate</th>
                        <th>RMSE</th>
                        <th>sMAPE</th>
                        <th>MASE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {candidates.map((candidate) => (
                        <tr key={candidate.name}>
                          <th scope="row">{modelName(candidate.name)}</th>
                          <td>{formatMetric(candidate.test_metrics.rmse)}</td>
                          <td>{formatMetric(candidate.test_metrics.smape, '%')}</td>
                          <td>{formatMetric(candidate.test_metrics.mase)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            </article>
          </section>
          <section className="provenance-grid">
            <article className="panel provenance-panel">
              <div className="panel-heading">
                <div className="panel-title">
                  <Icon name="lock" size={18} />
                  <h3>Run provenance</h3>
                </div>
                <span className="badge neutral">Reproducible</span>
              </div>
              <dl className="provenance-list">
                <div>
                  <dt>Observations used</dt>
                  <dd>{run?.sample_count?.toLocaleString() ?? '—'}</dd>
                </div>
                <div>
                  <dt>Trained at</dt>
                  <dd>
                    {date(run?.trained_at)}
                    {run && ' UTC'}
                  </dd>
                </div>
                <div>
                  <dt>Seed</dt>
                  <dd>{run ? String(run.config.seed ?? '—') : '—'}</dd>
                </div>
                <div>
                  <dt>Run ID</dt>
                  <dd className="monospace" title={run?.run_id}>
                    {run?.run_id ?? '—'}
                  </dd>
                </div>
              </dl>
              {run && (
                <details className="run-details">
                  <summary>Configuration, splits and data fingerprint</summary>
                  <pre>
                    {JSON.stringify(
                      { config: run.config, split: run.split, data_hash: run.data_hash },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
            </article>
            <article className="panel uncertainty-panel">
              <div className="panel-heading">
                <div className="panel-title">
                  <Icon name="spark" size={18} />
                  <h3>Understanding uncertainty</h3>
                </div>
                <span className="badge teal">{intervalLabel}</span>
              </div>
              <div className="interval-stats">
                <div>
                  <strong>
                    {formatMetric(
                      typeof metrics?.interval_coverage === 'number'
                        ? metrics.interval_coverage * 100
                        : null,
                      '%',
                    )}
                  </strong>
                  <span>Test interval coverage</span>
                </div>
                <div>
                  <strong>{formatMetric(metrics?.interval_mean_width)}</strong>
                  <span>Average interval width</span>
                </div>
              </div>
              <p>
                Intervals use a separate calibration slice of validation data. Coverage is empirical
                and can change as the series evolves; the nominal level is not a guarantee.
              </p>
              {run?.warnings?.length ? (
                <details className="run-warnings">
                  <summary>
                    {run.warnings.length} model {run.warnings.length === 1 ? 'note' : 'notes'}
                  </summary>
                  <ul>
                    {run.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </article>
          </section>
          <DataTools
            enabled={!demo && role === 'trainer'}
            demo={demo}
            selected={selected}
            history={demo ? (demoRun?.history ?? []) : live.history}
            jobs={demo ? [] : live.jobs}
            request={live.request}
            onChange={live.refresh}
            onSelect={live.setSelectedId}
          />
          <footer className="page-footer">
            <span>
              Forecast Studio<span className="footer-dot">·</span>Reproducible models. Informed
              decisions.
            </span>
            <span>
              {demo ? 'Synthetic data · Read-only demo' : 'Tenant-scoped workspace'}
              <span className="footer-dot">·</span>All timestamps UTC
            </span>
          </footer>
        </main>
      </div>
      {connecting && (
        <ConnectDialog
          onConnect={(value) => {
            setToken(value);
            setDemo(false);
            setConnecting(false);
          }}
          onClose={() => setConnecting(false)}
        />
      )}
    </div>
  );
}
