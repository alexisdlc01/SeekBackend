/**
 * S3 object keys are minted server-side as `<folder>/<ownerId>/<uuid>.<ext>`.
 *
 * The owner segment is what lets the upload and download paths agree on who a
 * private object belongs to without trusting anything the client sent. Keys
 * created before this format was introduced have no owner segment, so
 * `ownerIdFromKey` returns null for them and callers fall back to their
 * previous behaviour.
 */
const OWNED_KEY_PATTERN =
	/^(?:public|private)\/([0-9a-f]{24})\/[0-9a-f-]{36}\.[a-z0-9]{1,8}$/;

export function ownerIdFromKey(key: string): string | null {
	if (typeof key !== "string") return null;
	return OWNED_KEY_PATTERN.exec(key)?.[1] ?? null;
}

export function isKeyOwnedBy(key: string, userId: string): boolean {
	const owner = ownerIdFromKey(key);
	return owner !== null && owner === userId;
}
