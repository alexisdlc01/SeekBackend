import { Types } from "mongoose";

/** A contract is signed once every tenant on the tenancy has signed it. An invited housemate who has not accepted yet still has to sign. */
export function allTenantsSigned(
	tenancy: { tenants: (Types.ObjectId | string)[]; pendingTenants?: (Types.ObjectId | string)[] },
	signatures: { user: Types.ObjectId | string }[]
): boolean {
	if (tenancy.pendingTenants?.length) return false;
	const { tenants } = tenancy;
	if (tenants.length === 0) return false;
	const signed = new Set(signatures.map(signature => signature.user.toString()));
	return tenants.every(tenant => signed.has(tenant.toString()));
}

/** Tenants who still have to sign. */
export function unsignedTenants<T extends Types.ObjectId | string>(tenants: T[], signatures: { user: Types.ObjectId | string }[]): T[] {
	const signed = new Set(signatures.map(signature => signature.user.toString()));
	return tenants.filter(tenant => !signed.has(tenant.toString()));
}
