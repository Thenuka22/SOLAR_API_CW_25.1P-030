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
