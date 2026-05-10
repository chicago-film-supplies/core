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
