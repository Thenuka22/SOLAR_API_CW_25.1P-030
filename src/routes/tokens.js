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

  const { accessToken, expiresIn, scope } = issueToken(principal);
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });
  res.json({ accessToken, tokenType: 'Bearer', expiresIn, scope });
}

/**
 * @openapi
 * /solar/v1.0/issue-token:
 *   post:
 *     tags: [Authentication]
 *     summary: Issue an access token
 *     description: |
 *       Exchanges a principal's credentials for a bearer token. `principalType` selects which
 *       fields are required; any other field is rejected. Identifiers are matched ignoring case
 *       and surrounding spaces.
 *
 *       A wrong secret, an unknown identifier, and a principal without a credential all get the
 *       same 400 response (code 3001), with no `WWW-Authenticate` challenge because the
 *       credentials are sent in the body.
 *
 *       Rate limits: 30 requests per client address and 5 failed sign-ins per identifier, each
 *       per 15 minutes.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/TokenRequest'
 *           examples:
 *             staff:
 *               summary: Staff reader (email and password)
 *               value: { principalType: staff, email: national.reader@slsea.example, password: a long staff password }
 *             device:
 *               summary: Metering device (meter ID and issued secret)
 *               value: { principalType: device, meterId: MTR-0001, deviceSecret: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA }
 *             provisioner:
 *               summary: Provisioner (username and password)
 *               value: { principalType: provisioner, username: provisioner, password: a long provisioner password }
 *     responses:
 *       200:
 *         description: Token issued.
 *         headers:
 *           Cache-Control:
 *             description: '`no-store`'
 *             schema: { type: string }
 *           Pragma:
 *             description: '`no-cache`'
 *             schema: { type: string }
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/TokenResponse'
 *       400:
 *         description: Invalid input (1001, 2001), or credentials that are not valid (3001).
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *             examples:
 *               invalidCredentials:
 *                 summary: Wrong password, unknown identifier, or no credential (3001)
 *                 value: { code: 3001, message: The credentials are not valid., details: [] }
 *               missingField:
 *                 summary: Required field missing (2001)
 *                 value:
 *                   code: 2001
 *                   message: The request is not valid.
 *                   details:
 *                     - { location: body, field: password, issue: password must be a non-empty string of at most 128 characters. }
 *               unknownType:
 *                 summary: Unknown principalType (2001)
 *                 value:
 *                   code: 2001
 *                   message: The request is not valid.
 *                   details:
 *                     - { location: body, field: principalType, issue: 'principalType must be staff, device, or provisioner.' }
 *       406:
 *         $ref: '#/components/responses/NotAcceptable'
 *       413:
 *         $ref: '#/components/responses/PayloadTooLarge'
 *       415:
 *         $ref: '#/components/responses/UnsupportedMediaType'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       500:
 *         $ref: '#/components/responses/InternalError'
 */
router
  .route('/issue-token')
  .post(tokenRequestsPerClient, requireJsonBody, validateTokenRequest, failedSignInsPerIdentifier, issueTokenHandler)
  .all(methodNotAllowed('POST'));

module.exports = router;
