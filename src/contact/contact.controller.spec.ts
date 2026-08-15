import { ContactController } from "./contact.controller";
import { ContactService } from "./contact.service";

describe("ContactController", () => {
	it("waits for the contact service", async () => {
		const contactService = {
			contact: jest.fn().mockResolvedValue(undefined)
		} as unknown as ContactService;
		const controller = new ContactController(contactService);
		const body = {
			name: "Ada",
			email: "ada@example.com",
			message: "Hello"
		};

		await controller.contact(body);
		expect(contactService.contact).toHaveBeenCalledWith(body);
	});
});
