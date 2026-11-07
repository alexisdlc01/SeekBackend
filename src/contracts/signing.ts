import { Types } from "mongoose";

/** A contract is signed once every tenant on the tenancy has signed it. */
export function allTenantsSigned(
	tenants: (Types.ObjectId | string)[],
	signatures: { user: Types.ObjectId | string }[]
): boolean {
	if (tenants.length === 0) return false;
	const signed = new Set(signatures.map(signature => signature.user.toString()));
	return tenants.every(tenant => signed.has(tenant.toString()));
}
