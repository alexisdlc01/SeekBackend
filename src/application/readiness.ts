import { buildPassport, PassportDocumentInput, StudentEmailProof } from "../users/passport";
import { DocumentStatus, DocumentType } from "../users/types/document-type";
import { GuarantorCriterion } from "../listings/enums/guarantor-criterion.enum";

/** What the landlord asked of applicants; mirrors `Listing.criteria`. */
export interface ReadinessCriteria {
	guarantor?: GuarantorCriterion;
	referencesRequired?: boolean;
	maxHousehold?: number;
}

export type CriterionKey = "PASSPORTS" | "HOUSEHOLD_SIZE" | "MAX_HOUSEHOLD" | "GUARANTOR" | "REFERENCES";

export interface CriterionResult {
	key: CriterionKey;
	label: string;
	passed: boolean;
	/** Plain-English explanation, e.g. "2 of 3 members have a verified guarantor". */
	detail: string;
}

export interface HouseholdReadiness {
	/** Share of members whose passport is ready, 0-100. */
	readiness: number;
	readyMembers: number;
	members: number;
	/** Every member is ready, the group fills the property and every listing criterion passes. */
	qualified: boolean;
	/** Pass or fail for each thing the landlord asks of a household. */
	criteria: CriterionResult[];
}

const REFERENCE_TYPES = [DocumentType.LANDLORD_REFERENCE, DocumentType.AGENT_REFERENCE, DocumentType.RECOMMENDATION, DocumentType.CHARACTER_REFERENCE];

type Member = { documents?: PassportDocumentInput[] } & StudentEmailProof;

function hasVerified(member: Member, types: DocumentType[], now: Date) {
	const passport = buildPassport(member.documents, now, member);
	return passport.sections
		.flatMap(section => section.items)
		.some(item => types.includes(item.type) && item.status === DocumentStatus.VERIFIED);
}

function countLine(count: number, total: number, what: string) {
	return `${count} of ${total} ${total === 1 ? "member has" : "members have"} ${what}`;
}

/**
 * A household is qualified when each member's Seek Passport is ready and the
 * group is big enough for the property, so the landlord can offer straight away.
 */
export function householdReadiness(
	members: Member[],
	numOfPeople: number | undefined,
	now: Date = new Date(),
	criteria?: ReadinessCriteria | null
): HouseholdReadiness {
	const readyMembers = members.filter(member => buildPassport(member.documents, now, member).ready).length;
	const count = members.length;
	const needed = Math.max(1, numOfPeople ?? 1);
	const results: CriterionResult[] = [
		{
			key: "PASSPORTS",
			label: "Seek Passports ready",
			passed: count > 0 && readyMembers === count,
			detail: countLine(readyMembers, count, "a ready Seek Passport")
		},
		{
			key: "HOUSEHOLD_SIZE",
			label: "Household fills the property",
			passed: count >= needed,
			detail: `${count} of ${needed} ${needed === 1 ? "person" : "people"}`
		}
	];
	if (criteria?.maxHousehold) {
		results.push({
			key: "MAX_HOUSEHOLD",
			label: `At most ${criteria.maxHousehold} people`,
			passed: count > 0 && count <= criteria.maxHousehold,
			detail: `${count} ${count === 1 ? "person" : "people"} applying`
		});
	}
	if (criteria?.guarantor && criteria.guarantor !== GuarantorCriterion.NONE) {
		const withGuarantor = members.filter(member => hasVerified(member, [DocumentType.GUARANTOR_AGREEMENT], now)).length;
		results.push({
			key: "GUARANTOR",
			label: criteria.guarantor === GuarantorCriterion.UK_ONLY ? "UK guarantor" : "UK guarantor or guarantor service",
			passed: count > 0 && withGuarantor === count,
			detail: countLine(withGuarantor, count, "a verified guarantor agreement")
		});
	}
	if (criteria?.referencesRequired) {
		const withReference = members.filter(member => hasVerified(member, REFERENCE_TYPES, now)).length;
		results.push({
			key: "REFERENCES",
			label: "References provided",
			passed: count > 0 && withReference === count,
			detail: countLine(withReference, count, "a verified reference")
		});
	}
	return {
		readiness: count === 0 ? 0 : Math.round((readyMembers / count) * 100),
		readyMembers,
		members: count,
		qualified: count > 0 && results.every(result => result.passed),
		criteria: results
	};
}

/** Qualified households first, then the earliest sent. */
export function compareForLandlord(
	a: { qualified?: boolean; sentAt?: Date | null; createdAt?: Date },
	b: { qualified?: boolean; sentAt?: Date | null; createdAt?: Date }
): number {
	if (Boolean(a.qualified) !== Boolean(b.qualified)) return a.qualified ? -1 : 1;
	const at = new Date(a.sentAt ?? a.createdAt ?? 0).getTime();
	const bt = new Date(b.sentAt ?? b.createdAt ?? 0).getTime();
	return at - bt;
}
