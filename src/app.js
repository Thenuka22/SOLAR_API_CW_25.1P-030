const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');
const { notFound, methodNotAllowed, errorHandler } = require('./middleware/errors');

const app = express();

app.use(express.json());
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app
  .route('/')
  .get((req, res) => {
    res.json({ status: 'ok' });
  })
  .all(methodNotAllowed('GET', 'HEAD'));

// Keep these last: unmatched paths become 404, and every error is returned as JSON.
app.use(notFound);
app.use(errorHandler);

module.exports = app;
