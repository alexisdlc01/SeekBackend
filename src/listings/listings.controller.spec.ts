import { ListingsController } from "./listings.controller";
import { ListingsService } from "./listings.service";
import { MailService } from "../auth/mail.service";

describe("ListingsController", () => {
	it("delegates the public listing feed to the published-listing query", async () => {
		const listingsService = {
			getAllVerifiedListings: jest.fn().mockResolvedValue([])
		} as unknown as ListingsService;
		const controller = new ListingsController(
			listingsService,
			{} as MailService
		);

		await expect(controller.getAllVerifiedListings()).resolves.toEqual([]);
		expect(listingsService.getAllVerifiedListings).toHaveBeenCalledTimes(1);
	});
});
