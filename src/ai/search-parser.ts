/**
 * Deterministic natural-language parser for home searches. It is the fallback
 * when no model is configured and the safety net when a model answers with
 * something that is not valid JSON, so it must never throw.
 */

export interface SearchFilters {
	city?: string;
	/** Monthly rent per person, in pounds. */
	maxRent?: number;
	minBedrooms?: number;
	billsIncluded?: boolean;
	/** Canonical university name, e.g. "University of Bristol". */
	nearUniversity?: string;
	/** First day the student wants to move in, YYYY-MM-DD. */
	moveIn?: string;
	/** Neighbourhood, e.g. "Cotham"; matched against the listing text. */
	area?: string;
}

export interface University {
	name: string;
	city: string;
	lat: number;
	lng: number;
	aliases: string[];
}

/** Main campuses of the universities students ask about most. */
export const UNIVERSITIES: University[] = [
	{ name: "University of Bristol", city: "Bristol", lat: 51.4584, lng: -2.603, aliases: ["university of bristol", "bristol university", "bristol uni", "uni of bristol", "uob"] },
	{ name: "UWE Bristol", city: "Bristol", lat: 51.5005, lng: -2.548, aliases: ["uwe", "university of the west of england"] },
	{ name: "UCL", city: "London", lat: 51.5246, lng: -0.134, aliases: ["ucl", "university college london"] },
	{ name: "King's College London", city: "London", lat: 51.5115, lng: -0.116, aliases: ["king's college london", "kings college london", "kcl"] },
	{ name: "Imperial College London", city: "London", lat: 51.4988, lng: -0.1749, aliases: ["imperial college", "imperial"] },
	{ name: "LSE", city: "London", lat: 51.5144, lng: -0.1165, aliases: ["lse", "london school of economics"] },
	{ name: "Queen Mary University of London", city: "London", lat: 51.5241, lng: -0.0404, aliases: ["queen mary", "qmul"] },
	{ name: "University of Manchester", city: "Manchester", lat: 53.4668, lng: -2.2339, aliases: ["university of manchester", "manchester university", "manchester uni", "uni of manchester", "uom"] },
	{ name: "Manchester Metropolitan University", city: "Manchester", lat: 53.4703, lng: -2.2393, aliases: ["manchester met", "mmu"] },
	{ name: "University of Leeds", city: "Leeds", lat: 53.8067, lng: -1.5550, aliases: ["university of leeds", "leeds university", "leeds uni", "uni of leeds"] },
	{ name: "University of Edinburgh", city: "Edinburgh", lat: 55.9445, lng: -3.1892, aliases: ["university of edinburgh", "edinburgh university", "edinburgh uni", "uni of edinburgh"] },
	{ name: "University of Glasgow", city: "Glasgow", lat: 55.8721, lng: -4.2882, aliases: ["university of glasgow", "glasgow university", "glasgow uni", "uni of glasgow"] },
	{ name: "Cardiff University", city: "Cardiff", lat: 51.4866, lng: -3.1789, aliases: ["cardiff university", "cardiff uni", "uni of cardiff"] },
	{ name: "University of St Andrews", city: "St Andrews", lat: 56.3417, lng: -2.7943, aliases: ["university of st andrews", "st andrews university", "st andrews uni"] },
	{ name: "University of Oxford", city: "Oxford", lat: 51.7548, lng: -1.2544, aliases: ["university of oxford", "oxford university", "oxford uni"] },
	{ name: "University of Cambridge", city: "Cambridge", lat: 52.2043, lng: 0.1149, aliases: ["university of cambridge", "cambridge university", "cambridge uni"] },
	{ name: "University of Birmingham", city: "Birmingham", lat: 52.4508, lng: -1.9305, aliases: ["university of birmingham", "birmingham university", "birmingham uni", "uni of birmingham"] },
	{ name: "University of Nottingham", city: "Nottingham", lat: 52.9387, lng: -1.1965, aliases: ["university of nottingham", "nottingham university", "nottingham uni", "uni of nottingham"] },
	{ name: "University of Sheffield", city: "Sheffield", lat: 53.3811, lng: -1.4882, aliases: ["university of sheffield", "sheffield university", "sheffield uni", "uni of sheffield"] },
	{ name: "University of Liverpool", city: "Liverpool", lat: 53.4058, lng: -2.966, aliases: ["university of liverpool", "liverpool university", "liverpool uni", "uni of liverpool"] },
	{ name: "Newcastle University", city: "Newcastle", lat: 54.9799, lng: -1.6146, aliases: ["newcastle university", "newcastle uni"] },
	{ name: "University of Exeter", city: "Exeter", lat: 50.7365, lng: -3.5344, aliases: ["university of exeter", "exeter university", "exeter uni"] },
	{ name: "University of Bath", city: "Bath", lat: 51.3782, lng: -2.3264, aliases: ["university of bath", "bath university", "bath uni"] },
	{ name: "Durham University", city: "Durham", lat: 54.7650, lng: -1.5782, aliases: ["durham university", "durham uni"] },
	{ name: "University of York", city: "York", lat: 53.9461, lng: -1.0517, aliases: ["university of york", "york university", "york uni"] },
	{ name: "University of Warwick", city: "Coventry", lat: 52.3793, lng: -1.5615, aliases: ["university of warwick", "warwick university", "warwick uni", "warwick"] },
	{ name: "University of Southampton", city: "Southampton", lat: 50.9346, lng: -1.3958, aliases: ["university of southampton", "southampton university", "southampton uni"] },
	{ name: "Queen's University Belfast", city: "Belfast", lat: 54.5844, lng: -5.9342, aliases: ["queen's university belfast", "queens university belfast", "qub"] }
];

/** UK towns and cities with a large student population. */
export const CITIES = [
	"London", "Bristol", "Manchester", "Birmingham", "Leeds", "Liverpool", "Sheffield",
	"Nottingham", "Edinburgh", "Glasgow", "Cardiff", "Newcastle", "Bath", "Oxford",
	"Cambridge", "Exeter", "York", "Durham", "St Andrews", "Aberdeen", "Dundee",
	"Belfast", "Southampton", "Brighton", "Leicester", "Coventry", "Lancaster",
	"Loughborough", "Reading", "Swansea", "Plymouth", "Norwich", "Canterbury",
	"Guildford", "Bournemouth", "Portsmouth", "Aberystwyth", "Stirling", "Hull",
	"Bangor", "Leamington Spa", "Colchester", "Falmouth", "Lincoln", "Derby"
];

/** Student neighbourhoods the parser knows; an area implies its city. */
export const AREAS: { name: string; city: string }[] = [
	...[
		"Clifton", "Cotham", "Redland", "Kingsdown", "Bishopston", "Stokes Croft", "Montpelier",
		"Southville", "Bedminster", "Hotwells", "Cliftonwood", "St Andrews", "Stoke Bishop"
	].map(name => ({ name, city: "Bristol" })),
	...["Cathays", "Roath", "Heath", "Canton"].map(name => ({ name, city: "Cardiff" }))
];

const CASE_SENSITIVE_CITIES = new Set(["Reading", "Bath", "Hull", "Derby", "Lincoln"]);

const MONTH_TOKENS =
	"january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec";

const MONTHS = [
	"january", "february", "march", "april", "may", "june",
	"july", "august", "september", "october", "november", "december"
];

const NUMBER_WORDS: Record<string, number> = {
	one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toNumber(word: string): number | undefined {
	const lower = word.toLowerCase();
	if (lower in NUMBER_WORDS) return NUMBER_WORDS[lower];
	const value = Number(lower);
	return Number.isFinite(value) ? value : undefined;
}

function amount(raw: string, multiplier?: string): number {
	const value = Number(raw.replace(/,/g, ""));
	return multiplier && /^k$/i.test(multiplier) ? value * 1000 : value;
}

const PER_WEEK = /^\s*(?:a|per|\/|p)\s*(?:week|wk|w)\b|^\s*pw\b|^\s*weekly\b/i;

/** Monthly rent per person in pounds, from "under £700", "max 650pcm", "£160 a week"... */
export function parseMaxRent(text: string): number | undefined {
	const patterns = [
		/(?:under|below|less than|max(?:imum)?|up to|no more than|at most|within|budget(?: of| is)?|cheaper than|<)\s*£?\s*(\d{1,3}(?:,\d{3})+|\d{1,5}(?:\.\d+)?)(k)?/gi,
		/£\s*(\d{1,3}(?:,\d{3})+|\d{1,5}(?:\.\d+)?)(k)?/gi,
		/(\d{1,3}(?:,\d{3})+|\d{2,5})(k)?\s*(?:pounds|gbp|pcm|pppm|pm|a month|per month|\/month|\/m\b|pw|a week|per week|\/week)/gi
	];
	for (const pattern of patterns) {
		pattern.lastIndex = 0;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(text)) !== null) {
			let value = amount(match[1], match[2]);
			if (!Number.isFinite(value) || value <= 0) continue;
			const after = text.slice(match.index + match[0].length);
			const tail = match[0].toLowerCase();
			if (PER_WEEK.test(after) || /\b(?:pw|a week|per week|\/week)\b/.test(tail)) {
				value = (value * 52) / 12;
			}
			// A whole-year figure ("£8,400 a year") becomes a monthly one.
			if (/^\s*(?:a|per|\/)\s*(?:year|annum)\b|^\s*pa\b/i.test(after)) {
				value = value / 12;
			}
			if (value < 50 || value > 20000) continue;
			return Math.round(value);
		}
	}
	return undefined;
}

/** Bedrooms wanted, from "2-bed", "two bedroom", "for 4 of us", "studio". */
export function parseMinBedrooms(text: string): number | undefined {
	const bed = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\s-]*(?:bed(?:room)?s?|br|bd)\b/i.exec(text);
	if (bed) {
		const value = toNumber(bed[1]);
		if (value !== undefined && value >= 0 && value <= 12) return value;
	}
	const people =
		/\b(?:group of|house(?:hold)? of|we are|we're|there are)\s+(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\b/i.exec(text) ??
		/\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of us|people|friends|students|mates|housemates)\b/i.exec(text);
	if (people) {
		const value = toNumber(people[1]);
		if (value !== undefined && value >= 1 && value <= 12) return value;
	}
	if (/\bstudio\b/i.test(text)) return 1;
	return undefined;
}

export function parseBillsIncluded(text: string): boolean | undefined {
	if (/\bbills?\s+(?:are\s+)?(?:not|n't)\s+included\b|\b(?:excluding|exclusive of|without|plus|\+)\s+bills\b|\bbills\s+extra\b/i.test(text)) {
		return false;
	}
	if (/\bbills?\s+(?:are\s+)?inc(?:l(?:uded|usive)?)?\b|\b(?:including|incl\.?|inc\.?|with)\s+(?:all\s+)?bills\b|\ball[\s-]+(?:bills[\s-]+)?inclusive\b|\ball bills\b/i.test(text)) {
		return true;
	}
	return undefined;
}

export function findUniversity(text: string): University | undefined {
	const lower = text.toLowerCase().replace(/[’`]/g, "'");
	let best: { university: University; index: number; length: number } | undefined;
	for (const university of UNIVERSITIES) {
		for (const alias of university.aliases) {
			const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, "i");
			const match = pattern.exec(lower);
			if (!match) continue;
			// Prefer the longest alias so "uwe" does not shadow a fuller name.
			if (!best || alias.length > best.length) {
				best = { university, index: match.index, length: alias.length };
			}
		}
	}
	return best?.university;
}

/**
 * Neighbourhood named in the text. Longest name first, so "Cliftonwood" is
 * not read as "Clifton". "Heath" and "Canton" are ordinary words too, so
 * they only count when capitalised; "St Andrews" alone is the Scottish town
 * unless Bristol is mentioned.
 */
export function parseArea(text: string): { name: string; city: string } | undefined {
	const sorted = [...AREAS].sort((a, b) => b.name.length - a.name.length);
	for (const area of sorted) {
		const flags = area.name === "Heath" || area.name === "Canton" ? "" : "i";
		const pattern = new RegExp(`\\b${escapeRegExp(area.name).replace(/ /g, "\\s+")}\\b`, flags);
		if (!pattern.test(text)) continue;
		if (area.name === "St Andrews" && !/\bbristol\b/i.test(text)) continue;
		return area;
	}
	return undefined;
}

export function parseCity(text: string): string | undefined {
	let found: { city: string; index: number } | undefined;
	for (const city of CITIES) {
		// Some town names are ordinary words ("reading week", "a bath").
		const flags = CASE_SENSITIVE_CITIES.has(city) ? "" : "i";
		const pattern = new RegExp(`\\b${escapeRegExp(city)}\\b`, flags);
		const match = pattern.exec(text);
		if (match && (!found || match.index < found.index)) {
			found = { city, index: match.index };
		}
	}
	return found?.city;
}

function pad(value: number) {
	return String(value).padStart(2, "0");
}

/** "from September", "Sept 2027", "1st of October", "2027-09-01" → YYYY-MM-DD. */
export function parseMoveIn(text: string, now: Date = new Date()): string | undefined {
	const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(text);
	if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

	const monthPattern = new RegExp(
		`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?)?(${MONTH_TOKENS})\\b\\.?(?:\\s+(20\\d{2}))?`,
		"i"
	);
	const match = monthPattern.exec(text);
	if (!match) return undefined;
	// "may" is also a verb; only read it as a month next to a date word.
	if (/^may$/i.test(match[0].trim()) && !/\b(?:from|in|start(?:ing)?|move(?:\s+in)?|by|for)\s+may\b/i.test(text)) {
		return undefined;
	}
	const monthIndex = MONTHS.findIndex(month => month.startsWith(match[2].toLowerCase().slice(0, 3)));
	const day = match[1] ? Math.min(31, Math.max(1, Number(match[1]))) : 1;
	let year = match[3] ? Number(match[3]) : now.getUTCFullYear();
	if (!match[3]) {
		const candidate = Date.UTC(year, monthIndex, day);
		const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
		if (candidate < today) year += 1;
	}
	return `${year}-${pad(monthIndex + 1)}-${pad(day)}`;
}

/** Parses one message into the filters it mentions. */
export function parseSearchText(text: string, now: Date = new Date()): SearchFilters {
	const filters: SearchFilters = {};
	const clean = text.replace(/\s+/g, " ").trim();
	if (!clean) return filters;

	const university = findUniversity(clean);
	if (university) {
		filters.nearUniversity = university.name;
	}
	const area = parseArea(clean);
	if (area) filters.area = area.name;
	const city = (area ? area.city : parseCity(clean)) ?? university?.city;
	if (city) filters.city = city;

	const maxRent = parseMaxRent(clean);
	if (maxRent !== undefined) filters.maxRent = maxRent;

	const bedrooms = parseMinBedrooms(clean);
	if (bedrooms !== undefined) filters.minBedrooms = bedrooms;

	const bills = parseBillsIncluded(clean);
	if (bills !== undefined) filters.billsIncluded = bills;

	const moveIn = parseMoveIn(clean, now);
	if (moveIn) filters.moveIn = moveIn;

	return filters;
}

/**
 * Reads the whole conversation: later user messages refine or override what
 * earlier ones asked for ("actually make it under £600").
 */
export function parseConversation(
	messages: { role: string; content: string }[],
	now: Date = new Date()
): SearchFilters {
	const filters: SearchFilters = {};
	for (const message of messages) {
		if (message.role !== "user") continue;
		const parsed = parseSearchText(message.content, now);
		// A new university in a new city replaces the old area entirely.
		if (parsed.city && parsed.city !== filters.city) {
			delete filters.nearUniversity;
			delete filters.area;
		}
		Object.assign(filters, parsed);
		if (/\b(?:any(?:where)?|don't mind|doesn't matter)\b.*\bbills\b|\bbills\b.*\b(?:don't mind|doesn't matter)\b/i.test(message.content)) {
			delete filters.billsIncluded;
		}
	}
	return filters;
}

/** One-line description of the filters, used in replies. */
export function describeFilters(filters: SearchFilters): string {
	const parts: string[] = [];
	if (filters.minBedrooms) parts.push(`${filters.minBedrooms}+ bedroom${filters.minBedrooms > 1 ? "s" : ""}`);
	if (filters.nearUniversity) parts.push(`near ${filters.nearUniversity}`);
	else if (filters.area) parts.push(`in ${filters.area}${filters.city ? `, ${filters.city}` : ""}`);
	else if (filters.city) parts.push(`in ${filters.city}`);
	if (filters.maxRent) parts.push(`under £${filters.maxRent} a month each`);
	if (filters.billsIncluded === true) parts.push("bills included");
	if (filters.billsIncluded === false) parts.push("bills not included");
	if (filters.moveIn) {
		const date = new Date(`${filters.moveIn}T00:00:00Z`);
		parts.push(
			`from ${date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })}`
		);
	}
	return parts.join(", ");
}

const FILTER_KEYS: (keyof SearchFilters)[] = [
	"city",
	"maxRent",
	"minBedrooms",
	"billsIncluded",
	"nearUniversity",
	"moveIn",
	"area"
];

/**
 * Validates filters a model produced. Returns null when the shape is wrong so
 * the caller can fall back to the rule-based parser.
 */
export function sanitizeFilters(raw: unknown): SearchFilters | null {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
	const input = raw as Record<string, unknown>;
	const filters: SearchFilters = {};
	for (const key of Object.keys(input)) {
		if (!FILTER_KEYS.includes(key as keyof SearchFilters)) return null;
	}
	const { city, maxRent, minBedrooms, billsIncluded, nearUniversity, moveIn, area } = input;
	if (city !== undefined && city !== null) {
		if (typeof city !== "string" || city.length > 80) return null;
		if (city.trim()) filters.city = city.trim();
	}
	if (maxRent !== undefined && maxRent !== null) {
		if (typeof maxRent !== "number" || !Number.isFinite(maxRent) || maxRent <= 0 || maxRent > 20000) return null;
		filters.maxRent = Math.round(maxRent);
	}
	if (minBedrooms !== undefined && minBedrooms !== null) {
		if (typeof minBedrooms !== "number" || !Number.isInteger(minBedrooms) || minBedrooms < 0 || minBedrooms > 12) return null;
		filters.minBedrooms = minBedrooms;
	}
	if (billsIncluded !== undefined && billsIncluded !== null) {
		if (typeof billsIncluded !== "boolean") return null;
		filters.billsIncluded = billsIncluded;
	}
	if (nearUniversity !== undefined && nearUniversity !== null) {
		if (typeof nearUniversity !== "string" || nearUniversity.length > 120) return null;
		const university = findUniversity(nearUniversity);
		if (university) {
			filters.nearUniversity = university.name;
			filters.city ??= university.city;
		} else if (/^\p{L}[\p{L}\s'&.,-]{2,}$/u.test(nearUniversity.trim()) && !/^(null|none|undefined)$/i.test(nearUniversity.trim())) {
			// Unknown names are kept as free text; model debris such as ": null," is dropped.
			filters.nearUniversity = nearUniversity.trim();
		}
	}
	if (moveIn !== undefined && moveIn !== null) {
		if (typeof moveIn !== "string" || !/^20\d{2}-\d{2}-\d{2}$/.test(moveIn)) return null;
		if (Number.isNaN(new Date(`${moveIn}T00:00:00Z`).getTime())) return null;
		filters.moveIn = moveIn;
	}
	if (area !== undefined && area !== null) {
		if (typeof area !== "string" || area.length > 80) return null;
		const known = AREAS.find(a => a.name.toLowerCase() === area.trim().toLowerCase());
		if (known) {
			filters.area = known.name;
			filters.city ??= known.city;
		} else if (area.trim()) {
			filters.area = area.trim();
		}
	}
	return filters;
}

/** Pulls the first JSON object out of a model answer (tolerates code fences). */
export function extractJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) return null;
	try {
		return JSON.parse(text.slice(start, end + 1));
	} catch {
		return null;
	}
}
