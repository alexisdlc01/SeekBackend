/**
 * UK nation a property sits in. Housing law differs per nation (for example,
 * the Renters' Rights Act caps rent in advance at one month in England only),
 * so payment and compliance rules key off this value.
 */
export enum Nation {
	ENGLAND = "ENGLAND",
	WALES = "WALES",
	SCOTLAND = "SCOTLAND",
	NORTHERN_IRELAND = "NORTHERN_IRELAND"
}
