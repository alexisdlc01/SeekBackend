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
	rejectionReason?: string | null;
}

/** Someone Seek emailed for a guarantor agreement or a reference (POST /users/me/passport/references). */
export interface ReferenceRequestInput {
	type: DocumentType;
	name: string;
	requestedAt: Date | string;
}

/** A student who proved their university address (POST /users/me/student-email/verify), plus pending requests. */
export interface StudentEmailProof {
	studentVerifiedAt?: Date | string | null;
	universityEmail?: string | null;
	referenceRequests?: ReferenceRequestInput[] | null;
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
	/** Where the item came from: a document, a university email, or a request Seek emailed and is waiting on. Null when missing. */
	source?: "document" | "university email" | "request" | null;
	/** E.g. the confirmed university address or the person asked. Only for the owner or a viewer with an active share. */
	detail?: string | null;
	/** When Seek emailed the guarantor or referee. Only set while waiting on their reply. */
	requestedAt?: Date | null;
	/** What to fix, when the automatic review rejected the document. */
	reason?: string | null;
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
	[DocumentStatus.VERIFIED]: 5,
	[DocumentStatus.PROVIDED]: 4,
	[DocumentStatus.PENDING]: 3,
	[DocumentStatus.EXPIRED]: 2,
	[DocumentStatus.REJECTED]: 1
};

export function buildPassport(
	documents: PassportDocumentInput[] | undefined,
	now: Date = new Date(),
	student?: StudentEmailProof | null
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

			// A confirmed university email proves student status without a document.
			const byEmail = rule.type === DocumentType.STUDENT_STATUS
				&& !!student?.studentVerifiedAt
				&& best?.status !== DocumentStatus.VERIFIED;
			const status: PassportItemStatus = byEmail ? DocumentStatus.VERIFIED : best?.status ?? MISSING;
			total += 1;
			// PROVIDED identity documents count: the landlord checks them, not Seek.
			if (status === DocumentStatus.VERIFIED || status === DocumentStatus.PROVIDED) {
				completed += 1;
			} else if (rule.required) {
				missingRequired.push(rule.type);
			}

			// No document yet but Seek emailed someone for it: show it as pending.
			const request = best || byEmail
				? undefined
				: student?.referenceRequests?.find(item => types.includes(item.type));
			if (request) {
				return {
					type: rule.type,
					label: rule.label,
					status: DocumentStatus.PENDING,
					required: rule.required,
					expiresAt: null,
					uploadedAt: null,
					url: null,
					key: null,
					source: "request" as const,
					detail: request.name,
					requestedAt: new Date(request.requestedAt)
				};
			}

			if (byEmail) {
				return {
					type: rule.type,
					label: rule.label,
					status,
					required: rule.required,
					expiresAt: null,
					uploadedAt: student?.studentVerifiedAt ? new Date(student.studentVerifiedAt) : null,
					url: null,
					key: null,
					source: "university email" as const,
					detail: student?.universityEmail ?? null
				};
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
				key: best?.document.key ?? null,
				source: best ? "document" as const : null,
				detail: null,
				reason: status === DocumentStatus.REJECTED ? best?.document.rejectionReason ?? null : null
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
			items: section.items.map(({ url: _url, key: _key, detail: _detail, reason: _reason, ...item }) => item)
		}))
	};
}
