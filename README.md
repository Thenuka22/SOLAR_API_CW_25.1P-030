# NB6007CEM - Web API Development

## Real-Time Solar Generation Data API

- Coventry Index: 16603116
- NIBM Index: COBSCCOMP25.1P – 030
- NIBM Registered Name: I.T Kannangara

## Design documentation

See the [design documentation index](docs/README.md) for the architecture, domain model, API contract, security design, and test plan. Planned features are labelled separately from the current implementation.

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
