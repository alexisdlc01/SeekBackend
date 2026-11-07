/**
 * What a landlord's team member may help with. There is deliberately no
 * payouts scope: payouts, bank details and Stripe setup stay with the owner.
 */
export enum TeamScope {
	VIEWINGS_INBOX = "VIEWINGS_INBOX",
	APPLICATIONS = "APPLICATIONS",
	LISTINGS = "LISTINGS",
	REPAIRS = "REPAIRS",
	TENANCIES = "TENANCIES"
}
