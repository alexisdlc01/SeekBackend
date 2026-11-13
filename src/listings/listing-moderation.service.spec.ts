import { Types } from "mongoose";
import { ListingModerationService, listingRuleFailures, unsafeListingDetail, withinAiQuota } from "./listing-moderation.service";
import { ModerationStatus } from "./enums/moderation-status.enum";

const NOW = new Date("2026-11-12T12:00:00Z");

function goodListing(overrides: Record<string, unknown> = {}) {
	return {
		_id: new Types.ObjectId(),
		landlord: new Types.ObjectId(),
		isDraft: false,
		isVerified: false,
		lastUpdated: new Date("2026-11-12T11:00:00Z"),
		propertyTitle: "Bright 3-bed flat on Market Street",
		propertyDesc: "Five minutes from the Quad, furnished, gas central heating.",
		propertyType: "FLAT",
		streetAddress: "12 Market Street",
		cityTown: "St Andrews",
		postcodeZIP: "KY16 9NS",
		monthlyRent: 1800,
		numOfPeople: 3,
		bedroomsCount: 3,
		availableFrom: new Date("2027-09-01"),
		photos: ["a.jpg", "b.jpg", "c.jpg"],
		location: { type: "Point", coordinates: [-2.79, 56.34] },
		gasSafetyExpiry: new Date("2027-06-01"),
		eicrExpiry: new Date("2029-01-01"),
		...overrides
	};
}

describe("listingRuleFailures", () => {
	it("passes a complete listing", () => {
		expect(listingRuleFailures(goodListing() as never, NOW, true)).toEqual([]);
	});

	it("says what to fix for each failed rule", () => {
		const reasons = listingRuleFailures(goodListing({
			propertyDesc: "",
			postcodeZIP: undefined,
			location: undefined,
			gasSafetyExpiry: new Date("2026-01-01"),
			monthlyRent: 15000,
			numOfPeople: 3,
			photos: ["a.jpg"]
		}) as never, NOW, true);
		expect(reasons).toEqual([
			"Add the missing details: description, postcode.",
			expect.stringContaining("could not find this address"),
			expect.stringContaining("gas safety certificate has expired"),
			expect.stringContaining("£5000 per person"),
			"Add at least 3 photos."
		]);
	});

	it("skips the map check without a geocoding key and flags contact details in the text", () => {
		const reasons = listingRuleFailures(goodListing({ location: undefined, propertyDesc: "WhatsApp me on 07700 900123" }) as never, NOW, false);
		expect(reasons).toEqual([expect.stringContaining('Remove phone numbers, e-mail addresses, links and bank details from the title, description and amenities (we found "07700 900123")')]);
	});

	it("checks the free-text amenities students see, not only the title and description", () => {
		const reasons = listingRuleFailures(goodListing({ amenities: ["Wifi", "Deposit by transfer 12-34-56"] }) as never, NOW, true);
		expect(reasons).toEqual([expect.stringContaining('"12-34-56"')]);
	});
});

describe("unsafeListingDetail", () => {
	it("passes honest text: a missing space after a full stop, and dd/mm/yy dates", () => {
		expect(unsafeListingDetail("Close to campus.Bills included")).toBeNull();
		expect(unsafeListingDetail("Available from 01/09/26 or 01.09.26, 1 Sept 2026, rent £1,800")).toBeNull();
		expect(unsafeListingDetail("Five minutes from the Quad. Postcode KY16 9NS.")).toBeNull();
		expect(unsafeListingDetail("Available for the 2026-2027 academic year, £1200-1500 a month")).toBeNull();
		expect(unsafeListingDetail("Call 0207-946-0000")).toBe("0207-946-0000");
		expect(unsafeListingDetail("Flat in SE15 with easy tube link")).toBeNull();
		expect(unsafeListingDetail("Located in LS12 near main road and park")).toBeNull();
	});

	it("only flags UK phone formats, not years, spaced dates or sizes", () => {
		expect(unsafeListingDetail("Tenancy for the 2026 2027 academic year")).toBeNull();
		expect(unsafeListingDetail("Available 01 09 2026")).toBeNull();
		expect(unsafeListingDetail("Rooms: 12 14 16 18 sq m")).toBeNull();
		expect(unsafeListingDetail("Text +44 7700-900123")).toBe("+44 7700-900123");
		expect(unsafeListingDetail("Ring 0044 7700 900123")).toBe("0044 7700 900123");
		expect(unsafeListingDetail("Office (020) 7946 0000")).toBe("(020) 7946 0000");
		expect(unsafeListingDetail("Call 07700.900.123")).toBe("07700.900.123");
		expect(unsafeListingDetail("Available 01.09.2026 - 30.06.2027")).toBeNull();
		expect(unsafeListingDetail("Tenancy 01.09.26 - 30.06.27")).toBeNull();
	});

	it("catches phones, e-mails, links, sort codes and IBANs", () => {
		expect(unsafeListingDetail("WhatsApp 07700 900123 to view")).toBe("07700 900123");
		expect(unsafeListingDetail("mail me: jo@example.com")).toBe("jo@example.com");
		expect(unsafeListingDetail("see www.myflat.example")).toBe("www.myflat.example");
		expect(unsafeListingDetail("photos at myflat.co.uk")).toBe("myflat.co.uk");
		expect(unsafeListingDetail("sort code 12-34-56")).toBe("12-34-56");
		expect(unsafeListingDetail("pay to 20 45 99")).toBe("20 45 99");
		expect(unsafeListingDetail("IBAN GB29 NWBK 6016 1331 9268 19")).toMatch(/^GB29 NWBK/);
		expect(unsafeListingDetail("iban gb29 nwbk 6016 1331 9268 19")).toMatch(/^gb29 nwbk/);
	});
});

describe("withinAiQuota", () => {
	it("reports blocked when the shared Seek AI quota is used up", async () => {
		const storage = { increment: jest.fn().mockResolvedValue({ isBlocked: true }) };
		await expect(withinAiQuota(storage as never, "u1")).resolves.toBe(false);
		expect(storage.increment).toHaveBeenCalledWith("ai-min:u1", 60_000, 10, 60_000, "ai-min");
	});
});

describe("scam rule", () => {
	it("flags off-platform payment asks, not an ordinary bank transfer", () => {
		const flagged = listingRuleFailures(goodListing({ propertyDesc: "Pay the deposit before the viewing by Western Union." }) as never, NOW, true);
		expect(flagged).toEqual([expect.stringContaining("outside Seek")]);
		expect(listingRuleFailures(goodListing({ amenities: ["western union"] }) as never, NOW, true)).toEqual([expect.stringContaining("outside Seek")]);
		expect(listingRuleFailures(goodListing({ propertyDesc: "Pay in bit\u200bcoin or b.i.t.c.o.i.n or western-union" }) as never, NOW, true)).toEqual([expect.stringContaining("outside Seek")]);
		expect(listingRuleFailures(goodListing({ propertyDesc: "Bank transfer accepted for rent, paid monthly through Seek." }) as never, NOW, true)).toEqual([]);
	});
});

describe("ListingModerationService.moderate", () => {
	function setup(listing: Record<string, unknown>) {
		const listingModel = {
			findById: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue(listing) }) }),
			findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ ...listing }) })
		};
		const config = { get: jest.fn((key: string) => (key === "GOOGLE_GEOCODING_API_KEY" ? "real-key" : undefined)) };
		const notifications = { notify: jest.fn().mockResolvedValue(true) };
		const service = new ListingModerationService(listingModel as never, { emitListingUpdated: jest.fn() } as never, config as never, notifications as never);
		return { service, notifications, written: () => listingModel.findOneAndUpdate.mock.calls[0] };
	}

	it("approves a clean listing by the rules alone and guards the write on lastUpdated", async () => {
		const listing = goodListing();
		const { service, written } = setup(listing);
		await service.moderate(listing._id);
		const [filter, update] = written();
		expect(filter).toEqual({ _id: listing._id, isDraft: false, lastUpdated: listing.lastUpdated });
		expect(update.$set).toEqual(expect.objectContaining({ isVerified: true, moderationStatus: ModerationStatus.APPROVED, moderationReasons: [] }));
	});

	it("sends a failing listing back to the landlord, never PENDING", async () => {
		const listing = goodListing({ photos: [] });
		const { service, written, notifications } = setup(listing);
		await service.moderate(listing._id);
		expect(written()[1].$set).toEqual(expect.objectContaining({ isVerified: false, moderationStatus: ModerationStatus.NEEDS_CHANGES, moderationReasons: ["Add at least 3 photos."] }));
		expect(notifications.notify).toHaveBeenCalledWith(expect.objectContaining({ user: listing.landlord, kind: "LISTING_NEEDS_CHANGES" }));
	});

	it("retries every pending or never-checked live listing", async () => {
		const ids = [new Types.ObjectId(), new Types.ObjectId()];
		const sort = jest.fn().mockReturnValue({ limit: () => ({ lean: () => ({ exec: jest.fn().mockResolvedValue(ids.map(_id => ({ _id }))) }) }) });
		const find = jest.fn().mockReturnValue({ select: () => ({ sort }) });
		const service = new ListingModerationService({ find } as never, {} as never, {} as never);
		const moderate = jest.spyOn(service, "moderate").mockResolvedValue(null);
		await service.retryPending();
		expect(find).toHaveBeenCalledWith({ isDraft: false, isVerified: false, moderationStatus: { $in: [ModerationStatus.PENDING, null] } });
		expect(moderate.mock.calls.map(call => call[0])).toEqual(ids);
		expect(sort).toHaveBeenCalledWith({ moderatedAt: 1 });
	});

	it("keeps a suspended landlord's listing offline even when it passes every check", async () => {
		const listing = goodListing();
		const listingModel = {
			findById: jest.fn().mockReturnValue({ lean: () => ({ exec: jest.fn().mockResolvedValue(listing) }) }),
			findOneAndUpdate: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(listing) })
		};
		const userModel = { exists: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue({ _id: "landlord" }) }) };
		const config = { get: jest.fn((key: string) => (key === "GOOGLE_GEOCODING_API_KEY" ? "real-key" : undefined)) };
		const service = new ListingModerationService(listingModel as never, { emitListingUpdated: jest.fn() } as never, config as never, undefined, userModel as never);
		await service.moderate(listing._id);
		const $set = listingModel.findOneAndUpdate.mock.calls[0][1].$set;
		expect($set).toEqual(expect.objectContaining({ isVerified: false, moderationStatus: ModerationStatus.NEEDS_CHANGES }));
		expect($set.moderationReasons[0]).toBe("This account is suspended.");
	});
});
