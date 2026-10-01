// Application error catalogue. Every error response has the body { code, message, details }:
// `code` is a stable application code, separate from the HTTP status, and `details` is a list
// of { location, field, issue } items (empty when there is nothing more to say).
// 1000-1099 are general request and routing errors, 2000-2099 input validation,
// 3000-3099 authentication and authorization, and 4000-4099 conflicts with stored data.
const ERRORS = {
  INTERNAL_ERROR: { code: 1000, status: 500, message: 'An unexpected error occurred.' },
  MALFORMED_JSON: { code: 1001, status: 400, message: 'The request body is not valid JSON.' },
  INVALID_REQUEST: { code: 1002, status: 400, message: 'The request could not be read.' },
  BODY_TOO_LARGE: { code: 1003, status: 413, message: 'The request body is too large.' },
  UNSUPPORTED_BODY_ENCODING: {
    code: 1004,
    status: 415,
    message: 'The request body uses an unsupported character set or content encoding.',
  },
  RESOURCE_NOT_FOUND: { code: 1005, status: 404, message: 'The requested resource was not found.' },
  METHOD_NOT_ALLOWED: { code: 1006, status: 405, message: 'The method is not allowed for this resource.' },
  NOT_ACCEPTABLE: { code: 1007, status: 406, message: 'The API can only respond with application/json.' },
  UNSUPPORTED_MEDIA_TYPE: { code: 1008, status: 415, message: 'The request body must be application/json.' },
  TOO_MANY_REQUESTS: { code: 1009, status: 429, message: 'Too many requests. Try again later.' },
  PRECONDITION_FAILED: { code: 1010, status: 412, message: 'The resource has changed since the version named in the request conditions.' },
  VALIDATION_FAILED: { code: 2001, status: 400, message: 'The request is not valid.' },
  // 400, not 401: the token endpoint takes credentials in the JSON body, and no WWW-Authenticate
  // challenge describes that (RFC 9110 section 11.6.1). OAuth 2.0 uses 400 invalid_grant for the
  // same case (RFC 6749 section 5.2).
  INVALID_CREDENTIALS: { code: 3001, status: 400, message: 'The credentials are not valid.' },
  AUTHENTICATION_REQUIRED: { code: 3002, status: 401, message: 'A bearer token is required.' },
  INVALID_TOKEN: { code: 3003, status: 401, message: 'The bearer token is not valid.' },
  FORBIDDEN: { code: 3004, status: 403, message: 'You do not have permission for this operation.' },
  METER_ID_TAKEN: { code: 4001, status: 409, message: 'Another installation already has this meter ID.' },
  READING_EXISTS: { code: 4002, status: 409, message: 'The installation already has a reading at this timestamp.' },
  INSTALLATION_HAS_READINGS: { code: 4003, status: 409, message: 'The installation has readings, so this change would alter its history.' },
};

class ApiError extends Error {
  // `error` is an ERRORS entry; `message` replaces its default text.
  constructor(error, { message = error.message, details = [], headers = {} } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = error.status;
    this.code = error.code;
    this.details = details;
    this.headers = headers;
  }
}

// location: where the problem is (body, path, query, header, method).
// field: the parameter or property name, or null when the problem is not about one field.
function detail(location, field, issue) {
  return { location, field, issue };
}

module.exports = { ERRORS, ApiError, detail };
