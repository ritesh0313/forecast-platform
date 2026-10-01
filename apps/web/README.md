# Forecast Studio web client

Responsive React + TypeScript dashboard for the API described in `../../docs/CONTRACT.md`. It uses accessible SVG charts with toggled legends and exact-value tables; no external chart service is required.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api` to the Node backend at `http://localhost:3000`. Production hosting must route `/api` to the backend on the same origin (the supplied container stack does this).

The first screen fetches `public/demo-result.json`, a real result produced by the Python pipeline from synthetic observations. Missing fixtures show an explicit error; the UI never invents performance results. Demo mode is read only. Connect with a signed platform JWT to load tenant-scoped series; trainer access enables creation, imports and retraining. The token exists only in React memory and is cleared on reload/disconnect. Client-decoded role claims affect presentation only; the API remains responsible for authentication, authorization and tenant isolation.

Import a JSON array (or `{ "observations": [...] }`) of timestamp/value objects, or a two-column CSV headed `timestamp,value`. Use ISO date-times with `Z` or an explicit timezone offset. The client normalizes UTC, sorts rows, rejects nonfinite values, invalid calendar dates, duplicate instants, more than 10,000 rows and cadence gaps. The server performs its own validation and rejects conflicts with stored values.

Training submits `{ config: { horizon: 7, epochs: 80, seed: 42 } }` by default. Active queued/running jobs poll every three seconds; polling stops at completion, on series change or disconnect. Forecasts remain tied to the training snapshot, and new observations or backfilled history trigger a visible retraining notice. The actual-vs-predicted chart filters held-out results to horizon 1. Core metrics aggregate the full forecast horizon across held-out origins. Per-horizon metrics are available in an expandable table. Nominal intervals carry an empirical-coverage caveat; undefined metrics display `—`.

```sh
npm test
npm run build
npm run preview
```

`src/observations.test.ts` covers timezone normalization, invalid-date/value/duplicate rejection, cadence gaps and null metric formatting. `build` performs strict TypeScript checking before compiling the static dashboard. Vite preview serves static demo assets only; use the development proxy or production reverse proxy for connected API access.
