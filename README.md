# NB6007CEM - Web API Development

## Real-Time Solar Generation Data API

- Coventry Index: 16603116
- NIBM Index: COBSCCOMP25.1P – 030
- NIBM Registered Name: I.T Kannangara

## Design documentation

See the [documentation index](docs/README.md) for the domain model, endpoint responses and errors, WSO2 design rules, architecture, security, and testing notes.

## Database migrations

Copy `.env.example` to `.env` and set `DATABASE_URL` to a PostgreSQL database. `.env` is ignored by Git.

```sh
npm run db:migrate
```

The runner applies the numbered SQL files in `src/db/migrations/` in order, each in its own transaction, and records them in the `schema_migrations` table. Files that have already run are skipped, so a repeat run changes nothing. The command exits with an error if `DATABASE_URL` is not set.

```sh
npm run db:seed
```

The seed runner applies the SQL files in `src/db/seeds/` in order after the migrations have run. The seeds are repeatable: rows that already exist are left unchanged, so running the command again adds nothing.

The seeds load 9 provinces, 25 districts, 35 grid substations, 200 installations, and one week of 15-minute readings for every installation (2026-09-01 00:00 to 2026-09-08 00:00 Sri Lanka time, end exclusive: 134,400 readings). Reading values are generated deterministically, so every run produces the same data. Readings are append-only and cannot be deleted, so use a fresh database to start again.

The seed also creates three demo staff users, one for each role: a national reader, a provincial reader for Western, and a district reader for Colombo. It stores no passwords. Demo users can sign in only after a password is set with the credentials command below. Credentials are supplied separately for assessment and are not stored in the repository.

## Credentials

Staff passwords, provisioner accounts, and device secrets are managed from the command line, never through the API:

```sh
npm run credentials -- staff-password <email>
npm run credentials -- provisioner-password <username>
npm run credentials -- device-secret <meter-id>
```

Passwords are typed at a hidden prompt (or piped on standard input), never passed as arguments. A new device secret is printed once. See [Authentication](docs/authentication.md#operator-command).

## Tests

```sh
npm test
```

Runs the automated tests in `test/` with Node's built-in test runner. The HTTP tests start the app on a temporary local port. Tests that read or write data need `DATABASE_URL`, migrations, and seed data; they roll back everything they write and are skipped when `DATABASE_URL` is not set. See [Testing](docs/testing.md#recorded-results).

## Deployment

The API is deployed on [Render](https://render.com) as a Node web service, configured by `render.yaml`.

| Setting | Value |
| --- | --- |
| Service type | Web Service |
| Runtime | Node 24.16.0 |
| Plan | Free |
| Region | Singapore |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check | `/` |

Render sets the `PORT` environment variable, and the server listens on that port on `0.0.0.0`.

| Environment variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; set in the Render dashboard |
| `JWT_SECRET` | Token signing key, at least 32 random bytes; Render generates it (`generateValue` in `render.yaml`) |
| `TRUST_PROXY_HOPS` | Proxies whose `X-Forwarded-For` entry is trusted for the client address; `1` on Render, unset locally |

For local token issuance add `JWT_SECRET` to `.env` (see `.env.example`).
