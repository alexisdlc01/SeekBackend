import { DocumentStatus, DocumentType } from "./types/document-type";

/** A passport item that has never been uploaded. */
export const MISSING = "MISSING" as const;
export type PassportItemStatus = DocumentStatus | typeof MISSING;

export type PassportSectionKey = "identity" | "studies" | "money" | "references";

interface PassportItemRule {
	type: DocumentType;
	label: string;
	/** Required items must all be verified for the passport to be ready. */
	required: boolean;
	/** Legacy document types that satisfy this item. */
	aliases?: DocumentType[];
}

/**
 * The Seek Passport: the documents a student verifies once and reuses for
 * every application. The required set is the minimum a landlord needs to
 * offer a tenancy (identity, Right to Rent, student status, funds); the rest
 * strengthen the application but never block it.
 */
export const PASSPORT_SECTIONS: {
	key: PassportSectionKey;
	label: string;
	items: PassportItemRule[];
}[] = [
	{
		key: "identity",
		label: "Identity",
		items: [
			{
				type: DocumentType.PASSPORT,
				label: "Passport",
				required: true,
				aliases: [DocumentType.IDENTIFICATION]
			},
			{
				type: DocumentType.RIGHT_TO_RENT,
				label: "Right to Rent share code",
				required: true
			},
			{ type: DocumentType.VISA, label: "eVisa", required: false }
		]
	},
	{
		key: "studies",
		label: "Studies",
		items: [
			{
				type: DocumentType.STUDENT_STATUS,
				label: "Student status",
				required: true
			},
			{
				type: DocumentType.CAS_LETTER,
				label: "CAS / enrolment letter",
				required: false
			}
		]
	},
	{
		key: "money",
		label: "Money and guarantor",
		items: [
			{
				type: DocumentType.GUARANTOR_AGREEMENT,
				label: "UK guarantor",
				required: false
			},
			{
				type: DocumentType.PROOF_OF_FUNDS,
				label: "Proof of funds",
				required: true,
				aliases: [DocumentType.PROOF_OF_INCOME]
			}
		]
	},
	{
		key: "references",
		label: "References and recommendations",
		items: [
			{
				type: DocumentType.LANDLORD_REFERENCE,
				label: "Previous landlord",
				required: false
			},
			{
				type: DocumentType.AGENT_REFERENCE,
				label: "Letting agent reference",
				required: false
			},
			{
				type: DocumentType.RECOMMENDATION,
				label: "Recommendation letter",
				required: false,
				aliases: [DocumentType.CHARACTER_REFERENCE]
			}
		]
	}
];

export interface PassportDocumentInput {
	type: DocumentType;
	status?: DocumentStatus | string;
	label?: string;
	expiresAt?: Date | string | null;
	uploadedAt?: Date | string | null;
	key?: string;
	url?: string;
}

export interface PassportItem {
	type: DocumentType;
	label: string;
	status: PassportItemStatus;
	required: boolean;
	expiresAt: Date | null;
	uploadedAt: Date | null;
	/** File location. Only returned to the document owner or a viewer with an active share. */
	url?: string | null;
	key?: string | null;
}

export interface PassportSection {
	key: PassportSectionKey;
	label: string;
	items: PassportItem[];
}

export interface Passport {
	ready: boolean;
	total: number;
	completed: number;
	percent: number;
	missingRequired: DocumentType[];
	sections: PassportSection[];
}

/**
 * Effective status of a stored document. Anything past its expiry date reads
 * as EXPIRED whatever was stored; documents saved before statuses existed
 * read as PENDING.
 */
export function effectiveStatus(
	document: PassportDocumentInput,
	now: Date = new Date()
): DocumentStatus {
	const expiresAt = document.expiresAt ? new Date(document.expiresAt) : null;
	if (expiresAt && expiresAt.getTime() <= now.getTime()) {
		return DocumentStatus.EXPIRED;
	}
	const status = document.status as DocumentStatus | undefined;
	return status && Object.values(DocumentStatus).includes(status)
		? status
		: DocumentStatus.PENDING;
}

const STATUS_RANK: Record<DocumentStatus, number> = {
	[DocumentStatus.VERIFIED]: 4,
	[DocumentStatus.PENDING]: 3,
	[DocumentStatus.EXPIRED]: 2,
	[DocumentStatus.REJECTED]: 1
};

export function buildPassport(
	documents: PassportDocumentInput[] | undefined,
	now: Date = new Date()
): Passport {
	const list = documents ?? [];
	let total = 0;
	let completed = 0;
	const missingRequired: DocumentType[] = [];

	const sections = PASSPORT_SECTIONS.map(section => ({
		key: section.key,
		label: section.label,
		items: section.items.map(rule => {
			const types = [rule.type, ...(rule.aliases ?? [])];
			// Prefer the strongest matching document, so a verified legacy
			// IDENTIFICATION still counts when a new PASSPORT is pending.
			const best = list
				.filter(document => types.includes(document.type))
				.map(document => ({
					document,
					status: effectiveStatus(document, now)
				}))
				.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status])[0];

			const status: PassportItemStatus = best?.status ?? MISSING;
			total += 1;
			if (status === DocumentStatus.VERIFIED) {
				completed += 1;
			} else if (rule.required) {
				missingRequired.push(rule.type);
			}

			return {
				type: rule.type,
				label: best?.document.label || rule.label,
				status,
				required: rule.required,
				expiresAt: best?.document.expiresAt
					? new Date(best.document.expiresAt)
					: null,
				uploadedAt: best?.document.uploadedAt
					? new Date(best.document.uploadedAt)
					: null,
				url: best?.document.url ?? null,
				key: best?.document.key ?? null
			};
		})
	}));

	return {
		ready: missingRequired.length === 0,
		total,
		completed,
		percent: total === 0 ? 0 : Math.round((completed / total) * 100),
		missingRequired,
		sections
	};
}

/** The same passport with file locations removed, for viewers without a share. */
export function withoutFiles(passport: Passport): Passport {
	return {
		...passport,
		sections: passport.sections.map(section => ({
			...section,
			items: section.items.map(({ url: _url, key: _key, ...item }) => item)
		}))
	};
}
