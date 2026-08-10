# Local development

Two processes: the FastAPI backend on **:8000** and the Vite frontend on
**:3000**. The frontend proxies `/api/*` to the backend, so both look like one
origin to the browser and there is no CORS to configure.

## 1. Backend (port 8000, auth off)

```powershell
cd c:\Users\AI.SN\Desktop\sAI\mpchatbot\backend
$env:DASHBOARD_PASSWORD=""; $env:DASHBOARD_SESSION_SECRET=""
python -m uvicorn main:app --port 8000 --reload
```

`main.py` computes:

```python
AUTH_DISABLED = not DASHBOARD_PASSWORD or not DASHBOARD_SESSION_SECRET
```

so blanking **either** variable turns auth off for the whole `/api/*` surface.
`.env` is still loaded, so blank them in the shell rather than assuming they
are absent. Confirm with:

```powershell
curl http://localhost:8000/api/auth/verify
# {"valid":true,"authDisabled":true}
```

If that returns anything else, the frontend will show the login screen.

## 2. Frontend (port 3000)

```powershell
cd c:\Users\AI.SN\Desktop\sAI\mpchatbot\frontend
npm run dev
```

Open <http://localhost:3000>.

Point it at a different backend with:

```powershell
$env:VITE_API_PROXY_TARGET="http://localhost:9000"; npm run dev
```

## How the API base is resolved

`src/config.js`:

```js
export const API_BASE = import.meta.env.VITE_API_URL ?? "";
```

- **Dev** — `VITE_API_URL` is unset, so `API_BASE` is `""` and calls go to
  `/api/...` on :3000, where `vite.config.js`'s `server.proxy` forwards them to
  :8000. Do **not** set `VITE_API_URL` in dev; it would bypass the proxy and
  reintroduce CORS.
- **Production** — `.env.production` supplies `VITE_API_URL`. The dev proxy is
  not part of the build and has no effect there.

## Why the login screen used to appear locally

Two independent faults, both fixed:

1. No dev proxy existed, so `/api/*` hit the Vite dev server instead of a
   backend. Every call 404'd, including the login POST — which is why the
   password looked "rejected" when nothing was actually checking it.
2. `App.jsx` only called `/api/auth/verify` when a token was already in
   localStorage. With auth disabled the backend answers `/api/auth/login` with
   **503 auth_disabled**, so no token could ever be obtained: login screen →
   login impossible → deadlock.

`App.jsx` now starts in the "checking" state in dev so `verify` runs without a
token. That branch is gated on `import.meta.env.DEV`, which `vite build`
replaces with `false` — production still shows the login screen when a token is
missing, so a misconfigured prod server cannot become publicly readable.

## Deep-link smoke test

With both processes up:

| URL | Expected |
| --- | --- |
| `http://localhost:3000/?view=team&team=team_b` | Team B dashboard |
| `http://localhost:3000/?view=client&client=CBMS` | CBMS client dashboard |
| `http://localhost:3000/?view=team` | Home (no crash) |
| `http://localhost:3000/?view=banana` | Home (no crash) |

Optional period param: `&period=today|week|month`.
