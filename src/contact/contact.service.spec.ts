import { MailService } from "../auth/mail.service";
import { ContactService } from "./contact.service";

describe("ContactService", () => {
	it("forwards a contact request to the mail service", async () => {
		const mailService = {
			sendContactEmail: jest.fn().mockResolvedValue(undefined)
		} as unknown as MailService;
		const service = new ContactService(mailService);

		await service.contact({
			name: "Ada",
			email: "ada@example.com",
			message: "Hello"
		});
		expect(mailService.sendContactEmail).toHaveBeenCalledWith(
			"Ada",
			"ada@example.com",
			"Hello"
		);
	});
});
