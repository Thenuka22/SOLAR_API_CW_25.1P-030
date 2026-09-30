const { ERRORS, ApiError, detail } = require('../errors');

// 406 unless the Accept header allows a JSON response (a missing Accept allows anything).
function requireJsonAccept(req, res, next) {
  if (req.accepts('application/json')) return next();
  next(new ApiError(ERRORS.NOT_ACCEPTABLE, {
    details: [detail('header', 'Accept', 'Accept must allow application/json.')],
  }));
}

// A request has a body when it is chunked or declares a non-zero length (RFC 9112 section 6.3).
function hasBody(req) {
  return req.headers['transfer-encoding'] !== undefined
    || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
}

// 415 when a body is sent with another media type; 400 when the body is missing.
// express.json() has already parsed a JSON body into req.body.
function requireJsonBody(req, res, next) {
  if (!hasBody(req)) {
    return next(new ApiError(ERRORS.VALIDATION_FAILED, {
      details: [detail('body', null, 'A JSON request body is required.')],
    }));
  }
  if (!req.is('application/json')) {
    return next(new ApiError(ERRORS.UNSUPPORTED_MEDIA_TYPE, {
      details: [detail('header', 'Content-Type', 'Content-Type must be application/json.')],
    }));
  }
  next();
}

module.exports = { requireJsonAccept, requireJsonBody };
