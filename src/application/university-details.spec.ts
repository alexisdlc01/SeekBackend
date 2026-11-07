import { parseUniversityDetails } from "./university-details";

describe("parseUniversityDetails", () => {
	it("splits course, university and year", () => {
		expect(parseUniversityDetails("BSc Computer Science, University of Bristol, Year 2")).toEqual({
			text: "BSc Computer Science, University of Bristol, Year 2",
			course: "BSc Computer Science",
			university: "University of Bristol",
			year: "2"
		});
	});

	it("understands ordinal and final years", () => {
		expect(parseUniversityDetails("Law - UWE Bristol - 3rd year")?.year).toBe("3");
		expect(parseUniversityDetails("Nursing, University of Bath, final year")?.year).toBe("Final");
	});

	it("keeps the raw text when nothing matches, and returns null when empty", () => {
		expect(parseUniversityDetails("Bristol")).toEqual({ text: "Bristol", course: "Bristol" });
		expect(parseUniversityDetails("  ")).toBeNull();
		expect(parseUniversityDetails(undefined)).toBeNull();
	});
});
