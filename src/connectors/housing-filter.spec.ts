import { EmailCategory } from "../inbox/email-category.enum";
import { TenancyDocumentType } from "../tenancies/tenancy.enums";
import { BillCategory } from "../bills/bill.schema";
import {
	HousingContact,
	billCategoryFor,
	classifyEmail,
	documentTypeFor,
	looksLikeBill,
	parseAddress,
	parseAddressList,
	parseAmountPence,
	threadKeyFor
} from "./housing-filter";

const james: HousingContact = {
	email: "james@holloway-lets.co.uk",
	name: "James Holloway",
	role: "LANDLORD",
	userId: "665000000000000000000010",
	tenancyId: "665000000000000000000601",
	conversationId: "665000000000000000000211"
};
const contacts = new Map([[james.email, james]]);

const incoming = (from: string, subject: string, fromName = "") => ({
	from,
	fromName,
	to: ["maya.rahman@gmail.com"],
	subject,
	outgoing: false
});

describe("housing email filter", () => {
	it("files mail from a known landlord under LANDLORD", () => {
		const result = classifyEmail(incoming("James@Holloway-Lets.co.uk", "Re: boiler"), contacts);
		expect(result).toMatchObject({ housing: true, category: EmailCategory.LANDLORD, counterpartName: "James Holloway" });
		expect(result.contact?.conversationId).toBe(james.conversationId);
	});

	it("matches outgoing mail on the recipient", () => {
		const result = classifyEmail(
			{ from: "maya.rahman@gmail.com", to: ["james@holloway-lets.co.uk"], subject: "Hello", outgoing: true },
			contacts
		);
		expect(result.category).toBe(EmailCategory.LANDLORD);
	});

	it.each([
		["noreply@depositprotection.com", "Your deposit is protected", EmailCategory.DEPOSIT],
		["hello@octopus.energy", "Your October statement", EmailCategory.BILLS],
		["billing@mail.bt.com", "Your bill is ready", EmailCategory.BILLS],
		["studentservices@bristol.ac.uk", "Council tax exemption certificate", EmailCategory.UNIVERSITY],
		["counciltax@bristol.gov.uk", "Your council tax bill", EmailCategory.BILLS],
		["hello@housinghand.co.uk", "Your guarantor application", EmailCategory.OTHER],
		["someone@example.com", "Viewing on Thursday", EmailCategory.OTHER]
	])("keeps %s (%s)", (from, subject, category) => {
		expect(classifyEmail(incoming(from, subject), contacts)).toMatchObject({ housing: true, category });
	});

	it("names known universities and schemes", () => {
		expect(classifyEmail(incoming("studentservices@bristol.ac.uk", "Council tax exemption"), contacts).counterpartName)
			.toBe("University of Bristol");
		expect(classifyEmail(incoming("noreply@depositprotection.com", "Certificate"), contacts).counterpartName)
			.toBe("Deposit Protection Service");
	});

	it.each([
		["no-reply@spotify.com", "Your Wrapped is here"],
		["lectures@bristol.ac.uk", "Week 6 reading list"],
		["friend@gmail.com", "Drinks on Friday?"]
	])("drops non-housing mail from %s", (from, subject) => {
		expect(classifyEmail(incoming(from, subject), contacts).housing).toBe(false);
	});

	it("does not match look-alike domains", () => {
		expect(classifyEmail(incoming("x@notoctopus.energy.example.com", "Hi"), contacts).housing).toBe(false);
	});
});

describe("attachment filing", () => {
	it.each([
		["Gas-safety-2026.pdf", "", TenancyDocumentType.GAS_SAFETY],
		["DPS-certificate.pdf", "", TenancyDocumentType.DEPOSIT_CERTIFICATE],
		["Council-tax-exemption.pdf", "", TenancyDocumentType.COUNCIL_TAX_EXEMPTION],
		["Tenancy-agreement.pdf", "", TenancyDocumentType.TENANCY_AGREEMENT],
		["EPC.pdf", "", TenancyDocumentType.EPC],
		["scan.pdf", "Your CP12 for 14 Cotham Grove", TenancyDocumentType.GAS_SAFETY]
	])("%s → %s", (name, subject, type) => {
		expect(documentTypeFor(name, subject)).toBe(type);
	});

	it("leaves unrelated files alone", () => {
		expect(documentTypeFor("Statement-Oct.pdf", "Your October statement")).toBeNull();
		expect(documentTypeFor("photo.jpg", "Boiler")).toBeNull();
	});

	it("spots bills and their category", () => {
		expect(looksLikeBill("Statement-Oct.pdf", "")).toBe(true);
		expect(looksLikeBill("Gas-safety-2026.pdf", "Boiler")).toBe(false);
		expect(billCategoryFor("hello@octopus.energy", "")).toBe(BillCategory.ENERGY);
		expect(billCategoryFor("x@bristol.gov.uk", "Council tax bill")).toBe(BillCategory.COUNCIL_TAX);
	});

	it("reads amounts in pence", () => {
		expect(parseAmountPence("Total to pay: £214.00 by 1 Dec")).toBe(21400);
		expect(parseAmountPence("Amount due £1,042.50")).toBe(104250);
		expect(parseAmountPence("Usage: 312 kWh, balance £48.20")).toBe(4820);
		expect(parseAmountPence("Amount due £1050.20")).toBe(105020);
		expect(parseAmountPence("Total £85.4")).toBe(8540);
		expect(parseAmountPence("Total £1,042.50, due 1 Dec")).toBe(104250);
		expect(parseAmountPence("Your bill is £1050.20 this quarter")).toBe(105020);
		expect(parseAmountPence("No money here")).toBeNull();
	});
});

describe("address helpers", () => {
	it("parses names and lists", () => {
		expect(parseAddress('"Holloway, James" <James@Holloway-Lets.co.uk>')).toEqual({
			name: "Holloway, James",
			email: "james@holloway-lets.co.uk"
		});
		expect(parseAddressList('"Holloway, James" <james@holloway-lets.co.uk>, tom@example.com')).toEqual([
			"james@holloway-lets.co.uk",
			"tom@example.com"
		]);
	});

	it("derives a stable thread key", () => {
		expect(threadKeyFor("c1", "t1")).toBe(threadKeyFor("c1", "t1"));
		expect(threadKeyFor("c1", "t1")).not.toBe(threadKeyFor("c2", "t1"));
		expect(threadKeyFor("c1", "t1")).toHaveLength(24);
	});
});
