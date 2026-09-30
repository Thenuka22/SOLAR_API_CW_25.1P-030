const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

// OpenAPI document served at /api-docs. Shared components live here; each operation is
// documented by an @openapi comment next to its route in src/routes/. Only implemented
// endpoints are documented; planned ones are in docs/api-endpoints.md.

const error = (description, extra = {}) => ({
  description,
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  ...extra,
});

const definition = {
  openapi: '3.0.3',
  info: {
    title: 'Real-Time Solar Generation Data API',
    version: '1.0.0',
    description: [
      'Solar generation data for SLSEA staff readers, installation devices, and provisioners.',
      '',
      'Get a token from `POST /solar/v1.0/issue-token`, then send it as `Authorization: Bearer <token>`.',
      'Every error response uses the `Error` schema; `code` is an application code separate from the HTTP status.',
    ].join('\n'),
  },
  tags: [
    { name: 'Status' },
    { name: 'Authentication' },
    { name: 'Provinces', description: 'Staff readers only; results are limited to the reader\'s jurisdiction.' },
  ],
  paths: {
    '/': {
      get: {
        tags: ['Status'],
        summary: 'Service status',
        description: 'Health check used by Render. Not under the versioned base path.',
        responses: {
          200: {
            description: 'The service is running.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status'],
                  additionalProperties: false,
                  properties: { status: { type: 'string', enum: ['ok'] } },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Access token from POST /solar/v1.0/issue-token. Staff and device tokens last 1 hour, provisioner tokens 15 minutes.',
      },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['code', 'message', 'details'],
        additionalProperties: false,
        properties: {
          code: { type: 'integer', description: 'Application error code; see docs/api-endpoints.md#error-format.', example: 2001 },
          message: { type: 'string', example: 'The request is not valid.' },
          details: { type: 'array', items: { $ref: '#/components/schemas/ErrorDetail' } },
        },
      },
      ErrorDetail: {
        type: 'object',
        required: ['location', 'field', 'issue'],
        additionalProperties: false,
        properties: {
          location: { type: 'string', enum: ['body', 'path', 'query', 'header', 'method', 'request'] },
          field: { type: 'string', nullable: true, description: 'Parameter or property name, or null.' },
          issue: { type: 'string' },
        },
      },
      StaffTokenRequest: {
        type: 'object',
        required: ['principalType', 'email', 'password'],
        additionalProperties: false,
        properties: {
          principalType: { type: 'string', enum: ['staff'] },
          email: { type: 'string', minLength: 1, maxLength: 254, example: 'reader@example.lk' },
          password: { type: 'string', minLength: 1, maxLength: 128, format: 'password' },
        },
      },
      DeviceTokenRequest: {
        type: 'object',
        required: ['principalType', 'meterId', 'deviceSecret'],
        additionalProperties: false,
        properties: {
          principalType: { type: 'string', enum: ['device'] },
          meterId: { type: 'string', minLength: 1, maxLength: 254, example: 'MTR-0001' },
          deviceSecret: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', format: 'password' },
        },
      },
      ProvisionerTokenRequest: {
        type: 'object',
        required: ['principalType', 'username', 'password'],
        additionalProperties: false,
        properties: {
          principalType: { type: 'string', enum: ['provisioner'] },
          username: { type: 'string', minLength: 1, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128, format: 'password' },
        },
      },
      TokenRequest: {
        oneOf: [
          { $ref: '#/components/schemas/StaffTokenRequest' },
          { $ref: '#/components/schemas/DeviceTokenRequest' },
          { $ref: '#/components/schemas/ProvisionerTokenRequest' },
        ],
        discriminator: {
          propertyName: 'principalType',
          mapping: {
            staff: '#/components/schemas/StaffTokenRequest',
            device: '#/components/schemas/DeviceTokenRequest',
            provisioner: '#/components/schemas/ProvisionerTokenRequest',
          },
        },
      },
      TokenResponse: {
        type: 'object',
        required: ['accessToken', 'tokenType', 'expiresIn'],
        additionalProperties: false,
        properties: {
          accessToken: { type: 'string', description: 'HS256 JWT.' },
          tokenType: { type: 'string', enum: ['Bearer'] },
          expiresIn: { type: 'integer', enum: [900, 3600], description: 'Lifetime in seconds.' },
        },
      },
      Province: {
        type: 'object',
        required: ['id', 'name'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Western' },
        },
      },
      ProvinceCollection: {
        type: 'object',
        required: ['count', 'next', 'previous', 'results'],
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Total visible to the caller, not just this page.' },
          next: { type: 'string', nullable: true, example: '/solar/v1.0/provinces?offset=50&limit=50' },
          previous: { type: 'string', nullable: true },
          results: { type: 'array', items: { $ref: '#/components/schemas/Province' } },
        },
      },
    },
    parameters: {
      offset: {
        name: 'offset',
        in: 'query',
        description: 'Results to skip.',
        schema: { type: 'integer', minimum: 0, default: 0 },
      },
      limit: {
        name: 'limit',
        in: 'query',
        description: 'Page size.',
        schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      provinceId: {
        name: 'province-id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      ifNoneMatch: {
        name: 'If-None-Match',
        in: 'header',
        description: 'ETag(s) from an earlier response; weak comparison; takes precedence over If-Modified-Since.',
        schema: { type: 'string' },
      },
      ifModifiedSince: {
        name: 'If-Modified-Since',
        in: 'header',
        description: 'Used only where the response sends Last-Modified.',
        schema: { type: 'string' },
      },
    },
    headers: {
      ETag: { description: 'Strong tag of the exact response body.', schema: { type: 'string' } },
      LastModified: { description: 'HTTP-date; omitted while the modification time is ahead of the clock.', schema: { type: 'string' } },
      CacheControl: { description: '`private, no-cache` on reads; `no-store` on tokens.', schema: { type: 'string' } },
      Vary: { description: '`Authorization`', schema: { type: 'string' } },
      RetryAfter: { description: 'Seconds until another request is allowed.', schema: { type: 'integer' } },
      RateLimit: { description: 'Remaining requests and reset time (IETF RateLimit header draft 7).', schema: { type: 'string' } },
      WWWAuthenticate: { description: 'Bearer challenge; `error="invalid_token"` when a token was sent.', schema: { type: 'string' } },
    },
    responses: {
      NotModified: {
        description: 'The representation matching the request validators has not changed. No body.',
        headers: {
          ETag: { $ref: '#/components/headers/ETag' },
          'Cache-Control': { $ref: '#/components/headers/CacheControl' },
          Vary: { $ref: '#/components/headers/Vary' },
        },
      },
      BadRequest: error('Invalid input: malformed JSON (1001), validation failure (2001), or another unreadable request (1002).'),
      Unauthorized: error('Missing (3002) or invalid, expired, or revoked (3003) bearer token.', {
        headers: { 'WWW-Authenticate': { $ref: '#/components/headers/WWWAuthenticate' } },
      }),
      Forbidden: error('The authenticated principal type may not use this operation (3004).'),
      NotFound: error('Missing, or outside the caller\'s jurisdiction (1005). Both give the same response.'),
      NotAcceptable: error('The Accept header does not allow application/json (1007).'),
      UnsupportedMediaType: error('The body is not application/json (1008), or uses an unsupported charset or content encoding (1004).'),
      PayloadTooLarge: error('The body is larger than 100 KB (1003).'),
      TooManyRequests: error('Rate limit exceeded (1009).', {
        headers: {
          'Retry-After': { $ref: '#/components/headers/RetryAfter' },
          RateLimit: { $ref: '#/components/headers/RateLimit' },
        },
      }),
      InternalError: error('Unexpected server failure (1000). No internal details are returned.'),
    },
  },
};

module.exports = swaggerJsdoc({
  definition,
  // Absolute, so the document does not depend on the directory the server was started from.
  // swagger-jsdoc's glob needs forward slashes, including on Windows.
  apis: [path.join(__dirname, '..', 'routes', '*.js').replace(/\\/g, '/')],
});
