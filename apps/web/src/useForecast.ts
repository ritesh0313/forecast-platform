import { useEffect, useMemo, useState } from 'react';
import { apiClient, ApiError } from './api';
import type { Job, ModelRun, Observation, Series } from './types';

export function useForecast(token: string) {
  const request = useMemo(() => apiClient(token), [token]);
  const [series, setSeries] = useState<Series[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [run, setRun] = useState<ModelRun | null>(null);
  const [history, setHistory] = useState<Observation[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = () => setRevision((value) => value + 1);

  useEffect(() => {
    let cancelled = false;
    setSeries([]);
    setSelectedId('');
    setRun(null);
    setHistory([]);
    setJobs([]);
    setError('');
    if (!token) return;
    setLoading(true);
    request<{ series: Series[] }>('/series')
      .then((data) => {
        if (cancelled) return;
        setSeries(data.series);
        setSelectedId(data.series[0]?.id ?? '');
      })
      .catch((reason) => {
        if (!cancelled) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, request]);

  useEffect(() => {
    if (!token || !selectedId) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setRun(null);
    setHistory([]);
    setJobs([]);
    const forecast = request<{ run: ModelRun }>(`/series/${selectedId}/forecast`).catch(
      (reason) => {
        if (reason instanceof ApiError && reason.status === 404) return { run: null };
        throw reason;
      },
    );
    Promise.all([
      forecast,
      request<{ observations: Observation[] }>(`/series/${selectedId}/observations?limit=500`),
      request<{ jobs: Job[] }>(`/series/${selectedId}/jobs`),
      request<{ series: Series[] }>('/series'),
    ])
      .then(([forecastData, observationData, jobData, seriesData]) => {
        if (cancelled) return;
        setRun(forecastData.run);
        setHistory(observationData.observations);
        setJobs(jobData.jobs);
        setSeries(seriesData.series);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token, selectedId, revision, request]);

  const activeJobs = jobs
    .filter((job) => ['queued', 'running'].includes(job.status))
    .map((job) => job.id)
    .join(',');
  useEffect(() => {
    if (!token || !selectedId || !activeJobs) return;
    let cancelled = false,
      inFlight = false;
    const interval = setInterval(async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const result = await request<{ jobs: Job[] }>(`/series/${selectedId}/jobs`);
        if (cancelled) return;
        setJobs(result.jobs);
        const activeIds = activeJobs.split(',');
        if (
          activeIds.some((id) =>
            result.jobs.some((job) => job.id === id && !['queued', 'running'].includes(job.status)),
          )
        )
          refresh();
      } catch (reason) {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Unable to refresh training jobs.');
      } finally {
        inFlight = false;
      }
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [token, selectedId, activeJobs, request]);

  return {
    request,
    series,
    selectedId,
    setSelectedId,
    run,
    history,
    jobs,
    loading,
    error,
    refresh,
  };
}
