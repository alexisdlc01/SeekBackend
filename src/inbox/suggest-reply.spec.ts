import { suggestReply } from "./suggest-reply";
import { EmailCategory } from "./email-category.enum";

describe("suggestReply", () => {
	it("treats a heating failure as urgent for the landlord", () => {
		const reply = suggestReply({ text: "Heating has stopped\nThe boiler is off since last night", fromName: "Maya Rahman", landlord: true });
		expect(reply).toMatch(/^Hi Maya,/);
		expect(reply).toMatch(/within 24 hours/);
	});

	it("uses the category when there is no repair", () => {
		expect(suggestReply({ text: "Your October statement", category: EmailCategory.BILLS, fromName: "Octopus Energy", landlord: false })).toBe(
			"Hi, thanks, I've added this bill to Seek so the household can split it."
		);
		expect(suggestReply({ text: "hello", fromName: "lettings@example.com", landlord: false })).toBe("Hello, thanks for your message.");
	});

	it("does not take an organisation's first word as a first name", () => {
		expect(suggestReply({ text: "Your deposit is protected", category: EmailCategory.DEPOSIT, fromName: "Deposit Protection Service", landlord: false })).toMatch(/^Hello,/);
		expect(suggestReply({ text: "hello", fromName: "Tom Ellis", landlord: false })).toMatch(/^Hi Tom,/);
	});
});
