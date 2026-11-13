export enum DocumentType {
	IDENTIFICATION = "IDENTIFICATION",
	PROOF_OF_INCOME = "PROOF_OF_INCOME",
	GUARANTOR_AGREEMENT = "GUARANTOR_AGREEMENT",
	LANDLORD_REFERENCE = "LANDLORD_REFERENCE",
	CHARACTER_REFERENCE = "CHARACTER_REFERENCE",
	PASSPORT = "PASSPORT",
	VISA = "VISA",
	RIGHT_TO_RENT = "RIGHT_TO_RENT",
	STUDENT_STATUS = "STUDENT_STATUS",
	CAS_LETTER = "CAS_LETTER",
	PROOF_OF_FUNDS = "PROOF_OF_FUNDS",
	AGENT_REFERENCE = "AGENT_REFERENCE",
	RECOMMENDATION = "RECOMMENDATION"
}

export enum DocumentStatus {
	PENDING = "PENDING",
	VERIFIED = "VERIFIED",
	EXPIRED = "EXPIRED",
	REJECTED = "REJECTED",
	/** Identity documents: Seek does not check them; the landlord does through the document share. */
	PROVIDED = "PROVIDED"
}

/** Never verified by Seek nor sent to an AI: PROVIDED on upload and enough for readiness. */
export const IDENTITY_DOCUMENT_TYPES: readonly DocumentType[] = [
	DocumentType.PASSPORT,
	DocumentType.IDENTIFICATION,
	DocumentType.VISA,
	DocumentType.RIGHT_TO_RENT
];
