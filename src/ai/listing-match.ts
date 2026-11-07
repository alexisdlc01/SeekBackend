/**
 * Server copy of the mobile app's matchHome (seek-mobile/src/utils/listing-match.ts),
 * so Seek AI results carry the same score and reasons: base 70, then budget,
 * bedrooms, bills, move-in date and distance, clamped to 40-99.
 */
export interface MatchInput {
	/** Rent per person per month, in pounds. */
	rentPerPerson: number | null;
	bedrooms: number | null;
	billsIncluded: boolean;
	availableFrom: Date | string | null;
	distanceKm: number | null;
}

export interface MatchPrefs {
	maxRent?: number;
	minBedrooms?: number;
	billsIncluded?: boolean;
	/** Latest move-in date the student wants (ISO or YYYY-MM-DD). */
	moveInBy?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function travel(km: number): string {
	// Walking is about 12 min per km; beyond 1.6 km people cycle (about 4 min per km).
	return km <= 1.6 ? `${Math.max(1, Math.round(km * 12))} min walk` : `${Math.max(2, Math.round(km * 4))} min cycle`;
}

export function matchHome(home: MatchInput, prefs: MatchPrefs = {}, distanceSuffix = "to campus") {
	let score = 70;
	const reasons: { rank: number; text: string }[] = [];

	if (home.distanceKm != null) {
		if (home.distanceKm <= 1) score += 8;
		else if (home.distanceKm <= 2.5) score += 5;
		else if (home.distanceKm <= 4) score += 2;
		else if (home.distanceKm > 6) score -= 4;
		reasons.push({ rank: 1, text: `${travel(home.distanceKm)} ${distanceSuffix}` });
	}

	if (home.availableFrom) {
		const free = new Date(home.availableFrom);
		if (!Number.isNaN(free.getTime())) {
			if (prefs.moveInBy) {
				const by = new Date(prefs.moveInBy).getTime();
				if (!Number.isNaN(by)) score += free.getTime() <= by ? 6 : -8;
			}
			reasons.push({ rank: 2, text: `free ${free.getUTCDate()} ${MONTHS[free.getUTCMonth()]}` });
		}
	}

	if (home.billsIncluded) {
		score += prefs.billsIncluded ? 8 : 4;
		reasons.push({ rank: 3, text: "bills included" });
	} else if (prefs.billsIncluded) {
		score -= 10;
	}

	if (prefs.maxRent && home.rentPerPerson != null) {
		if (home.rentPerPerson <= prefs.maxRent) {
			score += 8;
			reasons.push({ rank: 4, text: `under £${prefs.maxRent}` });
		} else {
			score -= Math.min(20, Math.round(((home.rentPerPerson - prefs.maxRent) / prefs.maxRent) * 60));
		}
	}

	if (prefs.minBedrooms && home.bedrooms != null) {
		if (home.bedrooms >= prefs.minBedrooms) {
			score += 6;
			reasons.push({ rank: 5, text: `${home.bedrooms} bedrooms` });
		} else {
			score -= 8;
		}
	}

	return {
		match: Math.max(40, Math.min(99, Math.round(score))),
		reasons: reasons.sort((a, b) => a.rank - b.rank).map(reason => reason.text)
	};
}
