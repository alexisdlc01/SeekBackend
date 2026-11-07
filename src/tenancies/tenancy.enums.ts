export enum TenancyStatus {
	/** Created by hand by the landlord: waiting for every invited student to accept. */
	PENDING_ACCEPTANCE = "PENDING_ACCEPTANCE",
	ACTIVE = "ACTIVE",
	ENDED = "ENDED"
}

export enum DepositScheme {
	DPS = "DPS",
	TDS = "TDS",
	MYDEPOSITS = "MYDEPOSITS"
}

export enum TenancyDocumentType {
	TENANCY_AGREEMENT = "TENANCY_AGREEMENT",
	DEPOSIT_CERTIFICATE = "DEPOSIT_CERTIFICATE",
	GAS_SAFETY = "GAS_SAFETY",
	EPC = "EPC",
	EICR = "EICR",
	INVENTORY = "INVENTORY",
	COUNCIL_TAX_EXEMPTION = "COUNCIL_TAX_EXEMPTION",
	HOW_TO_RENT = "HOW_TO_RENT",
	OTHER = "OTHER"
}

/** Where a tenancy or contract file came from. */
export enum DocumentSource {
	EMAIL = "EMAIL",
	UPLOAD = "UPLOAD",
	SEEK = "SEEK"
}
