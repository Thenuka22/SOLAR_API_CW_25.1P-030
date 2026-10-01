const crypto = require('crypto');

// Strong ETag from a hash of the exact JSON text sent. GET and PUT responses for the same
// representation therefore get the same tag.
function etagOf(json) {
  return `"${crypto.createHash('sha256').update(json).digest('base64url')}"`;
}

// HTTP-dates have whole-second precision.
function toSeconds(date) {
  return date ? Math.floor(date.getTime() / 1000) : null;
}

// Sends a JSON representation with validators, or 304 when the client's copy is current.
// Call it only after authentication, authorization, and the scoped query, so validators are
// computed from data the caller may see.
//
// - ETag: strong, from a hash of the exact response body. The body already reflects the
//   caller's scope, so callers who see different data get different tags.
// - Last-Modified: only when `lastModified` is a reliable modification time for the whole
//   representation (see docs/api-endpoints.md). Scoped collections pass none: their content
//   also changes with the caller's scope, deletions, and paging, which no row timestamp
//   records. Without it, If-Modified-Since is ignored (RFC 9110 section 13.1.3), so a 304 can
//   only come from a matching ETag.
// - Cache-Control "private, no-cache": only the caller's own cache may store it, and must
//   revalidate before reuse. Vary: Authorization because the body depends on the caller.
// - If-None-Match takes precedence: when present, If-Modified-Since is ignored.
function sendCacheableJson(req, res, body, { lastModified = null } = {}) {
  const json = JSON.stringify(body);
  const etag = etagOf(json);
  res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization' });

  const modifiedSeconds = toSeconds(lastModified);
  if (modifiedSeconds !== null) res.set('Last-Modified', new Date(modifiedSeconds * 1000).toUTCString());

  if (isNotModified(req, etag, modifiedSeconds)) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(json);
}

// A row's updated_at as Last-Modified, or null while it is later than `now` (the query's
// statement_timestamp()). Every change moves updated_at to a later second (migration 010), so
// after rapid changes it can be ahead of the clock; a Last-Modified in the future must not be
// sent (RFC 9110 section 8.8.2.1), and replacing it with the current time could repeat an
// earlier version's second, so it is omitted.
function lastModifiedFrom(updatedAt, now) {
  return updatedAt <= now ? updatedAt : null;
}

function isNotModified(req, etag, modifiedSeconds) {
  const ifNoneMatch = req.get('If-None-Match');
  if (ifNoneMatch !== undefined) {
    if (ifNoneMatch.trim() === '*') return true;
    // Weak comparison: W/"x" matches "x".
    const opaque = etag.replace(/^W\//, '');
    return ifNoneMatch.split(',').some((tag) => tag.trim().replace(/^W\//, '') === opaque);
  }

  const ifModifiedSince = req.get('If-Modified-Since');
  if (ifModifiedSince !== undefined && modifiedSeconds !== null) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since)) return modifiedSeconds <= Math.floor(since / 1000);
  }
  return false;
}

// Whether the If-Match and If-Unmodified-Since conditions of a write hold for the current
// representation `body` and its modification time `updatedAt` (RFC 9110 section 13.2.2).
// Call it inside the transaction that holds the row lock, so nothing changes between the check
// and the write.
// - If-Match uses strong comparison: a weak tag (W/"x") never matches. "*" matches any
//   current representation. When present, If-Unmodified-Since is ignored.
// - If-Unmodified-Since holds when the row has not changed after that second. An invalid date
//   is ignored.
function writePreconditionsHold(req, body, updatedAt) {
  const ifMatch = req.get('If-Match');
  if (ifMatch !== undefined) {
    if (ifMatch.trim() === '*') return true;
    const etag = etagOf(JSON.stringify(body));
    return ifMatch.split(',').some((tag) => tag.trim() === etag);
  }

  const ifUnmodifiedSince = req.get('If-Unmodified-Since');
  if (ifUnmodifiedSince !== undefined) {
    const since = Date.parse(ifUnmodifiedSince);
    if (!Number.isNaN(since)) return toSeconds(updatedAt) <= Math.floor(since / 1000);
  }
  return true;
}

// Validators for a representation returned by a successful write, matching what a GET would
// send for it.
function setWriteValidators(res, body, lastModified) {
  res.set('ETag', etagOf(JSON.stringify(body)));
  const modifiedSeconds = toSeconds(lastModified);
  if (modifiedSeconds !== null) res.set('Last-Modified', new Date(modifiedSeconds * 1000).toUTCString());
}

module.exports = { sendCacheableJson, lastModifiedFrom, writePreconditionsHold, setWriteValidators };
