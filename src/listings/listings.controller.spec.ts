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

	it("publishes even when the admin email fails, and sends it after publishing", async () => {
		const order: string[] = [];
		const listingsService = {
			getCoordinates: jest.fn().mockResolvedValue(null),
			updateDraft: jest.fn().mockResolvedValue({}),
			publishDraft: jest.fn(async () => { order.push("publish"); return { _id: "l1", isDraft: false }; })
		} as unknown as ListingsService;
		const mailService = {
			sendNewListingEmail: jest.fn(async () => { order.push("email"); throw new Error("Mailgun 401"); })
		} as unknown as MailService;
		const controller = new ListingsController(listingsService, mailService);
		jest.spyOn((controller as any).logger, "error").mockImplementation(() => undefined);

		await expect(controller.publish({} as never, "l1", {} as never)).resolves.toEqual({ _id: "l1", isDraft: false });
		expect(order).toEqual(["publish", "email"]);
	});
});
