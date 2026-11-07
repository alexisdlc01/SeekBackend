import { DocumentType } from "../users/types/document-type";
import { GuarantorCriterion } from "../listings/enums/guarantor-criterion.enum";

/** A document an applicant must have in their Seek Passport before applying. */
export interface RequiredDocument {
	label: string;
	/** Any one of these types satisfies it (Seek Passport aliases included). */
	types: DocumentType[];
}

const REQUIRED_DOCUMENT_RULES: {
	type: DocumentType;
	/** Seek Passport types that satisfy the same requirement. */
	aliases?: DocumentType[];
	label: string;
	pattern: RegExp;
}[] = [
	{
		type: DocumentType.IDENTIFICATION,
		aliases: [DocumentType.PASSPORT],
		label: "Identification",
		pattern: /identification|passport|national id/i,
	},
	{
		type: DocumentType.PROOF_OF_INCOME,
		aliases: [DocumentType.PROOF_OF_FUNDS],
		label: "Proof of income",
		pattern: /proof of income|financial support|student loan|scholarship|savings/i,
	},
	{
		type: DocumentType.GUARANTOR_AGREEMENT,
		label: "Guarantor agreement",
		pattern: /guarantor/i,
	},
	{
		type: DocumentType.LANDLORD_REFERENCE,
		label: "Landlord reference",
		pattern: /landlord reference|accommodation (letter|reference)/i,
	},
	{
		type: DocumentType.CHARACTER_REFERENCE,
		aliases: [DocumentType.RECOMMENDATION],
		label: "Character reference",
		pattern: /character reference/i,
	},
];

export interface RequiredDocumentsSource {
	requirements?: { name: string; desc: string; required: boolean }[] | null;
	criteria?: { guarantor?: GuarantorCriterion } | null;
}

/**
 * Documents needed to apply, from the listing's required items. The criteria
 * are the landlord's structured answer, so "No guarantor needed" wins over a
 * guarantor line left in the free-text requirements.
 */
export function requiredDocuments(listing: RequiredDocumentsSource): RequiredDocument[] {
	const requirements = (listing.requirements ?? []).filter(requirement => requirement.required);
	return REQUIRED_DOCUMENT_RULES
		.filter(rule => requirements.some(requirement => rule.pattern.test(`${requirement.name ?? ""} ${requirement.desc ?? ""}`)))
		.filter(rule => !(rule.type === DocumentType.GUARANTOR_AGREEMENT && listing.criteria?.guarantor === GuarantorCriterion.NONE))
		.map(rule => ({ label: rule.label, types: [rule.type, ...(rule.aliases ?? [])] }));
}

/** Labels of the required documents none of whose types the applicant has uploaded. */
export function missingDocuments(listing: RequiredDocumentsSource, uploaded: DocumentType[]): string[] {
	const have = new Set(uploaded);
	return requiredDocuments(listing)
		.filter(document => !document.types.some(type => have.has(type)))
		.map(document => document.label);
}
