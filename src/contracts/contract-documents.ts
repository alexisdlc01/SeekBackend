import { createHmac, timingSafeEqual } from "node:crypto";
import { ContractTemplateKind } from "./contract.schema";

/**
 * Seek's built-in tenancy agreement and the deposit's prescribed information,
 * rendered as plain HTML from the tenancy. Wording is a plain-English starting
 * point, not legal advice; statute always overrides it.
 */
export type ContractDocument = "agreement" | "prescribed-information";

export interface ContractDocumentData {
	kind: ContractTemplateKind;
	title: string;
	landlord: { name?: string; email?: string; companyName?: string };
	tenants: { name?: string; email?: string }[];
	address: string;
	startDate: Date;
	/** Per tenant, in pence. */
	monthlyRent: number;
	/** Per tenant, in pence. */
	depositAmount: number;
	depositScheme?: string | null;
	depositReference?: string | null;
	depositReceivedAt?: Date | null;
	depositProtectedAt?: Date | null;
	billsIncluded?: boolean;
	licenceNumber?: string | null;
}

const SCHEMES: Record<string, { name: string; site: string }> = {
	DPS: { name: "Deposit Protection Service", site: "depositprotection.com" },
	TDS: { name: "Tenancy Deposit Scheme", site: "tenancydepositscheme.com" },
	MYDEPOSITS: { name: "mydeposits", site: "mydeposits.co.uk" }
};

export function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const pounds = (pence: number) => `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (date?: Date | null) =>
	date ? new Date(date).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" }) : "to be confirmed";
function ordinal(n: number): string {
	if (n % 100 >= 11 && n % 100 <= 13) return `${n}th`;
	return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

function page(title: string, body: string): string {
	return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>body{font:16px/1.55 system-ui,-apple-system,sans-serif;max-width:760px;margin:0 auto;padding:24px 16px;color:#1b1b1f;background:#fff}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 6px}p,li{margin:6px 0}.muted{color:#5d5d66;font-size:14px}
table{border-collapse:collapse;width:100%}td{border-top:1px solid #e3e3e8;padding:6px 8px 6px 0;vertical-align:top}td:first-child{width:38%;color:#5d5d66}</style>
</head><body>${body}</body></html>`;
}

function rows(pairs: [string, string][]): string {
	return `<table>${pairs.map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join("")}</table>`;
}

function people(data: ContractDocumentData) {
	const landlord = [data.landlord.companyName, data.landlord.name].filter(Boolean).join(" for ") || "The landlord";
	const tenants = data.tenants.map(t => t.name || t.email || "Tenant");
	return { landlord, tenants };
}

export function renderAgreement(data: ContractDocumentData): string {
	const wales = data.kind === ContractTemplateKind.WALES_STANDARD_OCCUPATION;
	const { landlord, tenants } = people(data);
	const tenantWord = wales ? "contract-holder" : "tenant";
	const count = Math.max(1, tenants.length);
	const rentDay = ordinal(new Date(data.startDate).getUTCDate());
	const scheme = SCHEMES[data.depositScheme ?? ""]?.name ?? "a government-approved deposit scheme";

	const law = wales
		? "This is a standard periodic occupation contract under the Renting Homes (Wales) Act 2016. The fundamental and supplementary terms set by that Act are part of this contract, and they win wherever this statement says something different."
		: "This is an assured periodic tenancy under the Housing Act 1988, as amended by the Renters' Rights Act 2025. It rolls on month by month with no fixed end date. The rules in those Acts are part of this agreement, and they win wherever this statement says something different.";
	const ending = wales
		? `<li>A ${tenantWord} can end the contract by giving the landlord at least four weeks' written notice.</li>
<li>The landlord can only end the contract by giving at least six months' notice, and not within the first six months of occupation, or by a court order on a ground set by the Act.</li>`
		: `<li>A tenant can end the tenancy by giving the landlord at least two months' written notice, ending on the last day of a rental period.</li>
<li>The landlord can only end the tenancy through the courts on a ground in Schedule 2 of the Housing Act 1988, after giving the notice that ground requires. Where the home is let to full-time students, the landlord may rely on ground 4A to re-let for the next academic year, giving at least four months' notice to end between 1 June and 30 September.</li>
<li>The landlord can raise the rent no more than once a year, using a section 13 notice giving at least two months' notice. Rent may not be asked for more than one month in advance.</li>`;

	const body = `<h1>${escapeHtml(data.title)}</h1>
<p class="muted">${wales ? "Written statement of the occupation contract" : "Written statement of terms"} · prepared by Seek</p>
<h2>1. Who this agreement is between</h2>
${rows([
	["Landlord", landlord],
	...(data.landlord.email ? ([["Landlord's address for notices", data.landlord.email]] as [string, string][]) : []),
	[wales ? "Contract-holders" : "Tenants", tenants.join(", ") || "To be added"],
	...(wales && data.licenceNumber ? ([["Rent Smart Wales licence", data.licenceNumber]] as [string, string][]) : [])
])}
<p>${escapeHtml(law)}</p>
<h2>2. The home</h2>
${rows([
	["Address", data.address],
	[wales ? "Occupation date" : "Start date", day(data.startDate)],
	["Period", "Monthly, rolling until it is ended as set out in section 7"]
])}
<p>The ${tenantWord}s share the whole home together and are jointly responsible for it.</p>
<h2>3. Rent</h2>
${rows([
	[`Rent per ${tenantWord}`, `${pounds(data.monthlyRent)} a month`],
	["Rent for the home", `${pounds(data.monthlyRent * count)} a month`],
	["Due", `On the ${rentDay} of each month, in advance, through Seek`],
	["Bills", data.billsIncluded ? "Included in the rent" : `Not included: the ${tenantWord}s pay energy, water, broadband and any council tax`]
])}
<h2>4. Deposit</h2>
${rows([
	[`Deposit per ${tenantWord}`, pounds(data.depositAmount)],
	["Deposit for the home", pounds(data.depositAmount * count)],
	["Protected with", scheme]
])}
<p>The deposit is no more than five weeks' rent. The landlord will protect it with ${escapeHtml(scheme)} and give the ${tenantWord}s the scheme's prescribed information within 30 days of receiving it. At the end, any deductions must be agreed with the ${tenantWord}s or decided by the scheme's free dispute service.</p>
<h2>5. What the landlord agrees to</h2>
<ul>
<li>Keep the structure, exterior, heating, hot water, gas, electrics and sanitation in repair and working order, and keep the home fit to live in.</li>
<li>Have a gas safety check every year, an electrical safety check at least every five years, and keep a valid energy performance certificate, giving the ${tenantWord}s copies.</li>
<li>Fit and test smoke alarms on every floor and a carbon monoxide alarm in any room with a fixed combustion appliance.</li>
<li>Give at least 24 hours' written notice before visiting, except in an emergency, and let the ${tenantWord}s live in the home without interference.</li>
</ul>
<h2>6. What the ${tenantWord}s agree to</h2>
<ul>
<li>Pay the rent on time and look after the home, its fixtures and the items listed in the check-in inventory.</li>
<li>Report repairs promptly through Seek, and allow access for repairs and safety checks after proper notice.</li>
<li>Not sublet or take in lodgers without the landlord's written consent, and not cause nuisance to neighbours.</li>
<li>Leave the home clean at the end, allowing for fair wear and tear.</li>
</ul>
<h2>7. Ending the agreement</h2>
<ul>${ending}</ul>
<h2>8. Signatures</h2>
<p>Each ${tenantWord} and the landlord sign this agreement electronically in Seek. Seek records who signed and when.</p>
<p class="muted">Seek template, November 2026. This template is a starting point, not legal advice: check it against current law before relying on it.</p>`;
	return page(data.title, body);
}

export function renderPrescribedInformation(data: ContractDocumentData): string {
	const wales = data.kind === ContractTemplateKind.WALES_STANDARD_OCCUPATION;
	const { landlord, tenants } = people(data);
	const scheme = SCHEMES[data.depositScheme ?? ""];
	const count = Math.max(1, tenants.length);
	const title = "Deposit prescribed information";
	const body = `<h1>${title}</h1>
<p class="muted">${escapeHtml(data.address)}</p>
<p>Your landlord must protect your deposit and give you this information within 30 days of receiving it${wales ? " (Housing Act 2004, as applied in Wales)" : " (Housing Act 2004, section 213)"}.</p>
<h2>The deposit</h2>
${rows([
	["Amount for the home", pounds(data.depositAmount * count)],
	["Each person's share", pounds(data.depositAmount)],
	["Received by the landlord", day(data.depositReceivedAt)],
	["Protected on", day(data.depositProtectedAt)],
	["Scheme", scheme ? `${scheme.name} (${scheme.site})` : "To be confirmed"],
	["Deposit reference", data.depositReference || "To be confirmed"]
])}
<h2>Who is involved</h2>
${rows([
	["Landlord", landlord],
	["Landlord's contact", data.landlord.email || "Through Seek"],
	[wales ? "Contract-holders" : "Tenants", tenants.join(", ") || "To be added"],
	["Start date", day(data.startDate)]
])}
<h2>Getting your deposit back</h2>
<ul>
<li>At the end of the ${wales ? "contract" : "tenancy"}, the landlord may keep part of the deposit only for unpaid rent or bills they are owed, or for damage beyond fair wear and tear compared with the check-in inventory.</li>
<li>Any deduction must be agreed with you. Ask for the deposit back in writing; the landlord should reply within 10 days.</li>
<li>If you can't agree, the scheme's free dispute service decides, using the evidence from both sides.</li>
<li>If the landlord does not respond, you can apply to the scheme directly${scheme ? ` at ${escapeHtml(scheme.site)}` : ""}.</li>
</ul>
<p>I confirm that the information above is accurate to the best of my knowledge and belief, and that the ${wales ? "contract-holders have" : "tenants have"} had the chance to sign this document to confirm it.</p>
<p>${escapeHtml(landlord)}</p>
<p class="muted">Prepared by Seek. Check the scheme's own prescribed-information template for any extra wording it requires.</p>`;
	return page(title, body);
}

/**
 * shortcut: the link never expires, like an emailed copy of the agreement;
 * sign with an expiry and refresh it in list responses if links leak.
 */
export function documentSignature(secret: string, contractId: string, doc: ContractDocument): string {
	return createHmac("sha256", secret).update(`${contractId}:${doc}`).digest("hex");
}

export function isValidSignature(secret: string, contractId: string, doc: ContractDocument, signature: unknown): boolean {
	if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
	return timingSafeEqual(Buffer.from(documentSignature(secret, contractId, doc), "hex"), Buffer.from(signature, "hex"));
}
