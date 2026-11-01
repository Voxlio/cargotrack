# CargoTracker

Logistics tracking site with a staff operations console, deployed as a static
frontend plus serverless API on Vercel.

```
public/            static frontend (served by Vercel's CDN)
  index.html         public tracking page
  admin.html         staff console
  images/            local photos + SVG fallbacks + manifest.json
  favicon.png, 404.html
api/index.js       Vercel entry point — hands requests to the Express app
server.js          Express app + local dev server
lib/
  env.js             .env loader (no dotenv dependency)
  auth.js            credential check, HMAC session tokens, login rate limit
  store.js           storage: database.json locally, Upstash Redis in production
  shipments.js       shipment domain logic (create / status change)
scripts/
  fetch-images.mjs           downloads public/images/manifest.json sources
  generate-placeholders.mjs  regenerates the local SVG fallbacks
test/              node:test suite (no dependencies, runs anywhere)
```

## Local development

```bash
npm install
cp .env.example .env        # Windows: copy .env.example .env
npm run fetch-images        # download the photos into public/images/
npm start                   # http://localhost:3000  ·  /admin
```

`npm test` runs the suite with Node's built-in runner. `npm run dev` restarts on
save.

## Deploying to Vercel

1. Push the repo to GitHub and import it at <https://vercel.com/new>. No build
   command is needed — Vercel serves `public/` and turns `api/` into functions.
   `vercel.json` already sets `outputDirectory`, clean URLs and the API rewrite.
2. **Create the database first.** Vercel's filesystem is read-only apart from
   `/tmp`, and `/tmp` is discarded between requests, so `database.json` cannot
   be written in production. Create a free Redis database at
   <https://upstash.com>, open its **REST API** tab, and copy the URL and token.
3. Add these to Project → Settings → Environment Variables (Production and
   Preview):

   | Variable | Example | Notes |
   | --- | --- | --- |
   | `ADMIN_USERNAME` | `admin` | Staff login |
   | `ADMIN_PASSWORD` | long random string | Staff login — never commit this |
   | `SESSION_SECRET` | 96-char hex | Signs session tokens |
   | `UPSTASH_REDIS_REST_URL` | `https://xxx.upstash.io` | Required for writes |
   | `UPSTASH_REDIS_REST_TOKEN` | `AXxx...` | Required for writes |
   | `TZ` | `Africa/Lagos` | Timestamps default to UTC without it |

   Generate the secret with
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.

4. Redeploy. Visit `/api/health` — it should report
   `storage: { backend: "redis", ok: true }` and `auth: "configured"`.

If `UPSTASH_*` is missing on Vercel, lookups still work but creating, updating
and deleting shipments returns a 503 explaining what to connect. That is
deliberate: silently accepting writes that disappear is worse.

Troubleshooting: if `/api/*` returns a 404 from Vercel itself (an HTML page, not
our JSON error), check Project → Functions — `api/index.js` must be listed. The
rewrite in `vercel.json` forwards `/api/(.*)` to it; without that entry in the
Functions tab the file was not picked up as a function.

## API

| Method | Path | Auth |
| --- | --- | --- |
| `POST` | `/api/auth/login` | public |
| `GET` | `/api/auth/session` | staff |
| `GET` | `/api/health` | public |
| `GET` | `/api/shipments` | staff |
| `GET` | `/api/shipments/:id` | public (tracking) |
| `POST` | `/api/shipments/create` | staff |
| `PUT` | `/api/shipments/:id/status` | staff |
| `DELETE` | `/api/shipments/:id` | staff |

Staff requests send `Authorization: Bearer <token>` from `/api/auth/login`.
Tracking IDs are validated as `SH-\d{5}`; anything else is a 400 before it
touches storage.

## Images

`public/images/manifest.json` is the source list. `npm run fetch-images`
downloads anything missing (`--force` to refresh, `--prune` to delete strays).
Each `<img>` falls back to a branded local SVG in `public/images/fallback/` if
its photo is absent, so the site is never broken — run
`npm run placeholders` after editing the manifest.
