const crypto = require('crypto');

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
  const etag = `"${crypto.createHash('sha256').update(json).digest('base64url')}"`;
  res.set({ ETag: etag, 'Cache-Control': 'private, no-cache', Vary: 'Authorization' });

  // HTTP-dates have whole-second precision.
  const modifiedSeconds = lastModified ? Math.floor(lastModified.getTime() / 1000) : null;
  if (modifiedSeconds !== null) res.set('Last-Modified', new Date(modifiedSeconds * 1000).toUTCString());

  if (isNotModified(req, etag, modifiedSeconds)) {
    res.status(304).end();
    return;
  }
  res.type('application/json').send(json);
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

module.exports = { sendCacheableJson };
