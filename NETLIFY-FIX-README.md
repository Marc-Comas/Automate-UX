
# Netlify Functions Fix (jobs-create / jobs-status)

- Stronger CORS and consistent `Content-Type: application/json`.
- Robust proxy to Runner with `x-runner-secret` header.
- Timeout protection via `AbortController` (default 10s, override with `RUNNER_FETCH_TIMEOUT_MS`).
- Clear error mapping: 502 when the Runner is unreachable (`{ "error": "fetch failed" }`).

## Required Environment Variables (Netlify)
- `RUNNER_URL` — e.g. https://your-runner.example.com
- `RUNNER_SHARED_SECRET` — shared secret; must match the Runner's `RUNNER_SHARED_SECRET`.
- (optional) `ALLOWED_ORIGIN` — set to your dashboard origin to restrict CORS.
- (optional) `RUNNER_FETCH_TIMEOUT_MS` — defaults to 10000.

