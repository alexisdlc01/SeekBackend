/** Outcome of the automatic listing check that replaced the admin approval queue. */
export enum ModerationStatus {
	APPROVED = "APPROVED",
	/** A rule or the AI check failed: moderationReasons says what the landlord must fix. */
	NEEDS_CHANGES = "NEEDS_CHANGES",
	/** The AI check could not run (provider down or quota): the sweeper retries it. */
	PENDING = "PENDING"
}
