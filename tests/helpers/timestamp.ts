/**
 * Structural mock of firebase-admin/firestore Timestamp — schemas-next
 * has zero firebase-admin deps, so we shape-conform to FirestoreTimestamp's
 * runtime check (`{ seconds: number, nanoseconds: number }`) without
 * importing the real class.
 */
export const mockTimestamp = {
  seconds: 0,
  nanoseconds: 0,
  toMillis: () => 0,
  toDate: () => new Date(0),
};

/**
 * A structural Timestamp pinned to a real instant — the `_fs` twin of an ISO
 * bound. `mockTimestamp` is frozen at the epoch, which is fine for a schema
 * shape check but useless for interval arithmetic (every bound would collide at
 * 0), so anything exercising `computeAvailability` needs this instead.
 */
export function tsAt(iso: string): {
  seconds: number;
  nanoseconds: number;
  toMillis: () => number;
  toDate: () => Date;
} {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error("tsAt: unparseable ISO string: " + iso);
  return {
    seconds: Math.floor(ms / 1000),
    nanoseconds: (ms % 1000) * 1e6,
    toMillis: () => ms,
    toDate: () => new Date(ms),
  };
}
