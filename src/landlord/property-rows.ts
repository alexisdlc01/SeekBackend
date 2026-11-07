import { PaymentStatus } from "../payments/payment.enums";
import type { ComplianceSeverity } from "../tenancies/compliance";

export type PropertyRentStatus = "LATE" | "DUE" | "PAID" | "NOT_DUE" | "NOT_LET";

/**
 * One word for how a property's rent is doing this month, from the payments
 * due so far (or paid early): any late payment wins, then anything still to
 * collect, then paid. Nothing due yet (say a tenancy that has not started)
 * is NOT_DUE. A property with no tenancy has nothing to collect.
 */
export function propertyRentStatus(statuses: PaymentStatus[], isLet: boolean): PropertyRentStatus {
	if (!isLet) return "NOT_LET";
	if (statuses.includes(PaymentStatus.LATE)) return "LATE";
	if (statuses.length === 0) return "NOT_DUE";
	return statuses.every(status => status === PaymentStatus.PAID) ? "PAID" : "DUE";
}

export type PropertyComplianceStatus = "ACTION_NEEDED" | "DUE_SOON" | "OK";

/** Overdue or breached items need action now; anything else listed is coming up. */
export function propertyComplianceStatus(severities: ComplianceSeverity[]): PropertyComplianceStatus {
	if (severities.includes("high")) return "ACTION_NEEDED";
	return severities.length ? "DUE_SOON" : "OK";
}
