import {
	describeFilters,
	extractJsonObject,
	parseBillsIncluded,
	parseConversation,
	parseMaxRent,
	parseMinBedrooms,
	parseMoveIn,
	parseSearchText,
	sanitizeFilters
} from "./search-parser";

const NOW = new Date("2026-11-06T12:00:00Z");

describe("rule-based search parser", () => {
	it("parses the design example end to end", () => {
		expect(parseSearchText("2-bed near Bristol uni under £700 bills included", NOW)).toEqual({
			city: "Bristol",
			nearUniversity: "University of Bristol",
			maxRent: 700,
			minBedrooms: 2,
			billsIncluded: true
		});
	});

	describe("prices", () => {
		it.each([
			["under £700", 700],
			["under 700", 700],
			["below 650 a month", 650],
			["max £1,200", 1200],
			["£695 pcm", 695],
			["budget of 600", 600],
			["up to £800 per month", 800],
			["£1.2k", 1200]
		])("%s → £%d", (text, expected) => {
			expect(parseMaxRent(text)).toBe(expected);
		});

		it("converts weekly prices to monthly", () => {
			expect(parseMaxRent("under £150 a week")).toBe(650);
			expect(parseMaxRent("£150pw")).toBe(650);
		});

		it("ignores numbers that are not rents", () => {
			expect(parseMaxRent("2-bed for 12 months")).toBeUndefined();
			expect(parseMaxRent("within 10 minutes of campus")).toBeUndefined();
		});
	});

	describe("bedrooms", () => {
		it.each([
			["2-bed flat", 2],
			["2 bed", 2],
			["three bedroom house", 3],
			["4 bedrooms", 4],
			["for 5 of us", 5],
			["a group of 4", 4],
			["a studio", 1]
		])("%s → %d", (text, expected) => {
			expect(parseMinBedrooms(text)).toBe(expected);
		});

		it("does not read durations as bedrooms", () => {
			expect(parseMinBedrooms("for 12 months from September")).toBeUndefined();
		});
	});

	describe("bills", () => {
		it.each([
			["bills included", true],
			["including bills", true],
			["all inclusive", true],
			["inc bills", true],
			["bills not included", false],
			["excluding bills", false],
			["near the park", undefined]
		])("%s → %s", (text, expected) => {
			expect(parseBillsIncluded(text)).toBe(expected);
		});
	});

	describe("places", () => {
		it("finds a city", () => {
			expect(parseSearchText("something in Manchester", NOW)).toEqual({ city: "Manchester" });
		});

		it("maps a university to its city", () => {
			expect(parseSearchText("near UCL", NOW)).toEqual({ city: "London", nearUniversity: "UCL" });
			expect(parseSearchText("close to the University of Edinburgh", NOW)).toEqual({
				city: "Edinburgh",
				nearUniversity: "University of Edinburgh"
			});
		});

		it("does not treat ordinary words as towns", () => {
			expect(parseSearchText("quiet for reading week, with a bath", NOW)).toEqual({});
		});
	});

	describe("move-in dates", () => {
		it("rolls a past month into next year", () => {
			expect(parseMoveIn("from September", NOW)).toBe("2027-09-01");
		});

		it("keeps an upcoming month in this year", () => {
			expect(parseMoveIn("moving in December", NOW)).toBe("2026-12-01");
		});

		it("reads explicit days and years", () => {
			expect(parseMoveIn("1st of October 2027", NOW)).toBe("2027-10-01");
			expect(parseMoveIn("start 2027-08-15", NOW)).toBe("2027-08-15");
		});

		it("ignores words that only look like months", () => {
			expect(parseMoveIn("decent flat near the market", NOW)).toBeUndefined();
			expect(parseMoveIn("we may want parking", NOW)).toBeUndefined();
		});
	});

	it("lets later messages refine earlier ones", () => {
		const filters = parseConversation(
			[
				{ role: "user", content: "2-bed in Bristol under £700" },
				{ role: "assistant", content: "Here are 3 homes." },
				{ role: "user", content: "actually under £600, bills included" }
			],
			NOW
		);
		expect(filters).toEqual({ city: "Bristol", minBedrooms: 2, maxRent: 600, billsIncluded: true });
	});

	it("drops the old university when the student switches city", () => {
		const filters = parseConversation(
			[
				{ role: "user", content: "near Bristol uni" },
				{ role: "user", content: "what about Leeds instead" }
			],
			NOW
		);
		expect(filters).toEqual({ city: "Leeds" });
	});

	it("describes filters in plain English", () => {
		expect(
			describeFilters({ minBedrooms: 2, nearUniversity: "University of Bristol", maxRent: 700, billsIncluded: true })
		).toBe("2+ bedrooms, near University of Bristol, under £700 a month each, bills included");
	});
});

describe("model output validation", () => {
	it("accepts well-formed filters and canonicalises universities", () => {
		expect(sanitizeFilters({ maxRent: 700, nearUniversity: "bristol uni", billsIncluded: true })).toEqual({
			maxRent: 700,
			nearUniversity: "University of Bristol",
			city: "Bristol",
			billsIncluded: true
		});
	});

	it.each([
		[{ maxRent: "700" }],
		[{ minBedrooms: 2.5 }],
		[{ billsIncluded: "yes" }],
		[{ moveIn: "September" }],
		[{ unexpected: 1 }],
		[[1, 2]],
		["text"]
	])("rejects %j", raw => {
		expect(sanitizeFilters(raw)).toBeNull();
	});

	it("extracts JSON from fenced answers", () => {
		expect(extractJsonObject('```json\n{"reply":"Hi","filters":{}}\n```')).toEqual({ reply: "Hi", filters: {} });
		expect(extractJsonObject("no json here")).toBeNull();
	});
});

describe("sanitizeFilters model debris", () => {
	it("drops a nearUniversity that is not a name", () => {
		expect(sanitizeFilters({ nearUniversity: ": null,", city: "Bristol" })).toEqual({ city: "Bristol" });
		expect(sanitizeFilters({ nearUniversity: "null" })).toEqual({});
	});
});

describe("Bristol and Cardiff areas", () => {
	it("reads the live-test request", () => {
		expect(parseSearchText("2-bed in Cotham under £700 bills included", NOW)).toEqual({
			area: "Cotham",
			city: "Bristol",
			minBedrooms: 2,
			maxRent: 700,
			billsIncluded: true
		});
	});

	it.each([
		["Clifton", "Bristol"], ["Cotham", "Bristol"], ["Redland", "Bristol"], ["Kingsdown", "Bristol"],
		["Bishopston", "Bristol"], ["Stokes Croft", "Bristol"], ["Montpelier", "Bristol"], ["Southville", "Bristol"],
		["Bedminster", "Bristol"], ["Hotwells", "Bristol"], ["Cliftonwood", "Bristol"], ["Stoke Bishop", "Bristol"],
		["Cathays", "Cardiff"], ["Roath", "Cardiff"], ["Heath", "Cardiff"], ["Canton", "Cardiff"]
	])("knows %s (%s)", (area, city) => {
		expect(parseSearchText(`a room in ${area}`, NOW)).toMatchObject({ area, city });
	});

	it("tells St Andrews in Bristol from the Scottish town", () => {
		expect(parseSearchText("near St Andrews park in Bristol", NOW)).toMatchObject({ area: "St Andrews", city: "Bristol" });
		expect(parseSearchText("a flat in St Andrews", NOW)).toEqual({ city: "St Andrews" });
	});

	it("does not read ordinary words as areas", () => {
		expect(parseSearchText("near the heath, with central heating", NOW).area).toBeUndefined();
	});

	it("canonicalises an area from the model and sets its city", () => {
		expect(sanitizeFilters({ area: "cathays" })).toEqual({ area: "Cathays", city: "Cardiff" });
		expect(describeFilters({ area: "Cotham", city: "Bristol", maxRent: 700 })).toBe("in Cotham, Bristol, under £700 a month each");
	});
});
