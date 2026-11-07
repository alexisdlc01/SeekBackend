/**
 * Pipeline: NOT_SENT -> SENT -> VIEWED -> OFFERED -> ACCEPTED -> SIGNED.
 * REJECTED can follow any stage before ACCEPTED.
 */
export enum ApplicationStage {
	SENT = "SENT",
	NOT_SENT = "NOT_SENT",
	/** A viewing is booked or done. */
	VIEWED = "VIEWED",
	/** The landlord made an offer; the household has until `offerExpiresAt` to accept. */
	OFFERED = "OFFERED",
	ACCEPTED = "ACCEPTED",
	/** Every tenant has signed the tenancy agreement. */
	SIGNED = "SIGNED",
	REJECTED = "REJECTED"
}

/** Stages in which a landlord is still deciding, so the application is in their inbox. */
export const LANDLORD_OPEN_STAGES = [
	ApplicationStage.SENT,
	ApplicationStage.VIEWED,
	ApplicationStage.OFFERED
];
