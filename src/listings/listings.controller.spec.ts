import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";

describe("ListingsController", () => {
	it("delegates the public listing feed to the published-listing query", async () => {
		const listingsService = {
			getAllVerifiedListings: jest.fn().mockResolvedValue([])
		} as unknown as ListingsService;
		const controller = new ListingsController(listingsService);

		await expect(controller.getAllVerifiedListings()).resolves.toEqual([]);
		expect(listingsService.getAllVerifiedListings).toHaveBeenCalledTimes(1);
	});

	it("publishes and returns the moderated listing, with no admin email", async () => {
		const listingsService = {
			getCoordinates: jest.fn().mockResolvedValue(null),
			updateDraft: jest.fn().mockResolvedValue({}),
			publishDraft: jest.fn().mockResolvedValue({ _id: "l1", isDraft: false })
		} as unknown as ListingsService;
		const moderation = { moderate: jest.fn().mockResolvedValue({ _id: "l1", isDraft: false, isVerified: true }) };
		const controller = new ListingsController(listingsService, moderation as never);

		await expect(controller.publish({ _id: "u1" } as never, "l1", {} as never)).resolves.toEqual({ _id: "l1", isDraft: false, isVerified: true });
		expect(moderation.moderate).toHaveBeenCalledWith("l1", "u1");
	});

	it("republishing an approved listing the update left verified skips the AI check", async () => {
		const live = { _id: "l1", isDraft: false, isVerified: true, moderationStatus: "APPROVED" };
		const listingsService = {
			getCoordinates: jest.fn().mockResolvedValue(null),
			updateDraft: jest.fn().mockResolvedValue({}),
			publishDraft: jest.fn().mockResolvedValue(live)
		} as unknown as ListingsService;
		const moderation = { moderate: jest.fn() };
		const controller = new ListingsController(listingsService, moderation as never);

		await expect(controller.publish({ _id: "u1" } as never, "l1", {} as never)).resolves.toEqual(live);
		expect(moderation.moderate).not.toHaveBeenCalled();
	});

	it("PATCH /listings/verify/:id only re-runs the automatic check, never approves by hand", async () => {
		const listingsService = { findListingById: jest.fn().mockResolvedValue({ _id: "l1", isVerified: false }) } as unknown as ListingsService;
		const moderation = { moderate: jest.fn().mockResolvedValue({ _id: "l1", isVerified: false, moderationStatus: "NEEDS_CHANGES" }) };
		const controller = new ListingsController(listingsService, moderation as never);

		await expect(controller.verifyListing("l1")).resolves.toMatchObject({ isVerified: false });
		expect(moderation.moderate).toHaveBeenCalledWith("l1");
	});
});
