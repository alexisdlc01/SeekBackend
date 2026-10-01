import { Transform } from "class-transformer";

function toIdString(value: unknown): unknown {
	if (value == null) return value;
	if (typeof (value as any).toHexString === "function") {
		return (value as any).toHexString();
	}
	if (typeof value === "object" && "_id" in (value as object)) {
		return toIdString((value as any)._id);
	}
	return value;
}

/**
 * Serialises an ObjectId field (or a populated document, via its `_id`) as a
 * hex string. Needed because class-transformer's default handling with
 * `excludeExtraneousValues` re-instantiates ObjectId values, producing a new
 * random id. Reads from `obj` rather than `value` for that same reason.
 */
export function ObjectIdString() {
	return Transform(({ obj, key }) => {
		const raw = obj?.[key];
		return Array.isArray(raw) ? raw.map(toIdString) : toIdString(raw);
	});
}
