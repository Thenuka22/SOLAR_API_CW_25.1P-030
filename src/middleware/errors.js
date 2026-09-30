const { ERRORS, ApiError, detail } = require('../errors');

// Error types set by Express's JSON body parser (body-parser).
const BODY_PARSER_ERRORS = new Map([
  ['entity.parse.failed', ERRORS.MALFORMED_JSON],
  ['entity.too.large', ERRORS.BODY_TOO_LARGE],
  ['charset.unsupported', ERRORS.UNSUPPORTED_BODY_ENCODING],
  ['encoding.unsupported', ERRORS.UNSUPPORTED_BODY_ENCODING],
]);

// Last route: nothing matched the path.
function notFound(req, res, next) {
  next(new ApiError(ERRORS.RESOURCE_NOT_FOUND, {
    details: [detail('path', null, `No endpoint matches ${req.path}.`)],
  }));
}

// Use with app.route(path).all(...) after the supported methods.
function methodNotAllowed(...allowed) {
  const allow = allowed.join(', ');
  return (req, res, next) => {
    next(new ApiError(ERRORS.METHOD_NOT_ALLOWED, {
      details: [detail('method', null, `${req.method} is not supported here. Allowed: ${allow}.`)],
      headers: { Allow: allow },
    }));
  };
}

// Convert anything that is not already an ApiError. Unknown errors become a generic 500 so
// stack traces, SQL, and credentials never reach the client.
function toApiError(err) {
  if (err instanceof ApiError) return err;

  const parserError = BODY_PARSER_ERRORS.get(err?.type);
  if (parserError === ERRORS.BODY_TOO_LARGE) {
    return new ApiError(parserError, {
      details: [detail('body', null, `The body must not exceed ${err.limit} bytes.`)],
    });
  }
  if (parserError) {
    return new ApiError(parserError, { details: [detail('body', null, err.message)] });
  }

  // Other client errors raised by Express or its middleware. The router marks a badly
  // encoded path parameter as a URIError with status 400 but does not set `expose`.
  if (err?.status === 400 && (err.expose || err instanceof URIError)) {
    return new ApiError(ERRORS.INVALID_REQUEST, { details: [detail('request', null, err.message)] });
  }

  return new ApiError(ERRORS.INTERNAL_ERROR);
}

// Express recognises an error handler by its four parameters.
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const apiError = toApiError(err);
  if (apiError.status >= 500) console.error(err);

  res.status(apiError.status).set(apiError.headers).json({
    code: apiError.code,
    message: apiError.message,
    details: apiError.details,
  });
}

module.exports = { notFound, methodNotAllowed, errorHandler };
