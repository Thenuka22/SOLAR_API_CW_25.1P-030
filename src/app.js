const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const { notFound, methodNotAllowed, errorHandler } = require('./middleware/errors');
const { requireJsonAccept } = require('./middleware/http');
const tokenRoutes = require('./routes/tokens');
const provinceRoutes = require('./routes/provinces');
const districtRoutes = require('./routes/districts');
const substationRoutes = require('./routes/substations');
const installationRoutes = require('./routes/installations');
const readingRoutes = require('./routes/readings');
const summaryRoutes = require('./routes/summaries');

const pool = require('./config/db');
const { renderHome } = require('./views/home');

const app = express();

// The rows of the landing page's status card. Each one is checked when the page is requested;
// nothing here is assumed.
async function statusChecks() {
  let database = true;
  try {
    await pool.query('SELECT 1');
  } catch {
    database = false;
  }
  const signing = Buffer.byteLength(process.env.JWT_SECRET ?? '', 'utf8') >= 32;
  return [
    { title: 'API Endpoints Ready', detail: `${Object.keys(swaggerSpec.paths).length} paths under /solar/v1.0`, healthy: true },
    { title: 'Database Connected', detail: 'PostgreSQL answering queries', healthy: database },
    { title: 'Token Issuing', detail: 'JWT sign-in for staff, devices, provisioner', healthy: signing },
    { title: 'OpenAPI Documentation', detail: 'Swagger UI at /api-docs', healthy: true },
  ];
}

// Number of proxies in front of the app whose X-Forwarded-For entries are trusted, so req.ip
// (used for rate limiting) is the real client address. 0 locally; set for Render in render.yaml.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
// Validators are set explicitly on domain GETs (src/http/conditional.js); no automatic ETags
// on other responses such as errors.
app.set('etag', false);
// Do not advertise the framework.
app.disable('x-powered-by');

// Responses are JSON (or Swagger UI's own files); a browser must not guess another type.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

app.use(express.json());
// persistAuthorization keeps the token entered under Authorize across page reloads.
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec, { swaggerOptions: { persistAuthorization: true } }));

app
  .route('/')
  .get((req, res) => {
    // JSON is listed first, so a client that accepts anything (Render's health check, fetch,
    // curl) still gets the small status body. A browser asks for text/html and gets the page.
    res.format({
      'application/json': () => res.json({ status: 'ok' }),
      'text/html': async () => res.send(renderHome(await statusChecks())),
      default: () => res.json({ status: 'ok' }),
    });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

const api = express.Router();
api.use(requireJsonAccept);
api.use(tokenRoutes);
api.use(provinceRoutes);
api.use(districtRoutes);
api.use(substationRoutes);
api.use(installationRoutes);
api.use(readingRoutes);
api.use(summaryRoutes);
app.use('/solar/v1.0', api);

// Keep these last: unmatched paths become 404, and every error is returned as JSON.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
