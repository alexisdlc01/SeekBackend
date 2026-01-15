import { FlagResolution } from "./flag-resolution";

export const FlagStatus = {
	UNDER_REVIEW: "UNDER_REVIEW",
	...FlagResolution
} as const;

export type FlagStatus = typeof FlagStatus;
