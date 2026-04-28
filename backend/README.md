# DeFiGate Backend Scaffold (Kotani + Privy)
This scaffold contains a minimal Node.js + Express backend and a Netlify-ready frontend snippet to demonstrate the DeFiGate flow using Kotani (on/off-ramp) and Privy (embedded wallets).

## What's included
- `server.js` — Express app wiring routes
- `routes/` & `controllers/` — Mento/Kotani and Privy placeholders
- `migrations/001_create_tables.sql` — Minimal Postgres schema
- `worker/processor.js` — background worker stub for processing crypto jobs
- `frontend/netlify_buy_form/index.html` — simple buy form you can host on Netlify
- `.env.example` — environment variables template
- Logo (already uploaded by you) path: /mnt/data/A_digital_vector_graphic_features_the_logo_for_"De.png
  (use this path to copy into your project assets)

## Quickstart (local)
1. Copy `.env.example` to `.env` and fill in secrets (Kotani, Privy, FRONTEND_URL).
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a local Postgres user and database if you are running locally:
   ```bash
   sudo -u postgres psql -c "CREATE ROLE defigate_user LOGIN PASSWORD 'Admin123';"
   sudo -u postgres psql -c "CREATE DATABASE defigate_db OWNER defigate_user;"
   ```
4. Update `.env` to use the local URL:
   ```bash
   DATABASE_URL=postgresql://defigate_user:Admin123@localhost:5432/defigate_db
   ```
5. Run DB migrations or initialize the schema with your preferred method.
6. Start server:
   ```bash
   npm start
   ```

## Remote fallback
If local Postgres is unavailable, you can start the backend against a remote database by overriding `DATABASE_URL` when launching the server:
```bash
DATABASE_URL="postgresql://postgres.lkceqrnarofwigtoiapv:wqVp6EzMPIjbUOEU@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" npm start
```

## Notes
- `backend/config/database.js` now supports either `DATABASE_URL` or `LOCAL_DATABASE_URL`.
- Local DB connections to `localhost` will use no SSL, while remote DB URLs will use SSL with `rejectUnauthorized: false`.
- Keep credentials out of source control and do not commit your `.env` file.

## Kotani notes
- Kotani provides On-Ramp & Off-Ramp APIs. Refer to https://docs.kotanipay.com for complete API references, sandbox base URL, and webhook signing details.
- Typical flow: create onramp/deposit -> Kotani collects fiat -> mints/sends stablecoins to the specified recipient wallet -> Kotani calls your webhook when done.

## Next steps I can implement for you immediately
1. Wire the Kotani endpoints with fully accurate request/response fields (I can update the controllers using Kotani sandbox examples). I will need your Kotani sandbox API key and webhook secret.
2. Implement DB layer (Knex/TypeORM) and worker using BullMQ to process jobs reliably.
3. Implement Privy full integration with a client page to show wallet creation & balances.

Tell me which of the above you'd like next.
