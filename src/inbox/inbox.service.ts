import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { Conversation } from "../conversation/converstaion.schema";
import { Message } from "../conversation/message.schema";
import { ConversationService } from "../conversation/conversation.service";
import { ConversationAccessService } from "../conversation/conversation-access.service";
import { Application } from "../application/application.schema";
import { ApplicationStage } from "../application/enums/application-stage.enum";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { Listing } from "../listings/listings.schema";
import { ConnectorsService } from "../connectors/connectors.service";
import { ConnectionStatus, EmailConnection } from "../connectors/email-connection.schema";
import { EmailMessage } from "./email-message.schema";
import { EmailCategory } from "./email-category.enum";
import { InboxReplyDto } from "./dto/inbox.dto";
import { suggestReply } from "./suggest-reply";
import { Payment } from "../payments/payment.schema";
import { PaymentKind, PaymentStatus } from "../payments/payment.enums";

type Id = Types.ObjectId;
type EmailLean = EmailMessage & { _id: Id };
type Viewer = Pick<User, "_id" | "name" | "role">;

interface SeekThreadMeta {
	name: string;
	sub: string;
	category: EmailCategory;
	tenancyId: string | null;
	label: string;
}

const LONDON = "Europe/London";
const dayKey = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, year: "numeric", month: "2-digit", day: "2-digit" });
const clock = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, hour: "2-digit", minute: "2-digit" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, weekday: "short" });
const shortDate = new Intl.DateTimeFormat("en-GB", { timeZone: LONDON, day: "numeric", month: "short" });

/** "14:05" today, "Yesterday", "Tue" this week, then "6 Nov" (UK time). */
export function timeLabel(date: Date, now = new Date()) {
	const today = dayKey.format(now);
	if (dayKey.format(date) === today) return clock.format(date);
	if (dayKey.format(new Date(now.getTime() - 86_400_000)) === dayKey.format(date)) return "Yesterday";
	if (now.getTime() - date.getTime() < 6 * 86_400_000) return weekday.format(date);
	return shortDate.format(date);
}

export function initialsOf(name: string) {
	const words = name
		.replace(/[^\p{L}\s]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
	return ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
}

function firstName(name: string | undefined) {
	return (name ?? "").trim().split(/\s+/)[0] || "Someone";
}

function oneLine(text: string, length = 140) {
	const flat = (text ?? "").replace(/\s+/g, " ").trim();
	return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

@Injectable()
export class InboxService {
	constructor(
		@InjectModel(Conversation.name) private readonly conversationModel: Model<Conversation>,
		@InjectModel(Message.name) private readonly messageModel: Model<Message>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(User.name) private readonly userModel: Model<User>,
		@InjectModel(EmailMessage.name) private readonly emailModel: Model<EmailMessage>,
		@InjectModel(EmailConnection.name) private readonly connectionModel: Model<EmailConnection>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		private readonly conversations: ConversationService,
		private readonly access: ConversationAccessService,
		private readonly connectors: ConnectorsService
	) {}

	// ---------------------------------------------------------------- list

	async listThreads(user: Viewer, category?: EmailCategory) {
		const uid = new Types.ObjectId(user._id.toString());
		const now = new Date();
		const conversationIds = await this.conversationIdsFor(uid);
		const [metas, conversations, unreadSeek, emails] = await Promise.all([
			this.seekMeta(user, conversationIds),
			this.conversationModel
				.find({ _id: { $in: conversationIds } })
				.populate<{ lastMessage: Message | null }>({ path: "lastMessage", select: "data createdAt sender" })
				.lean()
				.exec(),
			this.messageModel.aggregate<{ _id: Id; count: number }>([
				{ $match: { conversation: { $in: conversationIds }, sender: { $ne: uid }, seenUsers: { $ne: uid } } },
				{ $group: { _id: "$conversation", count: { $sum: 1 } } }
			]),
			this.emailModel.find({ user: uid }).sort({ receivedAt: -1 }).lean().exec()
		]);
		const unreadByConversation = new Map(unreadSeek.map(row => [row._id.toString(), row.count]));

		const emailsByConversation = new Map<string, EmailLean[]>();
		const emailThreads = new Map<string, EmailLean[]>();
		for (const email of emails as EmailLean[]) {
			const conversation = email.conversation?.toString();
			if (conversation && conversationIds.some(id => id.toString() === conversation)) {
				emailsByConversation.set(conversation, [...(emailsByConversation.get(conversation) ?? []), email]);
			} else {
				emailThreads.set(email.threadKey, [...(emailThreads.get(email.threadKey) ?? []), email]);
			}
		}

		const items = conversations.map(conversation => {
			const id = conversation._id.toString();
			const meta = metas.get(id) ?? {
				name: conversation.name,
				sub: "Seek conversation",
				category: EmailCategory.OTHER,
				tenancyId: null,
				label: "Seek"
			};
			const merged = emailsByConversation.get(id) ?? [];
			const latestEmail = merged[0];
			const lastSeek = conversation.lastMessage;
			const seekTime = lastSeek?.createdAt ?? null;
			const useEmail = latestEmail && (!seekTime || latestEmail.receivedAt > seekTime);
			const time = useEmail ? latestEmail.receivedAt : (seekTime ?? conversation.createdAt);
			const preview = useEmail
				? `${latestEmail.outgoing ? "You: " : ""}${oneLine(latestEmail.snippet || latestEmail.body)}`
				: lastSeek
					? `${lastSeek.sender?.toString() === uid.toString() ? "You: " : ""}${oneLine(lastSeek.data)}`
					: "No messages yet";
			const unreadCount = (unreadByConversation.get(id) ?? 0) + merged.filter(e => !e.read && !e.outgoing).length;
			const channels: ("seek" | "email")[] = merged.length ? ["seek", "email"] : ["seek"];
			return {
				id: `seek-${id}`,
				kind: "seek" as "seek" | "email",
				name: meta.name,
				sub: meta.sub,
				via: merged.length ? `${meta.label} and email` : meta.label,
				preview,
				time: new Date(time).toISOString(),
				timeLabel: timeLabel(new Date(time), now),
				category: meta.category,
				unread: unreadCount > 0,
				unreadCount,
				initials: initialsOf(meta.name),
				channels,
				tenancyId: meta.tenancyId
			};
		});

		for (const [key, thread] of emailThreads) {
			const latest = thread[0];
			const incoming = thread.find(email => !email.outgoing) ?? latest;
			const filed = thread.some(email => (email.attachments ?? []).some(a => a.filedAs));
			const name = incoming.counterpartName || incoming.fromName || incoming.counterpartEmail || incoming.from;
			const unreadCount = thread.filter(email => !email.read && !email.outgoing).length;
			items.push({
				id: `email-${key}`,
				kind: "email",
				name,
				sub: latest.subject || "(no subject)",
				via: filed ? "Email · auto-filed" : incoming.category === EmailCategory.BILLS ? "Email · bills" : "Email",
				preview: `${latest.outgoing ? "You: " : ""}${oneLine(latest.snippet || latest.body)}`,
				time: latest.receivedAt.toISOString(),
				timeLabel: timeLabel(latest.receivedAt, now),
				category: incoming.category,
				unread: unreadCount > 0,
				unreadCount,
				initials: initialsOf(name),
				channels: ["email"],
				tenancyId: incoming.tenancy?.toString() ?? null
			});
		}

		return items
			.filter(item => !category || item.category === category)
			.sort((a, b) => b.time.localeCompare(a.time));
	}

	/** Conversations the user can open: direct members and application participants (same rule as sending). */
	private async conversationIdsFor(uid: Id): Promise<Id[]> {
		const [direct, viaApplications] = await Promise.all([
			this.conversationModel.find({ users: uid }).select("_id").lean().exec(),
			this.applicationModel
				.find({
					conversation: { $ne: null },
					$or: [
						{ applicants: uid },
						{ owner: uid },
						{ landlord: uid, stage: { $in: [ApplicationStage.SENT, ApplicationStage.ACCEPTED, ApplicationStage.REJECTED] } }
					]
				})
				.select("conversation")
				.lean()
				.exec()
		]);
		const ids = new Map<string, Id>();
		for (const row of direct) ids.set(row._id.toString(), row._id);
		for (const row of viaApplications) if (row.conversation) ids.set(row.conversation.toString(), row.conversation);
		return [...ids.values()];
	}

	/**
	 * Display name, subtitle and category of each Seek conversation, from the
	 * application behind it and, once let, the tenancy.
	 */
	private async seekMeta(user: Viewer, conversationIds: Id[]): Promise<Map<string, SeekThreadMeta>> {
		const userId = user._id.toString();
		const isLandlord = user.role === Role.LANDLORD_AGENCY;
		const applications = await this.applicationModel
			.find({ conversation: { $in: conversationIds } })
			.lean()
			.exec();
		const [listings, tenancies, people] = await Promise.all([
			this.listingModel
				.find({ _id: { $in: applications.map(app => app.listing).filter(Boolean) } })
				.select("propertyTitle streetAddress")
				.lean()
				.exec(),
			this.tenancyModel
				.find({ application: { $in: applications.map(app => app._id) } })
				.select("application tenants landlord status listing")
				.lean()
				.exec(),
			this.userModel
				.find({
					_id: {
						$in: applications.flatMap(app => [app.landlord, app.owner, ...(app.applicants ?? [])]).filter(Boolean)
					}
				})
				.select("name")
				.lean()
				.exec()
		]);
		const nameOf = (id: Id | undefined | null) => people.find(p => p._id.toString() === id?.toString())?.name ?? "";
		const metas = new Map<string, SeekThreadMeta>();

		for (const app of applications) {
			if (!app.conversation) continue;
			const listing = listings.find(l => l._id.toString() === app.listing?.toString());
			const title = listing?.propertyTitle || listing?.streetAddress || "the property";
			const tenancy = tenancies.find(t => t.application?.toString() === app._id.toString());
			const active = tenancy?.status === TenancyStatus.ACTIVE;
			const tenancyId = tenancy?._id.toString() ?? null;
			const household = (app.applicants ?? []).filter(id => id.toString() !== userId);

			let meta: SeekThreadMeta;
			if (isLandlord) {
				meta =
					active
						? {
								name: tenancy.tenants.length > 1 ? `${title} · household` : `${nameOf(tenancy.tenants[0])} · tenant`,
								sub: `Tenants of ${title}`,
								category: EmailCategory.TENANT,
								tenancyId,
								label: "Tenants · Seek"
							}
						: {
								name: `${nameOf(app.owner) || "Applicant"} · applicant`,
								sub: `Application for ${title}`,
								category: EmailCategory.APPLICANT,
								tenancyId,
								label: "Applicant · Seek"
							};
			} else if (active) {
				meta = {
					name: nameOf(app.landlord) || "Your landlord",
					sub: `${title} · your landlord`,
					category: EmailCategory.LANDLORD,
					tenancyId,
					label: "Landlord · Seek"
				};
			} else {
				meta = {
					name: household.length
						? `Household: ${household.map(id => firstName(nameOf(id))).join(", ")}`
						: `Your application to ${title}`,
					sub: `Your application to ${title}`,
					category: EmailCategory.HOUSEHOLD,
					tenancyId,
					label: "Seek group"
				};
			}
			metas.set(app.conversation.toString(), meta);
		}
		return metas;
	}

	// ---------------------------------------------------------------- detail

	async getThread(user: Viewer, threadId: string) {
		const parsed = this.parseThreadId(threadId);
		const uid = new Types.ObjectId(user._id.toString());
		const now = new Date();
		const summary = (await this.listThreads(user)).find(item => item.id === threadId);

		if (parsed.kind === "seek") {
			await this.access.assertCanAccess(parsed.id, uid.toString());
			const conversationId = new Types.ObjectId(parsed.id);
			const [messages, emails, conversation] = await Promise.all([
				this.messageModel
					.find({ conversation: conversationId })
					.sort({ createdAt: 1 })
					.populate<{ sender: { _id: Id; name: string } | null }>({ path: "sender", select: "name" })
					.lean()
					.exec(),
				this.emailModel.find({ user: uid, conversation: conversationId }).sort({ receivedAt: 1 }).lean().exec(),
				this.conversationModel.findById(conversationId).select("name").lean().exec()
			]);
			if (!conversation) throw new NotFoundException("Conversation not found.");
			await Promise.all([
				this.messageModel.updateMany(
					{ conversation: conversationId, sender: { $ne: uid }, seenUsers: { $ne: uid } },
					{ $addToSet: { seenUsers: uid } }
				),
				this.emailModel.updateMany({ user: uid, conversation: conversationId, read: false }, { $set: { read: true } })
			]);
			const replyFrom = await this.replyFrom(emails as EmailLean[]);
			const items = [
				...messages.map(message => {
					const me = message.sender?._id.toString() === uid.toString();
					return {
						id: message._id.toString(),
						from: me ? "You" : (message.sender?.name ?? "Seek user"),
						me,
						via: "Seek" as const,
						time: message.createdAt.toISOString(),
						timeLabel: timeLabel(message.createdAt, now),
						text: message.data,
						attachments: []
					};
				}),
				...(emails as EmailLean[]).map(email => this.emailItem(email, now))
			].sort((a, b) => a.time.localeCompare(b.time));
			const category = summary?.category ?? EmailCategory.OTHER;
			const tenancyId = summary?.tenancyId ?? null;
			return {
				id: threadId,
				kind: "seek" as const,
				name: summary?.name ?? conversation.name,
				sub: summary?.sub ?? "Seek conversation",
				category,
				tenancyId,
				canReplyBySeek: true,
				canReplyByEmail: Boolean(replyFrom),
				replyFrom,
				suggestedReply: await this.suggestedReply(user, items, category),
				rent: await this.rentSummary(tenancyId, now),
				messages: items.map(item => ({ ...item, ...(item.attachments[0] ? { attachment: item.attachments[0] } : {}) }))
			};
		}

		const emails = (await this.emailModel
			.find({ user: uid, threadKey: parsed.id })
			.sort({ receivedAt: 1 })
			.lean()
			.exec()) as EmailLean[];
		if (!emails.length) throw new NotFoundException("Thread not found.");
		await this.emailModel.updateMany({ user: uid, threadKey: parsed.id, read: false }, { $set: { read: true } });
		const replyFrom = await this.replyFrom(emails);
		const incoming = emails.find(email => !email.outgoing) ?? emails[0];
		const tenancyId = incoming.tenancy?.toString() ?? null;
		return {
			id: threadId,
			kind: "email" as const,
			name: summary?.name ?? (incoming.counterpartName || incoming.from),
			sub: summary?.sub ?? incoming.subject,
			category: incoming.category,
			tenancyId,
			canReplyBySeek: false,
			canReplyByEmail: Boolean(replyFrom),
			replyFrom,
			suggestedReply: await this.suggestedReply(user, emails.map(email => this.emailItem(email, now)), incoming.category),
			rent: await this.rentSummary(tenancyId, now),
			messages: emails.map(email => {
				const item = this.emailItem(email, now);
				return { ...item, ...(item.attachments[0] ? { attachment: item.attachments[0] } : {}) };
			})
		};
	}

	/** A reply to the last message someone else sent, unless the user turned AI replies off or spoke last. */
	private async suggestedReply(
		user: Viewer,
		items: { me: boolean; from: string; text: string; subject?: string }[],
		category: EmailCategory
	) {
		const last = items[items.length - 1];
		if (!last || last.me) return null;
		if (!(await this.connectors.settings(user)).aiDraftReplies) return null;
		return suggestReply({
			text: `${last.subject ?? ""}\n${last.text ?? ""}`,
			category,
			fromName: last.from,
			landlord: user.role === Role.LANDLORD_AGENCY
		});
	}

	/** How many tenants have paid this month's rent, for the thread header ("rent paid 3 of 4"). */
	private async rentSummary(tenancyId: string | null, now: Date) {
		if (!tenancyId || !Types.ObjectId.isValid(tenancyId)) return null;
		const tenancy = await this.tenancyModel.findById(tenancyId).select("tenants").lean().exec();
		if (!tenancy) return null;
		const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
		const payers = await this.paymentModel.distinct("tenant", {
			tenancy: tenancy._id,
			kind: { $in: [PaymentKind.RENT, null] },
			status: PaymentStatus.PAID,
			dueDate: { $gte: start, $lt: end }
		});
		const tenants = new Set(tenancy.tenants.map(id => id.toString()));
		return { paid: payers.filter(id => tenants.has(String(id))).length, total: tenants.size };
	}

	private emailItem(email: EmailLean, now: Date) {
		return {
			id: email._id.toString(),
			from: email.outgoing ? "You" : email.fromName || email.from,
			me: email.outgoing,
			via: "Email" as const,
			time: email.receivedAt.toISOString(),
			timeLabel: timeLabel(email.receivedAt, now),
			subject: email.subject,
			text: email.body,
			attachments: (email.attachments ?? []).map(attachment => ({
				name: attachment.name,
				url: attachment.url ?? "",
				key: attachment.key ?? null,
				filedAs: attachment.filedAs ?? null
			}))
		};
	}

	/** The connected mailbox a reply to these emails would go out from. */
	private async replyFrom(emails: EmailLean[]) {
		const latest = [...emails].reverse().find(email => !email.outgoing) ?? emails[emails.length - 1];
		if (!latest) return null;
		const connection = await this.connectionModel.findById(latest.connection).select("emailAddress status").lean().exec();
		return connection?.status === ConnectionStatus.CONNECTED ? connection.emailAddress : null;
	}

	// ---------------------------------------------------------------- reply

	async reply(user: Viewer, threadId: string, body: InboxReplyDto) {
		const parsed = this.parseThreadId(threadId);
		const uid = new Types.ObjectId(user._id.toString());
		const text = body.text.trim();
		if (!text) throw new BadRequestException("Write a message first.");

		if (parsed.kind === "seek") {
			await this.access.assertCanAccess(parsed.id, uid.toString());
			if (body.via === "email") {
				const latest = (await this.emailModel
					.findOne({ user: uid, conversation: new Types.ObjectId(parsed.id) })
					.sort({ outgoing: 1, receivedAt: -1 })
					.lean()
					.exec()) as EmailLean | null;
				if (!latest) throw new BadRequestException("There is no email in this conversation to reply to.");
				await this.connectors.sendReply(user, latest, text);
			} else {
				await this.conversations.sendMessage({ message: text }, parsed.id, uid.toString());
			}
			return this.getThread(user, threadId);
		}

		if (body.via === "seek") throw new BadRequestException("Email threads can only be answered by email.");
		const latest = (await this.emailModel
			.findOne({ user: uid, threadKey: parsed.id })
			.sort({ outgoing: 1, receivedAt: -1 })
			.lean()
			.exec()) as EmailLean | null;
		if (!latest) throw new NotFoundException("Thread not found.");
		await this.connectors.sendReply(user, latest, text);
		return this.getThread(user, threadId);
	}

	private parseThreadId(threadId: string): { kind: "seek" | "email"; id: string } {
		const seek = /^seek-([0-9a-f]{24})$/i.exec(threadId);
		if (seek) return { kind: "seek", id: seek[1] };
		const email = /^email-([0-9a-f]{24})$/i.exec(threadId);
		if (email) return { kind: "email", id: email[1].toLowerCase() };
		throw new BadRequestException("Unknown thread id.");
	}
}
