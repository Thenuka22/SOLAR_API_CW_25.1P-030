// Jurisdiction scope for SQL queries, taken from the principal loaded by authenticate().
//
// readerScope() gives the parameters $1-$3 used by the conditions below:
//   $1 national?  $2 province the reader may read (their own, or their district's)
//   $3 the reader's district (district readers only, otherwise null)
function readerScope(principal) {
  return [principal.role === 'national', principal.provinceId ?? null, principal.districtId ?? null];
}

// The province row aliased p is visible.
const PROVINCE_VISIBLE = '($1 OR p.id = $2)';

// The district row aliased d is visible: every district for a national reader, the districts of
// their province for a provincial reader, and only their own district for a district reader.
const DISTRICT_VISIBLE = '($1 OR (d.province_id = $2 AND ($3::uuid IS NULL OR d.id = $3)))';

module.exports = { readerScope, PROVINCE_VISIBLE, DISTRICT_VISIBLE };
