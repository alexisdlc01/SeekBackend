import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { ThrottlerStorage } from "@nestjs/throttler";
import { Model, Types } from "mongoose";
import { Listing } from "./listings.schema";
import { User } from "../users/users.schema";
import { ListingsGateway } from "./listings.gateway";
import { ModerationStatus } from "./enums/moderation-status.enum";
import { AI_USER_LIMITS } from "../ai/ai.controller";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";

const RETRY_MS = 15 * 60 * 1000;
const RETRY_BATCH = 25;
/** Same per-account Seek AI quota as /ai routes; false means "try later", never an error. */
export async function withinAiQuota(storage: ThrottlerStorage | undefined, userId: string): Promise<boolean> {
	if (!storage) return true;
	for (const { name, ttl, limit } of AI_USER_LIMITS) {
		const hit = await storage.increment(`${name}:${userId}`, ttl, limit, ttl, name);
		if (hit.isBlocked) return false;
	}
	return true;
}

const REQUIRED: [keyof Listing, string][] = [
	["propertyTitle", "title"],
	["propertyDesc", "description"],
	["propertyType", "property type"],
	["streetAddress", "street address"],
	["cityTown", "town"],
	["postcodeZIP", "postcode"],
	["monthlyRent", "monthly rent"],
	["numOfPeople", "number of tenants"],
	["bedroomsCount", "bedrooms"],
	["availableFrom", "available from date"]
];

const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|co\.uk|uk|net|org|io|me|ly)\b/i;

/**
 * The contact or payment detail found in a landlord's text, or null. Narrower than Seek AI's
 * output filter, so honest text passes: "campus.Bills" is not a link and 01/09/26 is a date.
 */
export function unsafeListingDetail(text: string): string | null {
	// IBAN blocks after the bank code are digits, so a postcode district and words ("SE15 with easy tube link") pass under /i.
	// UK phones only (0, +44 or 0044 then 9+ digits), so years, dates, sizes and price ranges pass.
	const found = text.match(/\b[A-Z]{2}\d{2}\s?[A-Z0-9]{4}(?:\s?\d{4}){2,}\b|\bsort code\D{0,5}\d{6}\b|(?<![\w+(])(?:\+44|0044|\(?0)(?:[\s.()-]{0,2}\d){9,}|[\w.+-]+@[\w-]+(?:\.[\w-]+)+/i) ?? text.match(LINK);
	if (found) return found[0];
	// nn-nn-nn sort codes (exactly three pairs, so "12 14 16 18" sizes pass); dd/mm/yy and dd.mm.yy dates are fine.
	for (const [match, day, sep, month] of text.matchAll(/(?<!\d[-. /]?)\b(\d{2})([-. /])(\d{2})\2\d{2}\b(?![-. /]?\d)/g)) {
		const isDate = sep !== "-" && +day >= 1 && +day <= 31 && +month >= 1 && +month <= 12;
		if (!isDate) return match;
	}
	return null;
}

// shortcut: £150–£3000 per person per month is a sanity band for UK student rooms, not market data; widen it if real listings trip it.
const RENT_PER_PERSON = { min: 150, max: 3000 };

// Off-platform payment asks. "transfer" only counts when tied to before viewing / to hold / outside Seek, so "bank transfer accepted for rent" passes.
const OFF_PLATFORM_PAYMENT = new RegExp([
	"\\bwestern\\s+union\\b", "\\bmoney\\s?gram\\b", "\\bwire\\s+transfer\\b", "\\bbitcoin\\b", "\\bcrypto(?:currency)?\\b", "\\busdt\\b", "\\bgift\\s+cards?\\b",
	"\\bpay(?:ing)?\\s+(?:the\\s+|a\\s+)?(?:deposit|rent|fees?)\\s+before\\s+(?:the\\s+|any\\s+)?(?:viewing|visit)s?\\b",
	"\\btransfer\\b[^.\\n]{0,40}\\b(?:before\\s+(?:the\\s+|any\\s+)?(?:viewing|visit)|to\\s+(?:hold|reserve|secure)|outside\\s+(?:of\\s+)?seek)"
].join("|"), "i");

/** Deterministic checks; each failure is a sentence telling the landlord what to fix. */
export function listingRuleFailures(listing: Partial<Listing>, now: Date, geocodingEnabled: boolean): string[] {
	const reasons: string[] = [];
	const missing = REQUIRED.filter(([key]) => listing[key] === undefined || listing[key] === null || listing[key] === "").map(([, label]) => label);
	if (missing.length) reasons.push(`Add the missing details: ${missing.join(", ")}.`);
	// Without a geocoding key (local development) no listing has a map position, so the check is skipped.
	if (geocodingEnabled && listing.location?.coordinates?.length !== 2) {
		reasons.push("We could not find this address on the map. Check the street address and postcode.");
	}
	for (const [field, label] of [["gasSafetyExpiry", "gas safety certificate"], ["eicrExpiry", "electrical safety report (EICR)"]] as const) {
		const expiry = listing[field];
		if (expiry && new Date(expiry).getTime() < now.getTime()) reasons.push(`Your ${label} has expired. Renew it and update the expiry date.`);
	}
	if (typeof listing.monthlyRent === "number") {
		const perPerson = listing.monthlyRent / Math.max(1, listing.numOfPeople ?? 1);
		if (perPerson < RENT_PER_PERSON.min || perPerson > RENT_PER_PERSON.max) {
			reasons.push(`Rent works out at £${Math.round(perPerson)} per person per month. Check the monthly rent is for the whole property and the number of tenants is right.`);
		}
	}
	if ((listing.photos?.length ?? 0) < 3) reasons.push("Add at least 3 photos.");
	// Contact or payment details let a scammer take students off the platform. Amenities are free text shown to students too.
	const unsafe = unsafeListingDetail([listing.propertyTitle, listing.propertyDesc, ...(listing.amenities ?? [])].filter(Boolean).join("\n"));
	if (unsafe) {
		reasons.push(`Remove phone numbers, e-mail addresses, links and bank details from the title, description and amenities (we found "${unsafe.slice(0, 60)}"): students contact you and pay through Seek.`);
	}
	if (OFF_PLATFORM_PAYMENT.test([listing.propertyTitle, listing.propertyDesc].filter(Boolean).join("\n"))) {
		reasons.push("Remove any request to pay rent, deposits or fees outside Seek, or before a viewing (wire transfers, gift cards, crypto): students pay through Seek.");
	}
	return reasons;
}

@Injectable()
export class ListingModerationService implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(ListingModerationService.name);
	private interval?: NodeJS.Timeout;
	private running = false;

	constructor(
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		private readonly gateway: ListingsGateway,
		private readonly config: ConfigService,
		@Optional() private readonly notifications?: NotificationsService,
		@Optional() @InjectModel(User.name) private readonly userModel?: Model<User>
	) {}

	/** Re-decides listings left PENDING (by the old AI check) and the old admin queue (never checked). Disabled under NODE_ENV=test. */
	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		this.interval = setInterval(() => void this.retryPending(), RETRY_MS);
		this.interval.unref();
	}

	onModuleDestroy() {
		if (this.interval) clearInterval(this.interval);
	}

	async retryPending(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			const pending = await this.listingModel
				.find({ isDraft: false, isVerified: false, moderationStatus: { $in: [ModerationStatus.PENDING, null] } })
				.select("_id")
				.sort({ moderatedAt: 1 })
				.limit(RETRY_BATCH)
				.lean()
				.exec();
			for (const { _id } of pending) await this.moderate(_id);
		} catch (error) {
			this.logger.error(`Listing moderation retry failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}

	/**
	 * Checks a published listing against the rules only (no AI) and sets isVerified.
	 */
	async moderate(listingId: Types.ObjectId | string): Promise<Listing | null> {
		const listing = await this.listingModel.findById(listingId).lean().exec();
		if (!listing || listing.isDraft) return null;
		const key = this.config.get<string>("GOOGLE_GEOCODING_API_KEY");
		const reasons = listingRuleFailures(listing, new Date(), Boolean(key && key !== "local-placeholder"));
		// A suspended landlord's listing never goes back online, whoever edited it.
		if (await this.userModel?.exists({ _id: listing.landlord, suspendedAt: { $ne: null } }).exec()) reasons.unshift("This account is suspended.");
		const status = reasons.length ? ModerationStatus.NEEDS_CHANGES : ModerationStatus.APPROVED;
		// Only if nothing changed since it was read: a newer edit runs its own check.
		const updated = await this.listingModel.findOneAndUpdate(
			{ _id: listing._id, isDraft: false, ...(listing.lastUpdated ? { lastUpdated: listing.lastUpdated } : {}) },
			{ $set: { isVerified: status === ModerationStatus.APPROVED, moderationStatus: status, moderationReasons: reasons, moderatedAt: new Date() } },
			{ new: true }
		).exec();
		if (!updated) return null;
		this.gateway.emitListingUpdated(updated);
		if (status === ModerationStatus.NEEDS_CHANGES) {
			await this.notifications?.notify({
				user: listing.landlord,
				kind: NotificationKind.LISTING_NEEDS_CHANGES,
				title: `${listing.propertyTitle || "Your listing"} needs changes before it goes live`,
				body: reasons.join(" "),
				link: "/listings",
				dedupeKey: `listing-moderation:${listing._id.toString()}:${new Date(listing.lastUpdated ?? 0).getTime()}`
			});
		}
		return updated;
	}
}
