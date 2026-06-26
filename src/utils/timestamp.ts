/**
 * Coerce a stored timestamp to a `Date`, tolerant of every representation that
 * has existed for `user_devices.last_active_at` / `created_at` across DB
 * backends and migrations:
 *   - epoch SECONDS  (legacy SQLite `INTEGER DEFAULT strftime('%s')` + trigger)
 *   - epoch MILLIS   (code-managed writes, `Date.now()`)
 *   - ISO / datetime strings (TypeORM date-column writes)
 *   - a `Date` already (MariaDB TIMESTAMP, or in-memory)
 *
 * Returns `null` for null/undefined/unparseable input.
 *
 * This is the read-boundary normalizer that keeps liveness + device-listing
 * working regardless of how a row was written — see ADR-0011 and the migration
 * `1748000000001-fix-user-device-liveness-timestamp` that drops the DB-side
 * auto-update so the application owns `last_active_at`.
 */
export function toDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (
    typeof value === 'number' ||
    (typeof value === 'string' && /^\d+$/.test(value))
  ) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    // Values below ~1e12 are epoch SECONDS (1e12 ms ≈ year 2001); scale to ms.
    return new Date(n < 1e12 ? n * 1000 : n);
  }
  const d = new Date(value as string);
  return isNaN(d.getTime()) ? null : d;
}
