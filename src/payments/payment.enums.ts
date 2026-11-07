export enum PlanFrequency {
	MONTHLY = "MONTHLY",
	SIX_MONTHS = "SIX_MONTHS",
	YEARLY = "YEARLY"
}

export enum PaymentStatus {
	SCHEDULED = "SCHEDULED",
	PENDING = "PENDING",
	PAID = "PAID",
	FAILED = "FAILED",
	LATE = "LATE"
}

/** What a payment is for. */
export enum PaymentKind {
	RENT = "RENT",
	/** Paid when a landlord makes an offer; capped at one week's rent. */
	HOLDING_DEPOSIT = "HOLDING_DEPOSIT"
}

export enum PaymentProvider {
	STRIPE = "stripe",
	SIMULATED = "simulated"
}

/**
 * Where a card payment's money is when the landlord had no payout account
 * ready: Seek holds it, then transfers it (minus Seek's fee) once they do.
 */
export enum PayoutStatus {
	HELD = "HELD",
	TRANSFERRED = "TRANSFERRED"
}
