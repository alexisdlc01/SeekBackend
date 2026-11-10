import { createHash } from "node:crypto";
import { EmailCategory } from "../inbox/email-category.enum";
import { TenancyDocumentType } from "../tenancies/tenancy.enums";
import { BillCategory } from "../bills/bill.schema";
import { DocumentType } from "../users/types/document-type";

/** How a Seek contact relates to the mailbox owner. */
export type ContactRole = "LANDLORD" | "TENANT" | "APPLICANT" | "HOUSEHOLD";

export interface HousingContact {
	email: string;
	name: string;
	role: ContactRole;
	userId: string;
	tenancyId: string | null;
	conversationId: string | null;
}

export interface EmailMeta {
	from: string;
	fromName?: string;
	to: string[];
	subject: string;
	outgoing: boolean;
}

export interface Classification {
	housing: boolean;
	category: EmailCategory;
	/** The Seek contact on the other side, when there is one. */
	contact: HousingContact | null;
	/** Display name for the other side (contact, scheme, supplier...). */
	counterpartName: string;
	reason: string;
}

export const DEPOSIT_SCHEMES: Record<string, string> = {
	"depositprotection.com": "Deposit Protection Service",
	"tenancydepositscheme.com": "Tenancy Deposit Scheme",
	"mydeposits.co.uk": "mydeposits",
	"mydepositsscotland.co.uk": "mydeposits Scotland",
	"safedepositsscotland.com": "SafeDeposits Scotland",
	"lettingprotection.com": "Letting Protection Service",
	"tdsnorthernireland.com": "TDS Northern Ireland"
};

export const UTILITY_PROVIDERS: Record<string, { name: string; category: BillCategory }> = {
	"octopus.energy": { name: "Octopus Energy", category: BillCategory.ENERGY },
	"octopusenergy.com": { name: "Octopus Energy", category: BillCategory.ENERGY },
	"britishgas.co.uk": { name: "British Gas", category: BillCategory.ENERGY },
	"edfenergy.com": { name: "EDF", category: BillCategory.ENERGY },
	"eonnext.com": { name: "E.ON Next", category: BillCategory.ENERGY },
	"eonenergy.com": { name: "E.ON", category: BillCategory.ENERGY },
	"ovoenergy.com": { name: "OVO Energy", category: BillCategory.ENERGY },
	"scottishpower.co.uk": { name: "ScottishPower", category: BillCategory.ENERGY },
	"sse.co.uk": { name: "SSE", category: BillCategory.ENERGY },
	"utilita.co.uk": { name: "Utilita", category: BillCategory.ENERGY },
	"so.energy": { name: "So Energy", category: BillCategory.ENERGY },
	"bristolwater.co.uk": { name: "Bristol Water", category: BillCategory.WATER },
	"wessexwater.co.uk": { name: "Wessex Water", category: BillCategory.WATER },
	"thameswater.co.uk": { name: "Thames Water", category: BillCategory.WATER },
	"severntrent.co.uk": { name: "Severn Trent", category: BillCategory.WATER },
	"unitedutilities.com": { name: "United Utilities", category: BillCategory.WATER },
	"yorkshirewater.com": { name: "Yorkshire Water", category: BillCategory.WATER },
	"anglianwater.co.uk": { name: "Anglian Water", category: BillCategory.WATER },
	"southernwater.co.uk": { name: "Southern Water", category: BillCategory.WATER },
	"southwestwater.co.uk": { name: "South West Water", category: BillCategory.WATER },
	"scottishwater.co.uk": { name: "Scottish Water", category: BillCategory.WATER },
	"dwrcymru.com": { name: "Welsh Water", category: BillCategory.WATER },
	"hyperoptic.com": { name: "Hyperoptic", category: BillCategory.BROADBAND },
	"bt.com": { name: "BT", category: BillCategory.BROADBAND },
	"virginmedia.com": { name: "Virgin Media", category: BillCategory.BROADBAND },
	"sky.com": { name: "Sky", category: BillCategory.BROADBAND },
	"talktalk.co.uk": { name: "TalkTalk", category: BillCategory.BROADBAND },
	"plus.net": { name: "Plusnet", category: BillCategory.BROADBAND },
	"communityfibre.co.uk": { name: "Community Fibre", category: BillCategory.BROADBAND },
	"tvlicensing.co.uk": { name: "TV Licensing", category: BillCategory.TV_LICENCE }
};

export const GUARANTOR_SERVICES: Record<string, string> = {
	"housinghand.co.uk": "Housing Hand",
	"yourguarantor.co.uk": "Your Guarantor",
	"guarantid.com": "Guarantid"
};

const HOUSING_KEYWORDS =
	/\b(?:tenancy|tenant|tenants|landlord|lettings?|letting agent|deposit|rent|rental|inventory|gas safety|cp12|eicr|epc|council tax|guarantor|viewing|right to rent|boiler|repairs?|maintenance|move[- ]in|move[- ]out|check[- ]in|check[- ]out|house ?share|housing|accommodation|utilit(?:y|ies)|energy bill|water bill|broadband|hmo)\b/i;

const STUDENT_KEYWORDS = /\b(?:exemption|student status|enrolment|enrollment|accommodation|certificate)\b/i;

export function domainOf(email: string): string {
	return email.toLowerCase().split("@")[1]?.trim() ?? "";
}

function matchDomain<T>(domain: string, table: Record<string, T>): T | undefined {
	if (table[domain]) return table[domain];
	const parent = Object.keys(table).find(key => domain.endsWith(`.${key}`));
	return parent ? table[parent] : undefined;
}

export function isUniversityDomain(domain: string) {
	return domain.endsWith(".ac.uk");
}

export function isGovDomain(domain: string) {
	return domain.endsWith(".gov.uk");
}

const ROLE_CATEGORY: Record<ContactRole, EmailCategory> = {
	LANDLORD: EmailCategory.LANDLORD,
	TENANT: EmailCategory.TENANT,
	APPLICANT: EmailCategory.APPLICANT,
	HOUSEHOLD: EmailCategory.HOUSEHOLD
};

/**
 * Decides whether an email is housing-related and how to file it, from the
 * headers only (sender, recipients, subject). Bodies of other emails are never
 * fetched.
 */
export function classifyEmail(meta: EmailMeta, contacts: Map<string, HousingContact>): Classification {
	const from = meta.from.toLowerCase();
	const counterparts = meta.outgoing ? meta.to.map(address => address.toLowerCase()) : [from];
	const contact = counterparts.map(address => contacts.get(address)).find(Boolean) ?? null;
	if (contact) {
		return {
			housing: true,
			category: ROLE_CATEGORY[contact.role],
			contact,
			counterpartName: contact.name,
			reason: `Seek contact (${contact.role.toLowerCase()})`
		};
	}

	const subject = meta.subject ?? "";
	for (const address of counterparts) {
		const domain = domainOf(address);
		const scheme = matchDomain(domain, DEPOSIT_SCHEMES);
		if (scheme) {
			return { housing: true, category: EmailCategory.DEPOSIT, contact: null, counterpartName: scheme, reason: "Deposit scheme" };
		}
		const utility = matchDomain(domain, UTILITY_PROVIDERS);
		if (utility) {
			return { housing: true, category: EmailCategory.BILLS, contact: null, counterpartName: utility.name, reason: "Utility provider" };
		}
		const guarantor = matchDomain(domain, GUARANTOR_SERVICES);
		if (guarantor) {
			return { housing: true, category: EmailCategory.OTHER, contact: null, counterpartName: guarantor, reason: "Guarantor service" };
		}
		if (isUniversityDomain(domain) && (HOUSING_KEYWORDS.test(subject) || STUDENT_KEYWORDS.test(subject))) {
			return {
				housing: true,
				category: EmailCategory.UNIVERSITY,
				contact: null,
				counterpartName: universityName(domain, meta.outgoing ? undefined : meta.fromName),
				reason: "University"
			};
		}
		if (isGovDomain(domain) && HOUSING_KEYWORDS.test(subject)) {
			return {
				housing: true,
				category: /council tax/i.test(subject) ? EmailCategory.BILLS : EmailCategory.OTHER,
				contact: null,
				counterpartName: (meta.outgoing ? "" : meta.fromName) || councilName(domain),
				reason: "Council"
			};
		}
	}

	if (HOUSING_KEYWORDS.test(subject)) {
		const category = /\bdeposit\b/i.test(subject)
			? EmailCategory.DEPOSIT
			: /\b(?:bill|statement|council tax|utilit(?:y|ies)|energy|water|broadband)\b/i.test(subject)
				? EmailCategory.BILLS
				: EmailCategory.OTHER;
		return {
			housing: true,
			category,
			contact: null,
			counterpartName: (meta.outgoing ? meta.to[0] : meta.fromName || meta.from) ?? "",
			reason: "Housing keywords"
		};
	}

	return { housing: false, category: EmailCategory.OTHER, contact: null, counterpartName: "", reason: "Not housing-related" };
}

function capitalise(word: string) {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function universityName(domain: string, fromName?: string) {
	const base = domain.replace(/\.ac\.uk$/, "").split(".").pop() ?? domain;
	const known: Record<string, string> = {
		bristol: "University of Bristol",
		ucl: "UCL",
		kcl: "King's College London",
		ed: "University of Edinburgh",
		gla: "University of Glasgow",
		cardiff: "Cardiff University",
		manchester: "University of Manchester",
		leeds: "University of Leeds",
		"st-andrews": "University of St Andrews"
	};
	return known[base] ?? fromName ?? `University (${capitalise(base)})`;
}

function councilName(domain: string) {
	const base = domain.replace(/\.gov\.uk$/, "").split(".").pop() ?? domain;
	return `${base.split("-").map(capitalise).join(" ")} Council`;
}

const DOCUMENT_RULES: { pattern: RegExp; type: TenancyDocumentType }[] = [
	{ pattern: /\b(?:dps|tds|mydeposits|deposit)\b.*\b(?:cert|certificate|protection)\b|\bdeposit[-_ ]?cert/i, type: TenancyDocumentType.DEPOSIT_CERTIFICATE },
	{ pattern: /gas[-_ ]?safety|\bcp12\b/i, type: TenancyDocumentType.GAS_SAFETY },
	{ pattern: /\beicr\b|electrical[-_ ]?(?:installation|safety|condition)/i, type: TenancyDocumentType.EICR },
	{ pattern: /\bepc\b|energy[-_ ]?performance/i, type: TenancyDocumentType.EPC },
	{ pattern: /council[-_ ]?tax[-_ ]?exempt|exemption[-_ ]?cert/i, type: TenancyDocumentType.COUNCIL_TAX_EXEMPTION },
	{ pattern: /how[-_ ]?to[-_ ]?rent/i, type: TenancyDocumentType.HOW_TO_RENT },
	{ pattern: /inventory|check[-_ ]?in[-_ ]?report|schedule[-_ ]?of[-_ ]?condition/i, type: TenancyDocumentType.INVENTORY },
	{ pattern: /tenancy[-_ ]?agreement|\bast\b|occupation[-_ ]?contract|private[-_ ]?residential[-_ ]?tenancy|\blease\b/i, type: TenancyDocumentType.TENANCY_AGREEMENT }
];

/** Tenancy document type for an attachment, from its file name then the subject. */
export function documentTypeFor(fileName: string, subject: string): TenancyDocumentType | null {
	for (const source of [fileName, subject]) {
		const rule = DOCUMENT_RULES.find(candidate => candidate.pattern.test(source));
		if (rule) return rule.type;
	}
	return null;
}

/** Where the client shows a filed tenancy document. */
export function filedLabelFor(type: TenancyDocumentType): string {
	if (type === TenancyDocumentType.TENANCY_AGREEMENT) return "My home › Contract";
	if (type === TenancyDocumentType.DEPOSIT_CERTIFICATE) return "My home › Deposit";
	return "My home › Documents";
}

/** A reference letter for the student's Seek Passport, from its file name or subject. */
export function referenceTypeFor(fileName: string, subject: string): DocumentType.LANDLORD_REFERENCE | DocumentType.AGENT_REFERENCE | DocumentType.CHARACTER_REFERENCE | null {
	const text = `${fileName} ${subject}`;
	if (!/\breference\b|reference[-_]/i.test(text)) return null;
	// "Letting agent reference for …" is the subject Seek uses when it asks an agent (POST /users/me/passport/references).
	if (/letting agent|agent reference/i.test(text)) return DocumentType.AGENT_REFERENCE;
	return /landlord|letting|agent|tenan/i.test(text) ? DocumentType.LANDLORD_REFERENCE : DocumentType.CHARACTER_REFERENCE;
}

export function looksLikeBill(fileName: string, subject: string): boolean {
	return /\b(?:bill|statement|invoice)\b|statement[-_]|bill[-_]|invoice[-_]/i.test(`${fileName} ${subject}`);
}

export function billCategoryFor(fromEmail: string, subject: string): BillCategory {
	const utility = matchDomain(domainOf(fromEmail), UTILITY_PROVIDERS);
	if (utility) return utility.category;
	if (/council tax/i.test(subject)) return BillCategory.COUNCIL_TAX;
	if (/\bwater\b/i.test(subject)) return BillCategory.WATER;
	if (/broadband|internet|wifi/i.test(subject)) return BillCategory.BROADBAND;
	if (/energy|electric|gas\b/i.test(subject)) return BillCategory.ENERGY;
	return BillCategory.OTHER;
}

/** The amount due on a bill email, in pence: "Total £214.00", "Amount due: £42.50". */
export function parseAmountPence(text: string): number | null {
	const labelled = /(?:total|amount due|balance|to pay|you owe|due)[^£\d]{0,20}£\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?!\d|[.,]\d)/i.exec(text);
	const match = labelled ?? /£\s?((?:\d{1,3}(?:,\d{3})+|\d+)\.\d{2})(?!\d|[.,]\d)/.exec(text);
	if (!match) return null;
	const pence = Math.round(Number(match[1].replace(/,/g, "")) * 100);
	return Number.isFinite(pence) && pence > 0 ? pence : null;
}

/** Stable inbox thread id for a provider thread in one mailbox. */
export function threadKeyFor(connectionId: string, providerThreadId: string): string {
	return createHash("sha256").update(`${connectionId}:${providerThreadId}`).digest("hex").slice(0, 24);
}

/** "Name <a@b.c>" → { name, email }. */
export function parseAddress(raw: string | undefined | null): { name: string; email: string } {
	const value = (raw ?? "").trim();
	const angled = /^(.*)<([^>]+)>\s*$/.exec(value);
	if (angled) {
		return {
			name: angled[1].trim().replace(/^"|"$/g, ""),
			email: angled[2].trim().toLowerCase()
		};
	}
	return { name: "", email: value.toLowerCase() };
}

/** Splits a To/Cc header into addresses, ignoring commas inside quoted names. */
export function parseAddressList(raw: string | undefined | null): string[] {
	if (!raw) return [];
	const parts = raw.match(/(?:"[^"]*"|[^,])+/g) ?? [];
	return parts.map(part => parseAddress(part).email).filter(email => email.includes("@"));
}
