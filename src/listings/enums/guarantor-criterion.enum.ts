/** What a landlord asks of applicants who need a guarantor. */
export enum GuarantorCriterion {
	/** A guarantor living in the UK. */
	UK_ONLY = "UK_ONLY",
	/** A UK guarantor, or a guarantor service such as Housing Hand. */
	UK_OR_SERVICE = "UK_OR_SERVICE",
	/** No guarantor needed. */
	NONE = "NONE"
}
