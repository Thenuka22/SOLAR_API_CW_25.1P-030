# NB6007CEM - Web API Development

## Real-Time Solar Generation Data API

- Coventry Index: 16603116
- NIBM Index: COBSCCOMP25.1P – 030
- NIBM Registered Name: I.T Kannangara

## Design documentation

See the [documentation index](docs/README.md) for the domain model, endpoint responses and errors, WSO2 design rules, architecture, security, and testing notes. Domain features are still planned.

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

## Tests

```sh
npm test
```

Runs the automated tests in `test/` with Node's built-in test runner. The HTTP tests start the app on a temporary local port. The database tests in `test/db/` need `DATABASE_URL`, migrations, and seed data; they roll back everything they write and are skipped when `DATABASE_URL` is not set. See [Testing](docs/testing.md#recorded-results).

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
