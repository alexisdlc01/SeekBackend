/**
 * Splits a bill in pence so the shares always add up to the total: the
 * first `remainder` people pay one extra penny.
 */
export function splitPence(amount: number, people: string[]): { user: string; amount: number }[] {
	if (people.length === 0) return [];
	const base = Math.floor(amount / people.length);
	const remainder = amount - base * people.length;
	return people.map((user, index) => ({
		user,
		amount: base + (index < remainder ? 1 : 0)
	}));
}
