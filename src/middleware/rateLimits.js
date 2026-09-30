const { rateLimit } = require('express-rate-limit');
const { ERRORS, ApiError, detail } = require('../errors');

const WINDOW_MS = 15 * 60 * 1000;

function tooManyRequests(req, res, next) {
  // express-rate-limit has already set Retry-After and the RateLimit headers.
  next(new ApiError(ERRORS.TOO_MANY_REQUESTS, {
    details: [detail('request', null, `Retry after ${res.get('Retry-After')} seconds.`)],
  }));
}

// Counts are kept in memory, which suits the single Render instance. Several instances would
// need a shared store.
const shared = {
  windowMs: WINDOW_MS,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: tooManyRequests,
};

// Every token request from one client address, whatever the outcome.
const tokenRequestsPerClient = rateLimit({ ...shared, limit: 30 });

// Failed sign-ins for one identifier from any address, so guessing one account's secret from
// many addresses is still limited. Successful sign-ins are not counted. Runs after validation,
// which guarantees principalType and its identifier field.
const IDENTIFIER_FIELDS = { staff: 'email', device: 'meterId', provisioner: 'username' };
const failedSignInsPerIdentifier = rateLimit({
  ...shared,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    const { principalType } = req.body;
    const identifier = req.body[IDENTIFIER_FIELDS[principalType]];
    return `${principalType}:${identifier.trim().toLowerCase()}`;
  },
});

module.exports = { tokenRequestsPerClient, failedSignInsPerIdentifier };
