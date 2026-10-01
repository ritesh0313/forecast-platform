export interface Observation {
  timestamp: string;
  value: number;
}
export interface Prediction {
  timestamp: string;
  horizon: number;
  predicted: number;
  lower?: number | null;
  upper?: number | null;
}
export interface Backtest extends Prediction {
  actual: number;
}
export interface Metrics {
  mae?: number | null;
  rmse?: number | null;
  smape?: number | null;
  mase?: number | null;
  interval_coverage?: number | null;
  interval_mean_width?: number | null;
  by_horizon?: (Metrics & { horizon: number })[];
  origin_count?: number;
}
export interface Candidate {
  name: string;
  validation_mae: number | null;
  test_metrics: Metrics;
}
export interface ModelRun {
  run_id: string;
  series_id: string;
  selected_model: string;
  trained_at: string;
  data_cutoff: string;
  data_hash: string;
  sample_count: number;
  stale?: boolean;
  config: Record<string, unknown>;
  split: Record<string, unknown>;
  metrics: Metrics;
  candidates: Candidate[];
  forecast: Prediction[];
  backtest: Backtest[];
  history: Observation[];
  warnings: string[];
  artifact_path?: string;
}
export interface Series {
  id: string;
  name: string;
  frequency: 'D' | 'h';
  observation_count?: number;
  last_timestamp?: string | null;
}
export interface Job {
  id: string;
  status: string;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  error?: string | null;
  run_id?: string | null;
}
export interface TrainingConfig {
  horizon: number;
  epochs: number;
  seed: number;
}
