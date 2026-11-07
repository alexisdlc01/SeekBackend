export interface UniversityDetails {
	/** What the student typed on their profile. */
	text: string;
	course?: string;
	university?: string;
	year?: string;
}

const YEAR = /\b(?:year\s*(\d)|(\d)(?:st|nd|rd|th)\s*year|(first|second|third|fourth|final)\s*year|y(\d))\b/i;
const ORDINALS: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", final: "Final" };

/**
 * Splits a profile line such as "BSc Computer Science, University of Bristol,
 * year 2" into course, university and year. It is free text, so anything that
 * does not match is simply left out; `text` is always kept.
 */
export function parseUniversityDetails(value: string | null | undefined): UniversityDetails | null {
	const text = (value ?? "").trim();
	if (!text) return null;
	const result: UniversityDetails = { text };
	const rest: string[] = [];
	for (const part of text.split(/\s*[,;|]\s*|\s+-\s+/).map(piece => piece.trim()).filter(Boolean)) {
		const match = YEAR.exec(part);
		if (match && !result.year) {
			const raw = match[1] ?? match[2] ?? match[4] ?? ORDINALS[match[3].toLowerCase()];
			result.year = raw;
			const left = part.replace(YEAR, "").replace(/\s{2,}/g, " ").trim();
			if (left) rest.push(left);
		} else if (!result.university && /\b(universit|college|institute|school of)/i.test(part)) {
			result.university = part;
		} else {
			rest.push(part);
		}
	}
	if (rest.length) result.course = rest.join(", ");
	return result;
}
