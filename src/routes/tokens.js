const express = require('express');
const { ERRORS, ApiError, detail } = require('../errors');
const { requireJsonBody } = require('../middleware/http');
const { methodNotAllowed } = require('../middleware/errors');
const { tokenRequestsPerClient, failedSignInsPerIdentifier } = require('../middleware/rateLimits');
const { authenticateCredentials } = require('../auth/credentials');
const { issueToken } = require('../auth/tokens');

const router = express.Router();

const MAX_IDENTIFIER_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;
const DEVICE_SECRET = /^[A-Za-z0-9_-]{43}$/;

// Fields for each principal type: [identifier field, secret field]. See docs/authentication.md.
const FIELDS = {
  staff: ['email', 'password'],
  device: ['meterId', 'deviceSecret'],
  provisioner: ['username', 'password'],
};

// Collects every problem so the client can fix them all at once.
function validateTokenRequest(req, res, next) {
  const body = req.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return next(new ApiError(ERRORS.VALIDATION_FAILED, {
      details: [detail('body', null, 'The body must be a JSON object.')],
    }));
  }

  const type = body.principalType;
  if (!Object.hasOwn(FIELDS, type)) {
    return next(new ApiError(ERRORS.VALIDATION_FAILED, {
      details: [detail('body', 'principalType', 'principalType must be staff, device, or provisioner.')],
    }));
  }

  const [idField, secretField] = FIELDS[type];
  const problems = [];
  for (const field of Object.keys(body)) {
    if (field !== 'principalType' && field !== idField && field !== secretField) {
      problems.push(detail('body', field, `Unknown field for principalType ${type}.`));
    }
  }

  const id = body[idField];
  if (typeof id !== 'string' || id.trim() === '' || id.length > MAX_IDENTIFIER_LENGTH) {
    problems.push(detail('body', idField, `${idField} must be a non-blank string of at most ${MAX_IDENTIFIER_LENGTH} characters.`));
  }

  const secret = body[secretField];
  if (secretField === 'deviceSecret') {
    if (typeof secret !== 'string' || !DEVICE_SECRET.test(secret)) {
      problems.push(detail('body', secretField, 'deviceSecret must be the 43-character secret issued for the device.'));
    }
  } else if (typeof secret !== 'string' || secret === '' || Array.from(secret).length > MAX_PASSWORD_LENGTH) {
    problems.push(detail('body', secretField, `${secretField} must be a non-empty string of at most ${MAX_PASSWORD_LENGTH} characters.`));
  }

  if (problems.length > 0) return next(new ApiError(ERRORS.VALIDATION_FAILED, { details: problems }));
  next();
}

async function issueTokenHandler(req, res) {
  const type = req.body.principalType;
  const [idField, secretField] = FIELDS[type];
  const principal = await authenticateCredentials(type, req.body[idField], req.body[secretField]);

  // One response for an unknown identifier, a missing credential, and a wrong secret.
  if (!principal) throw new ApiError(ERRORS.INVALID_CREDENTIALS);

  const { accessToken, expiresIn } = issueToken(principal);
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  res.json({ accessToken, tokenType: 'Bearer', expiresIn });
}

router
  .route('/issue-token')
  .post(tokenRequestsPerClient, requireJsonBody, validateTokenRequest, failedSignInsPerIdentifier, issueTokenHandler)
  .all(methodNotAllowed('POST'));

module.exports = router;
