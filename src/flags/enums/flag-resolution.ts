export const FlagResolution = {
	ACCOUNT_SUSPENDED: "ACCOUNT_SUSPENDED",
	NO_ACTION: "NO_ACTION"
} as const;

export type FlagResolution = typeof FlagResolution;
