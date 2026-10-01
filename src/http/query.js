const { ERRORS, ApiError, detail } = require('../errors');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]{0,8})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rejects query parameters outside `allowed` (400). A repeated parameter arrives as an array
// and fails the value checks.
function checkQueryNames(req, allowed) {
  const problems = Object.keys(req.query)
    .filter((name) => !allowed.includes(name))
    .map((name) => detail('query', name, 'Unsupported query parameter.'));
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
}

// offset (default 0) and limit (default 50, 1-200) for collections.
function parsePage(req, allowed = ['offset', 'limit']) {
  checkQueryNames(req, allowed);
  const problems = [];
  const read = (name, fallback, min, max) => {
    const raw = req.query[name];
    if (raw === undefined) return fallback;
    const value = typeof raw === 'string' && NON_NEGATIVE_INTEGER.test(raw) ? Number(raw) : NaN;
    if (!(value >= min && value <= max)) {
      problems.push(detail('query', name, `${name} must be an integer from ${min} to ${max}.`));
    }
    return value;
  };
  const offset = read('offset', 0, 0, Number.MAX_SAFE_INTEGER);
  const limit = read('limit', DEFAULT_LIMIT, 1, MAX_LIMIT);
  if (problems.length > 0) throw new ApiError(ERRORS.VALIDATION_FAILED, { details: problems });
  return { offset, limit };
}

// next/previous as path-absolute links that keep the page size and any filters and sorting in
// `kept` (query name -> value as sent); null when there is no page.
function pageLinks(req, { offset, limit }, count, kept = {}) {
  const path = `${req.baseUrl}${req.path}`;
  const link = (o) => {
    const query = new URLSearchParams(Object.entries(kept).filter(([, value]) => value !== undefined));
    query.set('offset', o);
    query.set('limit', limit);
    return `${path}?${query}`;
  };
  return {
    next: offset + limit < count ? link(offset + limit) : null,
    previous: offset > 0 ? link(Math.max(0, Math.min(offset, count) - limit)) : null,
  };
}

// 400 unless the path parameter is a UUID. `name` is the documented parameter name.
function requireUuid(value, name) {
  if (!UUID.test(value)) {
    throw new ApiError(ERRORS.VALIDATION_FAILED, { details: [detail('path', name, `${name} must be a UUID.`)] });
  }
  return value.toLowerCase();
}

module.exports = { checkQueryNames, parsePage, pageLinks, requireUuid };
