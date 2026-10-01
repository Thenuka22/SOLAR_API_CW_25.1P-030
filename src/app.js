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

const app = express();

// Number of proxies in front of the app whose X-Forwarded-For entries are trusted, so req.ip
// (used for rate limiting) is the real client address. 0 locally; set for Render in render.yaml.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
// Validators are set explicitly on domain GETs (src/http/conditional.js); no automatic ETags
// on other responses such as errors.
app.set('etag', false);

app.use(express.json());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app
  .route('/')
  .get((req, res) => {
    res.json({ status: 'ok' });
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
app.use('/solar/v1.0', api);

// Keep these last: unmatched paths become 404, and every error is returned as JSON.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
