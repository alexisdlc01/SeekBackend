import { Model, Types } from "mongoose";
import type { Tenancy } from "../tenancies/tenancy.schema";
import type { EmailMessage } from "../inbox/email-message.schema";

export type KeyReferences = {
	tenancyModel: Model<Tenancy>;
	messageModel: Model<EmailMessage>;
	/** The candidates a contract still points at. */
	contractKeys: (candidates: string[]) => Promise<string[]>;
};

/**
 * Keys a tenancy, a contract or a synced email still points at: those files must stay.
 * `leavingUser`'s own emails are ignored, as they are deleted with the account.
 */
export async function referencedKeys(refs: KeyReferences, candidates: string[], leavingUser?: Types.ObjectId): Promise<Set<string>> {
	if (!candidates.length) return new Set();
	const tenancyKeys = (await refs.tenancyModel.distinct("documents.key", { "documents.key": { $in: candidates } })).map(String);
	const contractKeys = await refs.contractKeys(candidates);
	const messageKeys = (await refs.messageModel.distinct("attachments.key", {
		...(leavingUser ? { user: { $ne: leavingUser } } : {}),
		"attachments.key": { $in: candidates }
	})).map(String);
	return new Set([...tenancyKeys, ...contractKeys, ...messageKeys]);
}
