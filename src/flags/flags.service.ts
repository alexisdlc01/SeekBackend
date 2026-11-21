import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { CreateFlagDto } from "./dto/create-flag.dto";
import { ResolveFlagDto } from "./dto/resolve-flag.dto";
import { Flag, FlagTriage } from "./flags.schema";
import { Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "../users/users.schema";
import { FlagStatus } from "./enums/flag-status";
import { Role } from "../auth/role.enum";
import { Listing } from "../listings/listings.schema";
import { ModerationStatus } from "../listings/enums/moderation-status.enum";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { Conversation } from "../conversation/converstaion.schema";
import { Message } from "../conversation/message.schema";
import { Tenancy } from "../tenancies/tenancy.schema";
import { MailService } from "../auth/mail.service";
import { ListingsGateway } from "../listings/listings.gateway";

const DAY_MS = 86_400_000;
/** Reports count for 30 days; one still open after that is closed with CLOSED_RESPONSE. */
const REPORT_WINDOW_MS = 30 * DAY_MS;
/** Distinct email-verified reporters, each linked to the account, within 30 days that suspend it. */
const REPORTERS_TO_SUSPEND = 3;
/** Distinct email-verified, linked reporters whose open severe reports in 30 days take the listings offline. */
const SEVERE_REPORTERS_TO_HIDE = 2;
const CLOSED_RESPONSE = "Thanks for your report. We keep it on file for 30 days: if other people who dealt with this account report it too, we suspend it automatically.";
const SUSPENDED_RESPONSE = "Thanks for your report. We have suspended this account.";
// Neutral on purpose: a landlord with one applicant must not learn who reported him.
const HIDDEN_AFTER_REPORT = "Your listing needs a new automatic check: edit and resubmit it.";
const SEVERE_CATEGORIES: FlagTriage["category"][] = ["THREATS_VIOLENCE", "FRAUD_SCAM"];

// No AI (product decision): a report is severe when its text names a threat or a scam.
// shortcut: plain keywords, blind to negation ("not a scam"); so one report never hides listings alone (SEVERE_REPORTERS_TO_HIDE).
const SEVERE_REPORT_RULES: [FlagTriage["category"], RegExp][] = [
	["THREATS_VIOLENCE", /\b(threat\w*|kill|murder|attacked|assault\w*|punch(ed)?|weapon|knife|gun|violen\w*)\b/i],
	["FRAUD_SCAM", /\b(scam\w*|fraud\w*|stole|stolen|fake (listing|advert|landlord|property|flat|house|room)|wire( the)? (money|deposit)|western union|gift ?cards?|crypto\w*)\b/i]
];

@Injectable()
export class FlagsService {
	private readonly logger = new Logger(FlagsService.name);

	constructor(
		@InjectModel(Flag.name)
		private readonly flagModel: Model<Flag>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>,
		@Optional() @InjectModel(Listing.name) private readonly listingModel?: Model<Listing>,
		@Optional() private readonly notifications?: NotificationsService,
		@Optional() @InjectModel(Conversation.name) private readonly conversationModel?: Model<Conversation>,
		@Optional() @InjectModel(Tenancy.name) private readonly tenancyModel?: Model<Tenancy>,
		@Optional() @InjectModel(Message.name) private readonly messageModel?: Model<Message>,
		@Optional() private readonly mail?: MailService,
		@Optional() private readonly gateway?: ListingsGateway
	) {}

	async create(createFlagDto: CreateFlagDto, user: User): Promise<Flag> {
		if (!Types.ObjectId.isValid(createFlagDto.reportedUser)) {
			throw new BadRequestException("Invalid reported user ID");
		}

		// Check if the reported user exists
		const reported = await this.userModel
			.exists({
				_id: createFlagDto.reportedUser
			})
			.exec();
		if (!reported) {
			throw new NotFoundException("User not found");
		}

		// Create the flag
		const flag = await this.flagModel.create({
			text: createFlagDto.text,
			category: createFlagDto.category,
			reportedUser: createFlagDto.reportedUser,
			createdBy: user._id,
			status: FlagStatus.UNDER_REVIEW
		});

		// The rules below act alone; the email only tells Seek a report came in (App Store: timely response to reports).
		await this.mail
			?.sendReportEmail(user.name, user.email, `[${createFlagDto.category}] ${createFlagDto.text}`, `user ${createFlagDto.reportedUser}`)
			.catch((error: Error) => this.logger.error(`Flag email failed for ${flag._id.toString()}: ${error?.message}`));
		const triage = this.triage(createFlagDto);
		if (triage) await this.flagModel.updateOne({ _id: flag._id }, { $set: { triage } }).exec();
		// The flag is stored: a failed check must not 500 (a retry would duplicate the report).
		await this.enforce(createFlagDto.reportedUser, user, triage).catch((error: Error) =>
			this.logger.error(`Flag enforcement failed for ${flag._id.toString()}: ${error?.message}`)
		);

		return flag.toObject();
	}

	/** Severe category from the report text; null when no rule matches (the count rule still applies). */
	private triage(dto: CreateFlagDto): FlagTriage | null {
		const match = SEVERE_REPORT_RULES.find(([, pattern]) => pattern.test(dto.text));
		return match ? { category: match[0], severity: "high", summary: "", provider: "rules" } : null;
	}

	/**
	 * Only reporters who really dealt with the account count, so strangers or throwaway
	 * accounts cannot take anyone down. 3 of them in 30 days suspend it; severe reports from 2 of
	 * them take its listings offline until they pass a new check, without suspending the account.
	 */
	private async enforce(reportedUser: string, reporter: User, triage: FlagTriage | null): Promise<void> {
		const id = new Types.ObjectId(reportedUser);
		const since = new Date(Date.now() - REPORT_WINDOW_MS);
		const reporters = await this.flagModel
			// Open reports only: suspend() closes the ones it acted on, so a lifted suspension is not undone by the next report.
			.distinct("createdBy", { reportedUser: id, status: FlagStatus.UNDER_REVIEW, createdAt: { $gte: since } })
			.exec();
		const verified: Types.ObjectId[] = await this.userModel.distinct("_id", { _id: { $in: reporters }, isVerified: true }).exec();
		// A team member reports for the account they help run: they and its owner count as one reporter.
		const accountOf = await this.accountsOf(verified);
		const account = (user: Types.ObjectId) => accountOf.get(user.toString()) ?? user;
		const me = account(reporter._id);
		const linked = await this.linkedTo(id, [...new Map(verified.map(user => [account(user).toString(), account(user)])).values()]);
		if (linked.length >= REPORTERS_TO_SUSPEND) {
			return this.suspend(id, `Reported by ${linked.length} verified users who dealt with this account in 30 days`);
		}
		const severe = triage?.severity === "high" && SEVERE_CATEGORIES.includes(triage.category);
		if (!severe || !linked.some(user => user.equals(me))) return;
		// Keywords cannot read intent: a second linked reporter must confirm before any listing goes offline.
		const severeReporters = await this.flagModel
			.distinct("createdBy", {
				reportedUser: id,
				status: FlagStatus.UNDER_REVIEW,
				createdAt: { $gte: since },
				"triage.severity": "high",
				"triage.category": { $in: SEVERE_CATEGORIES }
			})
			.exec();
		if (linked.filter(user => severeReporters.some(other => user.equals(account(other)))).length < SEVERE_REPORTERS_TO_HIDE) return;
		// Once per reporter per 30 days: one account cannot keep a landlord's listings offline by reporting again and again.
		const sameAccount = [me, ...verified.filter(user => account(user).equals(me) && !user.equals(me))];
		const severeFromReporter = await this.flagModel
			.countDocuments({ reportedUser: id, createdBy: { $in: sameAccount }, "triage.severity": "high", createdAt: { $gte: since } })
			.exec();
		if (severeFromReporter <= 1) await this.hideListings(id, HIDDEN_AFTER_REPORT);
	}

	/** Team member id -> owner id, resolved like JwtStrategy (findTeamOwner); other reporters are absent. */
	private async accountsOf(users: Types.ObjectId[]): Promise<Map<string, Types.ObjectId>> {
		const accounts = new Map<string, Types.ObjectId>();
		if (!users.length) return accounts;
		const owners = await this.userModel
			.find({ "team.user": { $in: users }, deletedAt: null, suspendedAt: null, role: Role.LANDLORD_AGENCY }, { team: 1 })
			.lean()
			.exec();
		const wanted = new Set(users.map(String));
		for (const owner of owners) {
			for (const entry of owner.team ?? []) {
				const member = entry.user?.toString();
				if (member && wanted.has(member) && !accounts.has(member)) accounts.set(member, owner._id as Types.ObjectId);
			}
		}
		return accounts;
	}

	/**
	 * The reporters who share a tenancy with the reported account, or a conversation the reported
	 * account wrote in (applying alone creates one, so it proves nothing until the other side answers).
	 */
	private async linkedTo(reported: Types.ObjectId, reporters: Types.ObjectId[]): Promise<Types.ObjectId[]> {
		if (!reporters.length) return [];
		const involves = (ids: Types.ObjectId[]) => ({ $or: [{ landlord: { $in: ids } }, { tenants: { $in: ids } }] });
		const spoke = (await this.messageModel?.distinct("conversation", { sender: reported }).exec()) ?? [];
		const [talkedTo, tenancies] = await Promise.all([
			spoke.length ? this.conversationModel?.distinct("users", { _id: { $in: spoke }, users: { $in: reporters } }).exec() ?? [] : [],
			this.tenancyModel?.find({ $and: [involves([reported]), involves(reporters)] }, { landlord: 1, tenants: 1 }).lean().exec() ?? []
		]);
		const people = new Set([...talkedTo, ...tenancies.flatMap(tenancy => [tenancy.landlord, ...(tenancy.tenants ?? [])])].map(String));
		return reporters.filter(user => people.has(user.toString()));
	}

	/** lastUpdated moves too: a moderation check already waiting on the AI must not write APPROVED over this. */
	private async hideListings(id: Types.ObjectId, reason: string): Promise<void> {
		if (!this.listingModel) return;
		const now = new Date();
		const hidden = await this.listingModel
			.updateMany(
				{ landlord: id, isDraft: false },
				{ $set: { isVerified: false, moderationStatus: ModerationStatus.NEEDS_CHANGES, moderationReasons: [reason], lastUpdated: now } }
			)
			.exec();
		// A student, or a landlord with no published listing, has nothing offline to be told about.
		if (!hidden.matchedCount) return;
		if (this.gateway) for (const listing of await this.listingModel.find({ landlord: id, isDraft: false }).exec()) this.gateway.emitListingUpdated(listing);
		await this.notifications?.notify({
			user: id,
			kind: NotificationKind.LISTING_NEEDS_CHANGES,
			title: "Your listings are offline",
			body: reason,
			link: "/listings",
			dedupeKey: `listings-hidden:${id.toString()}:${now.toISOString().slice(0, 10)}`
		});
	}

	/** Blocks the account (JwtStrategy answers 403), hides its listings and closes open reports about it. */
	async suspend(userId: string | Types.ObjectId, reason: string, resolvedFlag?: Types.ObjectId): Promise<void> {
		const id = new Types.ObjectId(userId.toString());
		const now = new Date();
		const result = await this.userModel
			.updateOne({ _id: id, suspendedAt: null, role: { $ne: Role.SUPERUSER } }, { $set: { suspendedAt: now, suspensionReason: reason } })
			.exec();
		if (result.modifiedCount === 0) return;
		this.logger.warn(`Account ${id.toString()} suspended: ${reason}`);
		await this.hideListings(id, "This account is suspended.");
		// Reporters see the outcome in GET /flags/mine (supportResponse) and in their in-app notifications.
		// resolvedFlag: resolve() already moved that flag out of UNDER_REVIEW, its reporter must be told too.
		const open = { status: FlagStatus.UNDER_REVIEW };
		const reporters = await this.flagModel.distinct("createdBy", { reportedUser: id, ...(resolvedFlag ? { $or: [open, { _id: resolvedFlag }] } : open) }).exec();
		await this.notifications?.notifyMany(
			reporters.map(reporter => ({
				user: reporter,
				kind: NotificationKind.REPORT_ACTIONED,
				title: "We acted on your report",
				body: SUSPENDED_RESPONSE,
				// suspendedAt in the key: a new suspension after a lifted one notifies the reporter again.
				dedupeKey: `report-actioned:${id.toString()}:${reporter.toString()}:${now.getTime()}`
			}))
		);
		await this.flagModel
			.updateMany(
				{ reportedUser: id, status: FlagStatus.UNDER_REVIEW },
				{ $set: { status: FlagStatus.ACCOUNT_SUSPENDED, resolutionDate: new Date(), supportResponse: SUSPENDED_RESPONSE } }
			)
			.exec();
	}

	/** Lifts a suspension (an upheld appeal). Listings stay offline until the landlord resubmits them for a new check. */
	async liftSuspension(userId: string): Promise<void> {
		if (!Types.ObjectId.isValid(userId)) throw new BadRequestException("Invalid user ID");
		const result = await this.userModel.updateOne({ _id: userId, suspendedAt: { $ne: null } }, { $set: { suspendedAt: null, suspensionReason: null } }).exec();
		if (result.matchedCount === 0) throw new NotFoundException("No suspended account with this ID");
		// Reports filed while suspended (suspend() skips them) must not re-suspend the account after an upheld appeal.
		await this.flagModel
			.updateMany(
				{ reportedUser: new Types.ObjectId(userId), status: FlagStatus.UNDER_REVIEW },
				{ $set: { status: FlagStatus.NO_ACTION, resolutionDate: new Date(), supportResponse: CLOSED_RESPONSE } }
			)
			.exec();
		// Flags that caused the suspension are resolved too: otherwise the dashboard keeps offering "Lift suspension" and a retry 404s.
		await this.flagModel
			.updateMany(
				{ reportedUser: new Types.ObjectId(userId), status: FlagStatus.ACCOUNT_SUSPENDED },
				{ $set: { status: FlagStatus.NO_ACTION, resolutionDate: new Date(), supportResponse: "Suspension lifted after review." } }
			)
			.exec();
	}

	/** Reports that reached no threshold within the window get a fixed answer, so none waits on a person. */
	private async closeStale(): Promise<void> {
		await this.flagModel
			.updateMany(
				{ status: FlagStatus.UNDER_REVIEW, createdAt: { $lt: new Date(Date.now() - REPORT_WINDOW_MS) } },
				{ $set: { status: FlagStatus.NO_ACTION, resolutionDate: new Date(), supportResponse: CLOSED_RESPONSE } }
			)
			.exec();
	}

	async findOne(id: string): Promise<Flag> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid flag ID");
		}

		await this.closeStale();
		// The AI triage is for Seek only: the reporter reads this route too.
		const flag = await this.flagModel.findById(id).select("-triage").exec();
		if (!flag) {
			throw new NotFoundException("Flag not found");
		}
		return flag;
	}

	async resolve(id: string, resolveFlagDto: ResolveFlagDto): Promise<void> {
		if (!Types.ObjectId.isValid(id)) {
			throw new BadRequestException("Invalid flag ID");
		}

		const result = await this.flagModel
			.findByIdAndUpdate(id, {
				$set: {
					status: resolveFlagDto.status,
					resolutionDate: new Date(),
					...(resolveFlagDto.supportResponse !== undefined
						? { supportResponse: resolveFlagDto.supportResponse.trim() }
						: resolveFlagDto.status === FlagStatus.ACCOUNT_SUSPENDED
							? { supportResponse: SUSPENDED_RESPONSE }
							: {})
				}
			})
			.exec();
		if (!result) {
			throw new NotFoundException("Flag not found");
		}
		if (resolveFlagDto.status === FlagStatus.ACCOUNT_SUSPENDED) {
			await this.suspend(result.reportedUser, "Suspended by Seek support", result._id);
		}
	}

	async findMine(userId: Types.ObjectId): Promise<Flag[]> {
		await this.closeStale();
		return this.flagModel.find({ createdBy: userId }).select("-triage").sort({ createdAt: -1 }).lean().exec();
	}

	async getAll(): Promise<Flag[]> {
		await this.closeStale();
		return await this.flagModel.find({}).exec();
	}
}
