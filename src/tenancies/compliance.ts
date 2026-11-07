import { Types } from "mongoose";
import { Nation } from "../listings/enums/nation.enum";

export type ComplianceKind =
	| "GAS_SAFETY"
	| "EICR"
	| "EPC"
	| "HMO_LICENCE"
	| "DEPOSIT_UNPROTECTED"
	| "DEPOSIT_NOT_YET_RECEIVED"
	| "DEPOSIT_OVER_CAP"
	| "LISTING_DEPOSIT_OVER_CAP"
	| "HOLDING_DEPOSIT_OVER_CAP";

/** high = overdue or unlawful now, medium = due within 14 days, low = within 30. */
export type ComplianceSeverity = "high" | "medium" | "low";

export interface ComplianceItem {
	listing: string;
	listingTitle: string | null;
	tenancy: string | null;
	kind: ComplianceKind;
	dueDate: Date;
	severity: ComplianceSeverity;
	message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
export const COMPLIANCE_WINDOW_DAYS = 30;
/** Deposits must be protected within 30 days of being received. */
export const DEPOSIT_PROTECTION_DAYS = 30;

/**
 * Tenant Fees Act cap: five weeks' rent when annual rent is under £50,000.
 * Scotland: Rent (Scotland) Act 1984 s.90, two months' rent.
 */
export function depositCapPence(monthlyRentPence: number, nation?: unknown): number {
	if (nation === Nation.SCOTLAND) return monthlyRentPence * 2;
	return Math.floor(((monthlyRentPence * 12) / 52) * 5);
}

/** "five-week cap" or, in Scotland, "two-month cap". */
export function depositCapName(nation?: unknown): string {
	return nation === Nation.SCOTLAND ? "two-month cap" : "five-week cap";
}

/** How long the landlord has to protect the deposit, for messages. */
export function depositProtectionWindow(nation?: unknown): string {
	return nation === Nation.SCOTLAND ? "30 working days of the tenancy starting" : "30 days";
}

/** Tenant Fees Act: a holding deposit may not exceed one week's rent. */
export function holdingDepositCapPence(monthlyRentPence: number): number {
	return Math.floor((monthlyRentPence * 12) / 52);
}

/**
 * The deposit must be protected within 30 days of being received. The clock
 * runs from depositReceivedAt only, never from the start date; null until the
 * receipt is recorded.
 */
export function depositProtectionDeadline(
	tenancy: { depositReceivedAt?: Date | null; startDate?: Date | null },
	nation?: unknown
): Date | null {
	// Scotland: 30 working days from the start of the tenancy (Tenancy Deposit Schemes (Scotland) Regulations 2011).
	if (nation === Nation.SCOTLAND) return tenancy.startDate ? addWorkingDays(new Date(tenancy.startDate), 30) : null;
	if (!tenancy.depositReceivedAt) return null;
	return new Date(new Date(tenancy.depositReceivedAt).getTime() + DEPOSIT_PROTECTION_DAYS * DAY_MS);
}

// shortcut: skips weekends but not bank holidays, so the deadline can land a day or two early; add a holiday calendar if landlords need the exact date.
function addWorkingDays(from: Date, days: number): Date {
	const date = new Date(from);
	for (let left = days; left > 0; ) {
		date.setUTCDate(date.getUTCDate() + 1);
		if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) left--;
	}
	return date;
}

export function severityFor(dueDate: Date, now: Date): ComplianceSeverity {
	const days = (dueDate.getTime() - now.getTime()) / DAY_MS;
	if (days < 0) return "high";
	if (days <= 14) return "medium";
	return "low";
}

const LISTING_CHECKS: { field: string; kind: ComplianceKind; label: string }[] = [
	{ field: "gasSafetyExpiry", kind: "GAS_SAFETY", label: "Gas safety certificate" },
	{ field: "eicrExpiry", kind: "EICR", label: "Electrical safety report (EICR)" },
	{ field: "epcExpiry", kind: "EPC", label: "Energy performance certificate" },
	{ field: "hmoLicenceExpiry", kind: "HMO_LICENCE", label: "HMO licence" }
];

interface ListingLike {
	_id: Types.ObjectId | string;
	propertyTitle?: string;
	streetAddress?: string;
	[key: string]: unknown;
}

interface TenancyLike {
	_id: Types.ObjectId | string;
	listing: Types.ObjectId | string | ListingLike;
	startDate: Date;
	monthlyRent: number;
	depositAmount: number;
	depositProtectedAt?: Date | null;
	/** When the tenant's deposit reached the landlord; the 30-day clock starts here. */
	depositReceivedAt?: Date | null;
}

function titleOf(listing: ListingLike | undefined): string | null {
	return listing?.propertyTitle || listing?.streetAddress || null;
}

function formatPounds(pence: number): string {
	return `£${(pence / 100).toFixed(2)}`;
}

/** Certificates and licences that have expired or expire within 30 days. */
export function listingCompliance(listing: ListingLike, now: Date = new Date()): ComplianceItem[] {
	const horizon = now.getTime() + COMPLIANCE_WINDOW_DAYS * DAY_MS;
	const items: ComplianceItem[] = [];
	for (const check of LISTING_CHECKS) {
		const raw = listing[check.field] as Date | string | null | undefined;
		if (!raw) continue;
		const dueDate = new Date(raw);
		if (dueDate.getTime() > horizon) continue;
		const expired = dueDate.getTime() < now.getTime();
		items.push({
			listing: listing._id.toString(),
			listingTitle: titleOf(listing),
			tenancy: null,
			kind: check.kind,
			dueDate,
			severity: severityFor(dueDate, now),
			message: expired
				? `${check.label} has expired. Renew it before letting the property.`
				: `${check.label} expires soon. Book the renewal.`
		});
	}
	items.push(...listingDepositCompliance(listing, now));
	return items;
}

/**
 * Warnings (never blocks) when a listing asks for more than the law allows:
 * a deposit above five weeks' rent or a holding deposit above one week's.
 * Listing money is whole pounds; the caps are the same ratio of the rent.
 */
export function listingDepositCompliance(listing: ListingLike, now: Date = new Date()): ComplianceItem[] {
	const rent = Number(listing.monthlyRent);
	if (!Number.isFinite(rent) || rent <= 0) return [];
	const rentPence = Math.round(rent * 100);
	const nation = listing.nation;
	const people = Math.max(1, Number(listing.numOfPeople) || 1);
	const base = {
		listing: listing._id.toString(),
		listingTitle: titleOf(listing),
		tenancy: null,
		dueDate: now,
		severity: "high" as const
	};
	const items: ComplianceItem[] = [];
	const deposit = Number(listing.securityDeposit);
	if (Number.isFinite(deposit) && deposit > 0 && Math.round(deposit * 100) > depositCapPence(rentPence, nation)) {
		items.push({
			...base,
			kind: "LISTING_DEPOSIT_OVER_CAP",
			message: `The deposit of ${formatPounds(Math.round(deposit * 100))} is above the ${depositCapName(nation)} of ${formatPounds(depositCapPence(rentPence, nation))}. Lower it before letting.`
		});
	}
	const holding = Number(listing.holdingDeposit);
	// holdingDeposit is per room, so compare it with one room's weekly rent.
	const roomCap = holdingDepositCapPence(Math.round(rentPence / people));
	// The one-week holding deposit cap is the Tenant Fees Act's; Scotland has no such cap.
	if (nation !== Nation.SCOTLAND && Number.isFinite(holding) && holding > 0 && Math.round(holding * 100) > roomCap) {
		items.push({
			...base,
			kind: "HOLDING_DEPOSIT_OVER_CAP",
			message: `The holding deposit of ${formatPounds(Math.round(holding * 100))} is above the one-week cap of ${formatPounds(roomCap)} per room.`
		});
	}
	return items;
}

/** Deposit protection deadline and the five-week deposit cap. */
export function tenancyCompliance(
	tenancy: TenancyLike,
	listing: ListingLike | undefined,
	now: Date = new Date()
): ComplianceItem[] {
	const items: ComplianceItem[] = [];
	const listingId =
		listing?._id?.toString() ??
		(typeof tenancy.listing === "object" && "_id" in (tenancy.listing as object)
			? (tenancy.listing as ListingLike)._id.toString()
			: tenancy.listing.toString());
	const base = {
		listing: listingId,
		listingTitle: titleOf(listing),
		tenancy: tenancy._id.toString()
	};

	const nation = listing?.nation;
	const deadline = depositProtectionDeadline(tenancy, nation);
	if (tenancy.depositAmount > 0 && !tenancy.depositProtectedAt && !deadline) {
		// No receipt date yet, so no deadline to count down: ask for it.
		items.push({
			...base,
			kind: "DEPOSIT_NOT_YET_RECEIVED",
			dueDate: new Date(tenancy.startDate),
			severity: "low",
			message: "Record when you received the deposit: it must be protected within 30 days of that date."
		});
	}
	if (tenancy.depositAmount > 0 && !tenancy.depositProtectedAt && deadline) {
		const dueDate = deadline;
		const overdue = dueDate.getTime() < now.getTime();
		items.push({
			...base,
			kind: "DEPOSIT_UNPROTECTED",
			dueDate,
			severity: severityFor(dueDate, now),
			message: overdue
				? `Deposit is not protected and the ${nation === Nation.SCOTLAND ? "30-working-day" : "30-day"} deadline has passed.`
				: `Protect the deposit in a government-approved scheme within ${depositProtectionWindow(nation)}.`
		});
	}

	const cap = depositCapPence(tenancy.monthlyRent, nation);
	if (tenancy.depositAmount > cap) {
		items.push({
			...base,
			kind: "DEPOSIT_OVER_CAP",
			dueDate: new Date(tenancy.startDate),
			severity: "high",
			message: `Deposit of ${formatPounds(tenancy.depositAmount)} is above the ${depositCapName(nation)} of ${formatPounds(cap)}.`
		});
	}
	return items;
}

export function sortCompliance(items: ComplianceItem[]): ComplianceItem[] {
	const rank: Record<ComplianceSeverity, number> = { high: 0, medium: 1, low: 2 };
	return [...items].sort(
		(a, b) => rank[a.severity] - rank[b.severity] || a.dueDate.getTime() - b.dueDate.getTime()
	);
}
