import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { ThrottlerStorage } from "@nestjs/throttler";
import { Model, Types } from "mongoose";
import { Listing } from "./listings.schema";
import { User } from "../users/users.schema";
import { ListingsGateway } from "./listings.gateway";
import { ModerationStatus } from "./enums/moderation-status.enum";
import { LlmClient } from "../ai/llm.client";
import { UNTRUSTED_DATA_RULE } from "../ai/ai.service";
import { AI_USER_LIMITS } from "../ai/ai.controller";
import { extractJsonObject } from "../ai/search-parser";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";

const RETRY_MS = 15 * 60 * 1000;
const RETRY_BATCH = 25;
/** About 1.5 hours of failed AI tries (sweep every 15 min), then the landlord is told what to do instead of waiting forever. */
export const MAX_MODERATION_ATTEMPTS = 6;
const COULD_NOT_CHECK = "We couldn't check this listing automatically. Edit the title and description and resubmit it.";

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
	return reasons;
}

/** The model only picks from these codes, so its answer can never inject text the landlord sees. */
const SCAM_SIGNALS: Record<string, string> = {
	PAYMENT_OUTSIDE_SEEK: "Remove any request to pay rent, deposits or fees outside Seek.",
	WIRE_OR_CRYPTO: "Remove any mention of wire transfers, money transfer services, gift cards or crypto.",
	CONTACT_BYPASS: "Remove any request to contact you outside Seek (WhatsApp, phone, e-mail, social media).",
	INAPPROPRIATE: "Remove offensive, discriminatory or adult content from the title and description."
};

const SCAM_PROMPT =
	"You check UK student-housing listings for a renting app. Given the listing title, description and amenities, return the codes that clearly apply: " +
	"PAYMENT_OUTSIDE_SEEK (asks for rent, deposit or fees paid outside the app, or before a viewing), " +
	"WIRE_OR_CRYPTO (wire transfer, Western Union, MoneyGram, gift cards, cryptocurrency), " +
	"CONTACT_BYPASS (asks students to contact the landlord off the platform), " +
	"INAPPROPRIATE (offensive, discriminatory, sexual or unrelated content). " +
	'Ordinary listing details are fine. Answer with JSON only: {"signals": string[]} (empty when none apply).';

@Injectable()
export class ListingModerationService implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(ListingModerationService.name);
	private interval?: NodeJS.Timeout;
	private running = false;

	constructor(
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		private readonly gateway: ListingsGateway,
		private readonly config: ConfigService,
		private readonly llm: LlmClient,
		@Optional() private readonly notifications?: NotificationsService,
		@Optional() @Inject(ThrottlerStorage) private readonly storage?: ThrottlerStorage,
		@Optional() @InjectModel(User.name) private readonly userModel?: Model<User>
	) {}

	/** Retries listings the AI could not check, and the old admin queue (never checked). Disabled under NODE_ENV=test. */
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
				.select("_id landlord")
				// Least recently checked first, so listings the AI keeps failing on cannot starve the rest.
				.sort({ moderatedAt: 1 })
				.limit(RETRY_BATCH)
				.lean()
				.exec();
			// The landlord's Seek AI quota pays for retries too, so publishing past the quota gets no free checks.
			for (const { _id, landlord } of pending) await this.moderate(_id, landlord?.toString());
		} catch (error) {
			this.logger.error(`Listing moderation retry failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}

	/**
	 * Checks a published listing and sets isVerified. `actor` is the landlord
	 * whose Seek AI quota pays for the check; the sweeper passes none.
	 */
	async moderate(listingId: Types.ObjectId | string, actor?: string): Promise<Listing | null> {
		const listing = await this.listingModel.findById(listingId).lean().exec();
		if (!listing || listing.isDraft) return null;
		const key = this.config.get<string>("GOOGLE_GEOCODING_API_KEY");
		const reasons = listingRuleFailures(listing, new Date(), Boolean(key && key !== "local-placeholder"));
		// A suspended landlord's listing never goes back online, whoever edited it.
		if (await this.userModel?.exists({ _id: listing.landlord, suspendedAt: { $ne: null } }).exec()) reasons.unshift("This account is suspended.");
		let status = reasons.length ? ModerationStatus.NEEDS_CHANGES : ModerationStatus.APPROVED;
		let failedTry = false;
		if (!reasons.length) {
			// Over quota: wait for the sweeper, without using up a try.
			const overQuota = actor && this.llm.isConfigured() && !(await withinAiQuota(this.storage, actor));
			const signals = overQuota ? null : await this.scamSignals(listing);
			if (signals === null) {
				failedTry = !overQuota;
				status = ModerationStatus.PENDING;
				if (failedTry && (listing.moderationAttempts ?? 0) + 1 >= MAX_MODERATION_ATTEMPTS) {
					reasons.push(COULD_NOT_CHECK);
					status = ModerationStatus.NEEDS_CHANGES;
				}
			} else if (signals.length) {
				reasons.push(...signals);
				status = ModerationStatus.NEEDS_CHANGES;
			}
		}
		// Only if nothing changed since it was read: a newer edit runs its own check.
		const updated = await this.listingModel.findOneAndUpdate(
			{ _id: listing._id, isDraft: false, ...(listing.lastUpdated ? { lastUpdated: listing.lastUpdated } : {}) },
			{
				$set: { isVerified: status === ModerationStatus.APPROVED, moderationStatus: status, moderationReasons: reasons, moderatedAt: new Date() },
				...(failedTry ? { $inc: { moderationAttempts: 1 } } : {})
			},
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

	/** Messages for the scam signals found; [] when clean or no AI is configured; null when it must be retried. */
	private async scamSignals(listing: Listing): Promise<string[] | null> {
		// Without any AI key (local development only: main.ts refuses to start production without one) the rules alone decide.
		if (!this.llm.isConfigured()) return [];
		const answer = await this.llm.complete({
			system: SCAM_PROMPT + UNTRUSTED_DATA_RULE,
			messages: [{ role: "user", content: JSON.stringify({ title: listing.propertyTitle ?? "", description: (listing.propertyDesc ?? "").slice(0, 6000), amenities: (listing.amenities ?? []).slice(0, 50) }) }],
			maxTokens: 100,
			responseSchema: { type: "OBJECT", properties: { signals: { type: "ARRAY", items: { type: "STRING" } } }, required: ["signals"] }
		});
		if (!answer) return null;
		const parsed = extractJsonObject(answer.text) as { signals?: unknown } | null;
		if (!Array.isArray(parsed?.signals)) return null;
		return [...new Set(parsed.signals.filter((code): code is string => typeof code === "string" && Object.prototype.hasOwnProperty.call(SCAM_SIGNALS, code)))].map(code => SCAM_SIGNALS[code]);
	}
}
