import { DocumentStatus, DocumentType } from "../users/types/document-type";
import { GuarantorCriterion } from "../listings/enums/guarantor-criterion.enum";
import { compareForLandlord, householdReadiness } from "./readiness";

const ready = {
	documents: [DocumentType.PASSPORT, DocumentType.RIGHT_TO_RENT, DocumentType.STUDENT_STATUS, DocumentType.PROOF_OF_FUNDS]
		.map(type => ({ type, status: DocumentStatus.VERIFIED }))
};
const notReady = { documents: [] };

describe("household readiness", () => {
	it("is qualified when everyone is ready and the group fills the property", () => {
		expect(householdReadiness([ready, ready, ready, ready], 4)).toMatchObject({
			readiness: 100, readyMembers: 4, members: 4, qualified: true
		});
	});

	it("is not qualified with a member missing documents or too few people", () => {
		expect(householdReadiness([ready, notReady], 2)).toMatchObject({ readiness: 50, qualified: false });
		expect(householdReadiness([ready, ready], 4)).toMatchObject({ readiness: 100, qualified: false });
		expect(householdReadiness([], 1)).toMatchObject({ readiness: 0, qualified: false });
	});

	it("orders qualified households first, then by when they were sent", () => {
		const list = [
			{ id: "late-qualified", qualified: true, sentAt: new Date("2026-11-05") },
			{ id: "early", qualified: false, sentAt: new Date("2026-11-01") },
			{ id: "early-qualified", qualified: true, sentAt: new Date("2026-11-02") }
		].sort(compareForLandlord);
		expect(list.map(item => item.id)).toEqual(["early-qualified", "late-qualified", "early"]);
	});

	describe("listing criteria", () => {
		const withGuarantor = {
			documents: [...ready.documents, { type: DocumentType.GUARANTOR_AGREEMENT, status: DocumentStatus.VERIFIED }]
		};

		it("reports pass or fail per criterion", () => {
			const result = householdReadiness([withGuarantor, ready], 2, new Date(), {
				guarantor: GuarantorCriterion.UK_ONLY,
				referencesRequired: true,
				maxHousehold: 3
			});
			const byKey = Object.fromEntries(result.criteria.map(c => [c.key, c]));
			expect(byKey.PASSPORTS.passed).toBe(true);
			expect(byKey.GUARANTOR).toMatchObject({ passed: false, detail: "1 of 2 members have a verified guarantor agreement" });
			expect(byKey.REFERENCES.passed).toBe(false);
			expect(byKey.MAX_HOUSEHOLD.passed).toBe(true);
			expect(result.qualified).toBe(false);
		});

		it("qualifies a household that meets every criterion", () => {
			const withReference = {
				documents: [...withGuarantor.documents, { type: DocumentType.LANDLORD_REFERENCE, status: DocumentStatus.VERIFIED }]
			};
			const result = householdReadiness([withReference, withReference], 2, new Date(), {
				guarantor: GuarantorCriterion.UK_OR_SERVICE,
				referencesRequired: true
			});
			expect(result.qualified).toBe(true);
			expect(result.criteria.every(c => c.passed)).toBe(true);
		});

		it("rejects a household above the maximum and ignores NONE for guarantors", () => {
			const result = householdReadiness([ready, ready, ready], 2, new Date(), {
				guarantor: GuarantorCriterion.NONE,
				maxHousehold: 2
			});
			expect(result.criteria.map(c => c.key)).toEqual(["PASSPORTS", "HOUSEHOLD_SIZE", "MAX_HOUSEHOLD"]);
			expect(result.qualified).toBe(false);
		});
	});
});
