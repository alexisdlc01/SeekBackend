import { EmailCategory } from "./email-category.enum";

export interface ReplyContext {
	/** The message being answered (subject and body together for emails). */
	text: string;
	category?: EmailCategory | null;
	/** Who wrote it, as shown in the inbox. */
	fromName?: string | null;
	/** The person replying is a landlord or agent. */
	landlord: boolean;
}

const URGENT = /\b(no heating|heating (?:has )?(?:failed|stopped|broken|not working)|boiler|no hot water|leak|flood|gas smell|smell of gas|electrics?|power cut)\b/i;
const REPAIR = /\b(repair|broken|mould|damp|engineer|fix|not working|heating)\b/i;

// Words that mark a sender as an organisation, not a person ("Deposit Protection Service").
const ORGANISATION = /\b(service|services|scheme|protection|council|ltd|limited|lettings?|lets|agency|agents?|estates?|property|properties|energy|water|broadband|bank|university|team|support|group|office|insurance|deposit|tds|dps|no-?reply)\b/i;

function greeting(fromName?: string | null) {
	const name = (fromName ?? "").trim();
	const words = name.split(/\s+/);
	// First names only for people: an email address or an organisation gets a neutral greeting.
	const person = words.length <= 3 && words.every(word => /^[A-Z][a-z'-]+$/.test(word)) && !ORGANISATION.test(name);
	return person ? `Hi ${words[0]},` : "Hello,";
}

/**
 * A short reply the user can send as is or edit, built from the last message
 * they received. Rules only: no message content leaves the server.
 */
export function suggestReply(context: ReplyContext): string {
	const hi = greeting(context.fromName);
	const text = context.text ?? "";
	if (URGENT.test(text)) {
		return context.landlord
			? `${hi} thanks for letting me know, this is urgent. I'm booking an engineer to come within 24 hours and will confirm the time today. I've logged it as a repair in Seek.`
			: `${hi} thanks for the update. Please let us know when the engineer can come and we'll make sure someone is in.`;
	}
	if (REPAIR.test(text)) {
		return context.landlord
			? `${hi} thanks for reporting this. I'll arrange for it to be looked at and confirm a time with you this week.`
			: `${hi} thanks. Let us know when someone can come round and we'll make sure the house is accessible.`;
	}
	if (/\bviewing\b/i.test(text)) {
		return context.landlord
			? `${hi} thanks for your interest. Pick any of the viewing slots on the listing and I'll see you there.`
			: `${hi} thanks, that viewing time works for me. See you then.`;
	}
	switch (context.category) {
		case EmailCategory.DEPOSIT:
			return `${hi} thanks for confirming. I've saved the certificate in Seek.`;
		case EmailCategory.BILLS:
			// Bills come from suppliers, not people: no first name.
			return context.landlord
				? "Hi, thanks, I've noted this bill against the property."
				: "Hi, thanks, I've added this bill to Seek so the household can split it.";
		case EmailCategory.APPLICANT:
			return `${hi} thanks for sending this. I'll check it and come back to you shortly.`;
		case EmailCategory.HOUSEHOLD:
			return `${hi} sounds good to me. Let's sort it out here so everyone sees it.`;
		default:
			return /\?/.test(text)
				? `${hi} thanks for your message. I'll look into it and get back to you shortly.`
				: `${hi} thanks for your message.`;
	}
}
