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

// Shared by Reading and the nullable lastKnownReading in InstallationOverview.
const reading = {
  type: 'object',
  required: ['id', 'installationId', 'timestamp', 'powerKw', 'energyKwh', 'voltage'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', format: 'uuid' },
    installationId: { type: 'string', format: 'uuid' },
    timestamp: { type: 'string', format: 'date-time', description: 'Measurement time in UTC.', example: '2026-09-01T06:30:00.000Z' },
    powerKw: { type: 'number', minimum: 0, description: 'Instantaneous power in kW.', example: 3.214 },
    energyKwh: { type: 'number', minimum: 0, description: 'Cumulative energy in kWh.', example: 1520.75 },
    voltage: { type: 'number', minimum: 0, description: 'Voltage in V.', example: 231.4 },
  },
};

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
    { name: 'Districts', description: 'Staff readers only; results are limited to the reader\'s jurisdiction.' },
    { name: 'Grid substations', description: 'Staff readers within their jurisdiction; provisioners may read an individual substation.' },
    { name: 'Installations', description: 'Installation metadata. Staff readers within their jurisdiction; provisioners for any installation.' },
    { name: 'Readings', description: 'Append-only generation readings. Devices submit their own; staff readers read within their jurisdiction.' },
    { name: 'Summaries', description: 'Processing functions computed across many installations. Staff readers within their jurisdiction.' },
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
      District: {
        type: 'object',
        required: ['id', 'provinceId', 'name'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          provinceId: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Colombo' },
        },
      },
      DistrictCollection: {
        type: 'object',
        required: ['count', 'next', 'previous', 'results'],
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Total visible to the caller, not just this page.' },
          next: { type: 'string', nullable: true, example: '/solar/v1.0/provinces/{province-id}/districts?offset=50&limit=50' },
          previous: { type: 'string', nullable: true },
          results: { type: 'array', items: { $ref: '#/components/schemas/District' } },
        },
      },
      GridSubstation: {
        type: 'object',
        required: ['id', 'districtId', 'name'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          districtId: { type: 'string', format: 'uuid' },
          name: { type: 'string', example: 'Kolonnawa' },
        },
      },
      GridSubstationCollection: {
        type: 'object',
        required: ['count', 'next', 'previous', 'results'],
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Total visible to the caller, not just this page.' },
          next: { type: 'string', nullable: true, example: '/solar/v1.0/districts/{district-id}/grid-substations?offset=50&limit=50' },
          previous: { type: 'string', nullable: true },
          results: { type: 'array', items: { $ref: '#/components/schemas/GridSubstation' } },
        },
      },
      Installation: {
        type: 'object',
        required: ['id', 'substationId', 'meterId', 'address', 'capacityKw'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', format: 'uuid' },
          substationId: { type: 'string', format: 'uuid' },
          meterId: { type: 'string', example: 'MTR-0001' },
          address: { type: 'string', nullable: true, example: 'No. 14, Temple Road, Kolonnawa' },
          capacityKw: { type: 'number', minimum: 0.001, description: 'Rated capacity in kW, greater than 0, at most 3 decimal places.', example: 5.5 },
        },
      },
      InstallationCreate: {
        type: 'object',
        required: ['meterId', 'capacityKw'],
        additionalProperties: false,
        properties: {
          meterId: { type: 'string', minLength: 1, maxLength: 254, example: 'MTR-0201' },
          address: { type: 'string', nullable: true, minLength: 1, description: 'Optional; omitted means null.', example: 'No. 7, Lake Road, Kolonnawa' },
          capacityKw: { type: 'number', minimum: 0.001, maximum: 9999999.999, description: 'Rated capacity in kW, greater than 0, at most 3 decimal places.', example: 5.5 },
        },
      },
      Reading: reading,
      InstallationOverview: {
        type: 'object',
        required: ['installation', 'gridSubstation', 'district', 'province', 'lastKnownReading'],
        additionalProperties: false,
        properties: {
          installation: { $ref: '#/components/schemas/Installation' },
          gridSubstation: { $ref: '#/components/schemas/GridSubstation' },
          district: { $ref: '#/components/schemas/District' },
          province: { $ref: '#/components/schemas/Province' },
          // OpenAPI 3.0 applies nullable only beside an explicit type, so a $ref cannot be made
          // nullable; this is the Reading schema with null allowed.
          lastKnownReading: { ...reading, nullable: true, description: 'The latest reading, or null when there are none.' },
        },
      },
      ReadingCollection: {
        type: 'object',
        required: ['count', 'next', 'previous', 'results'],
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Total matching readings visible to the caller, not just this page.' },
          next: { type: 'string', nullable: true, example: '/solar/v1.0/installations/{installation-id}/readings?sort=-timestamp&offset=50&limit=50' },
          previous: { type: 'string', nullable: true },
          results: { type: 'array', items: { $ref: '#/components/schemas/Reading' } },
        },
      },
      ReadingCreate: {
        type: 'object',
        required: ['timestamp', 'powerKw', 'energyKwh', 'voltage'],
        additionalProperties: false,
        properties: {
          timestamp: {
            type: 'string',
            format: 'date-time',
            description: 'RFC 3339 with a timezone offset (Z or +hh:mm); at most millisecond precision.',
            example: '2026-09-08T12:00:00+05:30',
          },
          powerKw: { type: 'number', minimum: 0, maximum: 9999999.999, description: 'kW, at most 3 decimal places.', example: 3.214 },
          energyKwh: { type: 'number', minimum: 0, maximum: 99999999999.999, description: 'Cumulative kWh, at most 3 decimal places.', example: 1520.75 },
          voltage: { type: 'number', minimum: 0, maximum: 99999.99, description: 'V, at most 2 decimal places.', example: 231.4 },
        },
      },
      InstallationReplace: {
        type: 'object',
        required: ['substationId', 'meterId', 'capacityKw'],
        additionalProperties: false,
        description: 'The complete writable metadata. An omitted address is stored as null.',
        properties: {
          substationId: { type: 'string', format: 'uuid' },
          meterId: { type: 'string', minLength: 1, maxLength: 254, example: 'MTR-0201' },
          address: { type: 'string', nullable: true, minLength: 1, example: 'No. 7, Lake Road, Kolonnawa' },
          capacityKw: { type: 'number', minimum: 0.001, maximum: 9999999.999, description: 'Rated capacity in kW, greater than 0, at most 3 decimal places.', example: 6.6 },
        },
      },
      InstallationDeletion: {
        type: 'object',
        required: ['id', 'meterId', 'deletedAt'],
        additionalProperties: false,
        description: 'A receipt for a completed deletion. The installation itself no longer exists.',
        properties: {
          id: { type: 'string', format: 'uuid' },
          meterId: { type: 'string', example: 'MTR-0201' },
          deletedAt: { type: 'string', format: 'date-time', description: 'UTC, with milliseconds.', example: '2026-10-01T09:30:00.000Z' },
        },
      },
      DistrictSummaryRequest: {
        type: 'object',
        required: ['districtId'],
        additionalProperties: false,
        properties: {
          districtId: { type: 'string', format: 'uuid' },
          date: { type: 'string', format: 'date', description: 'A day in Asia/Colombo, not in the future. Defaults to today.', example: '2026-09-06' },
        },
      },
      DistrictGenerationSummary: {
        type: 'object',
        required: ['districtId', 'date', 'timeZone', 'installations', 'power', 'energy'],
        additionalProperties: false,
        properties: {
          districtId: { type: 'string', format: 'uuid' },
          date: { type: 'string', format: 'date', example: '2026-09-06' },
          timeZone: { type: 'string', enum: ['Asia/Colombo'] },
          installations: { type: 'integer', minimum: 0, description: 'Installations in the district.' },
          power: {
            type: 'object',
            required: ['totalKw', 'reportingInstallations', 'staleInstallations', 'latestReadingAt'],
            additionalProperties: false,
            description: 'Current power, whatever date was asked for.',
            properties: {
              totalKw: { type: 'number', nullable: true, minimum: 0, description: 'Sum of fresh latest readings; null when none is fresh.', example: 41.875 },
              reportingInstallations: { type: 'integer', minimum: 0, description: 'Latest reading at most 30 minutes old.' },
              staleInstallations: { type: 'integer', minimum: 0, description: 'Latest reading older than 30 minutes; not in the total.' },
              latestReadingAt: { type: 'string', format: 'date-time', nullable: true, description: 'The newest reading in the total. Not a common measurement time.' },
            },
          },
          energy: {
            type: 'object',
            required: [
              'complete', 'completeKwh', 'partialKwh', 'completeInstallations', 'partialInstallations',
              'missingInstallations', 'anomalousInstallations', 'earliestPartialSampleAt', 'latestPartialSampleAt',
            ],
            additionalProperties: false,
            description: 'Energy generated on the date, from differences of cumulative meter values.',
            properties: {
              complete: { type: 'boolean', description: 'True only when every installation of a non-empty district is complete.' },
              completeKwh: { type: 'number', nullable: true, minimum: 0, description: 'Total for installations with samples at both midnights; null when there are none.', example: 312.48 },
              partialKwh: { type: 'number', nullable: true, minimum: 0, description: 'Total for installations with no closing sample, each up to its latest sample; null when there are none.' },
              completeInstallations: { type: 'integer', minimum: 0 },
              partialInstallations: { type: 'integer', minimum: 0 },
              missingInstallations: { type: 'integer', minimum: 0, description: 'No sample at the opening midnight.' },
              anomalousInstallations: { type: 'integer', minimum: 0, description: 'The cumulative value decreased during the day.' },
              earliestPartialSampleAt: { type: 'string', format: 'date-time', nullable: true },
              latestPartialSampleAt: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
      InstallationCollection: {
        type: 'object',
        required: ['count', 'next', 'previous', 'results'],
        additionalProperties: false,
        properties: {
          count: { type: 'integer', minimum: 0, description: 'Total visible to the caller, not just this page.' },
          next: { type: 'string', nullable: true, example: '/solar/v1.0/grid-substations/{substation-id}/installations?offset=50&limit=50' },
          previous: { type: 'string', nullable: true },
          results: { type: 'array', items: { $ref: '#/components/schemas/Installation' } },
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
      districtId: {
        name: 'district-id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      substationId: {
        name: 'substation-id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      installationId: {
        name: 'installation-id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      readingId: {
        name: 'reading-id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      from: {
        name: 'from',
        in: 'query',
        description: 'Inclusive start: RFC 3339 date-time with a timezone offset. Send `+` as `%2B`.',
        schema: { type: 'string', format: 'date-time' },
        example: '2026-09-01T00:00:00+05:30',
      },
      to: {
        name: 'to',
        in: 'query',
        description: 'Exclusive end: RFC 3339 date-time with a timezone offset, later than `from`.',
        schema: { type: 'string', format: 'date-time' },
        example: '2026-09-02T00:00:00+05:30',
      },
      sort: {
        name: 'sort',
        in: 'query',
        description: 'Measurement timestamp ascending (`timestamp`) or descending (`-timestamp`); ties broken by ID.',
        schema: { type: 'string', enum: ['timestamp', '-timestamp'], default: 'timestamp' },
      },
      provinceFilter: {
        name: 'province-id',
        in: 'query',
        description: 'Only readings of installations in this province. Outside the jurisdiction it matches nothing.',
        schema: { type: 'string', format: 'uuid' },
      },
      districtFilter: {
        name: 'district-id',
        in: 'query',
        description: 'Only readings of installations in this district. Outside the jurisdiction it matches nothing.',
        schema: { type: 'string', format: 'uuid' },
      },
      substationFilter: {
        name: 'substation-id',
        in: 'query',
        description: 'Only readings of installations at this substation. Outside the jurisdiction it matches nothing.',
        schema: { type: 'string', format: 'uuid' },
      },
      ifNoneMatch: {
        name: 'If-None-Match',
        in: 'header',
        description: 'ETag(s) from an earlier response; weak comparison; takes precedence over If-Modified-Since.',
        schema: { type: 'string' },
      },
      ifMatch: {
        name: 'If-Match',
        in: 'header',
        description: 'ETag(s) of the version the change is based on, or `*`; strong comparison; takes precedence over If-Unmodified-Since.',
        schema: { type: 'string' },
      },
      ifUnmodifiedSince: {
        name: 'If-Unmodified-Since',
        in: 'header',
        description: 'HTTP-date, normally the Last-Modified of the version the change is based on. Ignored when If-Match is sent.',
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
      CacheControl: { description: '`private, no-cache` on reads; `no-store` on tokens and deletion receipts.', schema: { type: 'string' } },
      Vary: { description: '`Authorization`', schema: { type: 'string' } },
      Location: { description: 'Path-absolute URL of the created resource.', schema: { type: 'string' } },
      ContentLocation: { description: 'Same URL as Location: the body is the created resource as a GET of it returns.', schema: { type: 'string' } },
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
      Conflict: error('The request conflicts with stored data: a meter ID that is already registered (4001), a reading that already exists for the installation and instant (4002), or a move or deletion of an installation whose readings must keep their history (4003).'),
      NotAcceptable: error('The Accept header does not allow application/json (1007).'),
      UnsupportedMediaType: error('The body is not application/json (1008), or uses an unsupported charset or content encoding (1004).'),
      PreconditionFailed: error('If-Match or If-Unmodified-Since does not hold for the current version (1010). Nothing was changed.'),
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
