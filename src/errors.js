// Application error catalogue. Every error response has the body { code, message, details }:
// `code` is a stable application code, separate from the HTTP status, and `details` is a list
// of { location, field, issue } items (empty when there is nothing more to say).
// 1000-1099 are general request and routing errors; later features add their own ranges.
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
