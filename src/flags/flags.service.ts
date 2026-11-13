import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import { CreateFlagDto } from "./dto/create-flag.dto";
import { ResolveFlagDto } from "./dto/resolve-flag.dto";
import { Flag, FlagTriage, TriageCategory, TriageSeverity } from "./flags.schema";
import { Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "../users/users.schema";
import { FlagStatus } from "./enums/flag-status";
import { Role } from "../auth/role.enum";
import { LlmClient } from "../ai/llm.client";
import { UNTRUSTED_DATA_RULE, addsUnsafeDetails } from "../ai/ai.service";
import { extractJsonObject } from "../ai/search-parser";
import { Listing } from "../listings/listings.schema";
import { ModerationStatus } from "../listings/enums/moderation-status.enum";
import { withinAiQuota } from "../listings/listing-moderation.service";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { Conversation } from "../conversation/converstaion.schema";
import { Message } from "../conversation/message.schema";
import { Tenancy } from "../tenancies/tenancy.schema";

const DAY_MS = 86_400_000;
/** Reports count for 30 days; one still open after that is closed with CLOSED_RESPONSE. */
const REPORT_WINDOW_MS = 30 * DAY_MS;
/** Distinct email-verified reporters, each linked to the account, within 30 days that suspend it. */
const REPORTERS_TO_SUSPEND = 3;
const CLOSED_RESPONSE = "Thanks for your report. We keep it on file for 30 days: if other people who dealt with this account report it too, we suspend it automatically.";
// Neutral on purpose: a landlord with one applicant must not learn who reported him.
const HIDDEN_AFTER_REPORT = "Your listing needs a new automatic check: edit and resubmit it.";
const SEVERE_CATEGORIES: FlagTriage["category"][] = ["THREATS_VIOLENCE", "FRAUD_SCAM"];

const TRIAGE_PROMPT =
	"You triage abuse reports for a UK student-housing app. Classify the report: category is one of " +
	TriageCategory.join(", ") +
	"; severity is high for threats of violence, fraud or taking money, medium for harassment or discrimination, low otherwise; " +
	'summary is one neutral sentence of at most 25 words. Answer with JSON only: {"category": string, "severity": string, "summary": string}.';

@Injectable()
export class FlagsService {
	private readonly logger = new Logger(FlagsService.name);

	constructor(
		@InjectModel(Flag.name)
		private readonly flagModel: Model<Flag>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>,
		@Optional() private readonly llm?: LlmClient,
		@Optional() @InjectModel(Listing.name) private readonly listingModel?: Model<Listing>,
		@Optional() @Inject(ThrottlerStorage) private readonly storage?: ThrottlerStorage,
		@Optional() private readonly notifications?: NotificationsService,
		@Optional() @InjectModel(Conversation.name) private readonly conversationModel?: Model<Conversation>,
		@Optional() @InjectModel(Tenancy.name) private readonly tenancyModel?: Model<Tenancy>,
		@Optional() @InjectModel(Message.name) private readonly messageModel?: Model<Message>
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

		// No admin email: reports are handled by the rules below, never by a person.
		const triage = await this.triage(createFlagDto, user).catch((error: Error) => {
			this.logger.warn(`Flag triage failed for ${flag._id.toString()}: ${error?.message}`);
			return null;
		});
		if (triage) await this.flagModel.updateOne({ _id: flag._id }, { $set: { triage } }).exec();
		// The flag is stored: a failed check must not 500 (a retry would duplicate the report).
		await this.enforce(createFlagDto.reportedUser, user, triage).catch((error: Error) =>
			this.logger.error(`Flag enforcement failed for ${flag._id.toString()}: ${error?.message}`)
		);

		return flag.toObject();
	}

	/** Category, severity and summary from the AI; null when no AI answered (the count rule still applies). */
	private async triage(dto: CreateFlagDto, reporter: User): Promise<FlagTriage | null> {
		if (!this.llm?.isConfigured() || !(await withinAiQuota(this.storage, reporter._id.toString()))) return null;
		const answer = await this.llm.complete({
			system: TRIAGE_PROMPT + UNTRUSTED_DATA_RULE,
			messages: [{ role: "user", content: JSON.stringify({ reporterCategory: dto.category, report: dto.text.slice(0, 4000) }) }],
			maxTokens: 150,
			responseSchema: {
				type: "OBJECT",
				properties: { category: { type: "STRING" }, severity: { type: "STRING" }, summary: { type: "STRING" } },
				required: ["category", "severity", "summary"]
			}
		});
		if (!answer) return null;
		const parsed = extractJsonObject(answer.text) as Partial<Record<keyof FlagTriage, unknown>> | null;
		const category = TriageCategory.find(value => value === parsed?.category);
		const severity = TriageSeverity.find(value => value === parsed?.severity);
		if (!category || !severity) return null;
		const summary = typeof parsed?.summary === "string" ? parsed.summary.trim().slice(0, 300) : "";
		// Output filter: no contact or payment details the report text pushed into the summary.
		return { category, severity, summary: addsUnsafeDetails(summary) ? "" : summary, provider: answer.provider };
	}

	/**
	 * Only reporters who really dealt with the account count, so strangers or throwaway
	 * accounts cannot take anyone down. 3 of them in 30 days suspend it; one severe report
	 * takes its listings offline until they pass a new check, without suspending the account.
	 */
	private async enforce(reportedUser: string, reporter: User, triage: FlagTriage | null): Promise<void> {
		const id = new Types.ObjectId(reportedUser);
		const since = new Date(Date.now() - REPORT_WINDOW_MS);
		const reporters = await this.flagModel
			// Open reports only: suspend() closes the ones it acted on, so a lifted suspension is not undone by the next report.
			.distinct("createdBy", { reportedUser: id, status: FlagStatus.UNDER_REVIEW, createdAt: { $gte: since } })
			.exec();
		const verified: Types.ObjectId[] = await this.userModel.distinct("_id", { _id: { $in: reporters }, isVerified: true }).exec();
		const linked = await this.linkedTo(id, verified);
		if (linked.length >= REPORTERS_TO_SUSPEND) {
			return this.suspend(id, `Reported by ${linked.length} verified users who dealt with this account in 30 days`);
		}
		const severe = triage?.severity === "high" && SEVERE_CATEGORIES.includes(triage.category);
		if (!severe || !linked.some(user => user.equals(reporter._id))) return;
		// Once per reporter per 30 days: one account cannot keep a landlord's listings offline by reporting again and again.
		const severeFromReporter = await this.flagModel
			.countDocuments({ reportedUser: id, createdBy: reporter._id, "triage.severity": "high", createdAt: { $gte: since } })
			.exec();
		if (severeFromReporter <= 1) await this.hideListings(id, HIDDEN_AFTER_REPORT);
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
		await this.listingModel
			?.updateMany(
				{ landlord: id, isDraft: false },
				{ $set: { isVerified: false, moderationStatus: ModerationStatus.NEEDS_CHANGES, moderationReasons: [reason], lastUpdated: new Date() } }
			)
			.exec();
	}

	/** Blocks the account (JwtStrategy answers 403), hides its listings and closes open reports about it. */
	async suspend(userId: string | Types.ObjectId, reason: string): Promise<void> {
		const id = new Types.ObjectId(userId.toString());
		const result = await this.userModel
			.updateOne({ _id: id, suspendedAt: null, role: { $ne: Role.SUPERUSER } }, { $set: { suspendedAt: new Date(), suspensionReason: reason } })
			.exec();
		if (result.modifiedCount === 0) return;
		this.logger.warn(`Account ${id.toString()} suspended: ${reason}`);
		await this.hideListings(id, "This account is suspended.");
		// Reporters see the outcome in GET /flags/mine (supportResponse) and in their in-app notifications.
		const reporters = await this.flagModel.distinct("createdBy", { reportedUser: id, status: FlagStatus.UNDER_REVIEW }).exec();
		await this.notifications?.notifyMany(
			reporters.map(reporter => ({
				user: reporter,
				kind: NotificationKind.REPORT_ACTIONED,
				title: "We acted on your report",
				body: "Thanks for your report. We have suspended this account.",
				dedupeKey: `report-actioned:${id.toString()}:${reporter.toString()}`
			}))
		);
		await this.flagModel
			.updateMany(
				{ reportedUser: id, status: FlagStatus.UNDER_REVIEW },
				{ $set: { status: FlagStatus.ACCOUNT_SUSPENDED, resolutionDate: new Date(), supportResponse: "Thanks for your report. We have suspended this account." } }
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
					...(resolveFlagDto.supportResponse !== undefined ? { supportResponse: resolveFlagDto.supportResponse.trim() } : {})
				}
			})
			.exec();
		if (!result) {
			throw new NotFoundException("Flag not found");
		}
		if (resolveFlagDto.status === FlagStatus.ACCOUNT_SUSPENDED) {
			await this.suspend(result.reportedUser, "Suspended by Seek support");
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
