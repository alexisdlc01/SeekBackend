import { DocumentType } from "../users/types/document-type";
import { GuarantorCriterion } from "../listings/enums/guarantor-criterion.enum";
import { missingDocuments, requiredDocuments } from "./required-documents";

describe("requiredDocuments", () => {
	const requirements = [
		{ name: "Passport", desc: "", required: true },
		{ name: "Guarantor", desc: "UK guarantor", required: true },
		{ name: "Character reference", desc: "", required: false },
	];

	it("follows the listing's required items, aliases included", () => {
		expect(requiredDocuments({ requirements, criteria: { guarantor: GuarantorCriterion.UK_ONLY } })).toEqual([
			{ label: "Identification", types: [DocumentType.IDENTIFICATION, DocumentType.PASSPORT] },
			{ label: "Guarantor agreement", types: [DocumentType.GUARANTOR_AGREEMENT] },
		]);
	});

	it("drops the guarantor when the criterion says none is needed", () => {
		const listing = { requirements, criteria: { guarantor: GuarantorCriterion.NONE } };
		expect(requiredDocuments(listing).map(document => document.label)).toEqual(["Identification"]);
		expect(missingDocuments(listing, [DocumentType.PASSPORT])).toEqual([]);
	});

	it("lists what the applicant has not uploaded", () => {
		expect(missingDocuments({ requirements }, [DocumentType.IDENTIFICATION])).toEqual(["Guarantor agreement"]);
	});
});
