import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "./users.schema";
import { InviteTeamMemberDto, TeamInviteDto, TeamMemberDto } from "./dto/team.dto";
import { Role } from "../auth/role.enum";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { Payment } from "../payments/payment.schema";
import { PaymentStatus, PayoutStatus } from "../payments/payment.enums";
import { DocumentShare } from "./shares/document-share.schema";
import { ConnectionStatus, EmailConnection } from "../connectors/email-connection.schema";
import { ConnectorsService } from "../connectors/connectors.service";
import { UploadService } from "../upload/upload.service";
import { isKeyOwnedBy } from "../upload/object-key";
import { Listing } from "../listings/listings.schema";
import { ModerationStatus } from "../listings/enums/moderation-status.enum";
import { ContractsService } from "../contracts/contracts.service";
import { ApplicationService } from "../application/application.service";
import { MailService } from "../auth/mail.service";
import { EmailMessage } from "../inbox/email-message.schema";
import { DocumentType, IDENTITY_DOCUMENT_TYPES } from "./types/document-type";
import { NotificationsService } from "../notifications/notifications.service";
import { NotificationKind } from "../notifications/notification-kind.enum";
import { notificationTarget, NotificationTargetKind } from "../notifications/links";

const MAX_TEAM = 20;
/** Privacy policy: identity documents are kept 30 days after their last share with a landlord. */
export const IDENTITY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Object key of a stored public file (`https://bucket.s3.region.amazonaws.com/<key>`), or null if not a public/ key. */
function publicKeyFromUrl(url: string): string | null {
	try {
		const key = new URL(url).pathname.slice(1);
		return key.startsWith("public/") ? key : null;
	} catch {
		return null;
	}
}

/** A landlord's team, and closing an account. */
@Injectable()
export class AccountService {
	private readonly logger = new Logger(AccountService.name);
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(DocumentShare.name) private readonly shareModel: Model<DocumentShare>,
		@InjectModel(EmailConnection.name) private readonly connectionModel: Model<EmailConnection>,
		private readonly connectors: ConnectorsService,
		private readonly uploads: UploadService,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(EmailMessage.name) private readonly messageModel: Model<EmailMessage>,
		// Looked up at call time: importing ContractsModule here would loop back through AuthModule to UsersModule.
		private readonly moduleRef?: ModuleRef,
		private readonly mail?: MailService,
		private readonly notifications?: NotificationsService
	) {}

	async listTeam(ownerId: Types.ObjectId): Promise<TeamMemberDto[]> {
		const owner = await this.userModel.findById(ownerId).select("team").lean().exec();
		const accounts = await this.userModel
			.find({ _id: { $in: (owner?.team ?? []).map(member => member.user).filter(Boolean) } }, { name: 1 })
			.lean()
			.exec();
		const names = new Map(accounts.map(account => [account._id.toString(), account.name]));
		return (owner?.team ?? []).map(member => ({
			id: member._id.toString(),
			email: member.email,
			name: member.user ? names.get(member.user.toString()) ?? null : null,
			scopes: member.scopes,
			hasAccount: Boolean(member.user),
			invitedAt: member.invitedAt,
			canSeePayouts: false
		}));
	}

	/** Adds the email to the team, or updates its scopes if it is already there. */
	async invite(owner: Pick<User, "_id" | "email" | "name"> & { teamOf?: unknown }, dto: InviteTeamMemberDto) {
		// This route acts as the caller: a member's invitee would join the member's empty account, not the owner's.
		if (owner.teamOf) throw new ForbiddenException("Only the account owner can invite people to the team.");
		const email = dto.email.trim().toLowerCase();
		if (email === owner.email?.toLowerCase()) throw new BadRequestException("You are already the owner of this account.");
		// Accepting is landlord-only and emails are unique, so a student's invite could never be accepted.
		const existing = await this.userModel.findOne({ email }).select("role").lean().exec();
		if (existing && existing.role !== Role.LANDLORD_AGENCY) {
			throw new BadRequestException("That email belongs to a student account. Ask them to use a landlord email.");
		}
		const scopes = [...new Set(dto.scopes)];
		const updated = await this.userModel.updateOne(
			{ _id: owner._id, "team.email": email },
			{ $set: { "team.$.scopes": scopes } }
		);
		if (!updated.matchedCount) {
			// Stays pending (user: null) until the invitee accepts; never bound automatically.
			const pushed = await this.userModel.updateOne(
				{ _id: owner._id, "team.email": { $ne: email }, [`team.${MAX_TEAM - 1}`]: { $exists: false } },
				{ $push: { team: { email, scopes, user: null, invitedAt: new Date() } } }
			);
			if (!pushed.matchedCount) throw new BadRequestException(`A team can have up to ${MAX_TEAM} people.`);
			await this.mail?.sendTeamInviteEmail(email, owner.name || "A landlord").catch(err => this.logger.error(`Team invite email failed: ${err}`));
		}
		return (await this.listTeam(owner._id)).find(member => member.email === email)!;
	}

	/** Pending invites addressed to this account's verified email. */
	async listInvites(user: Pick<User, "email" | "isVerified">): Promise<TeamInviteDto[]> {
		if (!user.isVerified || !user.email) return [];
		const email = user.email.toLowerCase();
		const owners = await this.userModel
			.find(
				{ deletedAt: null, role: Role.LANDLORD_AGENCY, team: { $elemMatch: { email, user: null } } },
				{ name: 1, team: 1 }
			)
			.lean()
			.exec();
		return owners.map(owner => {
			const invite = owner.team.find(member => member.email === email && !member.user)!;
			return { ownerId: owner._id.toString(), ownerName: owner.name, scopes: invite.scopes, invitedAt: invite.invitedAt };
		});
	}

	/** Binds a pending invite to the caller, who must hold the invited, verified email. */
	async acceptInvite(user: Pick<User, "_id" | "email" | "isVerified">, ownerId: string) {
		if (!user.isVerified || !user.email) throw new ForbiddenException("Verify your email before joining a team.");
		// findTeamOwner acts for the first team found, so a second one would never apply.
		if (await this.userModel.exists({ "team.user": user._id, deletedAt: null })) {
			throw new ConflictException("You are already on a team. Leave it first.");
		}
		const result = await this.userModel.updateOne(
			{
				_id: new Types.ObjectId(ownerId),
				deletedAt: null,
				role: Role.LANDLORD_AGENCY,
				team: { $elemMatch: { email: user.email.toLowerCase(), user: null } }
			},
			{ $set: { "team.$.user": user._id } }
		);
		if (!result.matchedCount) throw new NotFoundException("Invite not found.");
	}

	/** Leaves every team the caller joined. */
	async leaveTeam(userId: Types.ObjectId) {
		const result = await this.userModel.updateMany({ "team.user": userId }, { $pull: { team: { user: userId } } });
		if (!result.modifiedCount) throw new NotFoundException("You are not on a team.");
	}

	async removeTeamMember(ownerId: Types.ObjectId, memberId: string) {
		const result = await this.userModel.updateOne(
			{ _id: ownerId, "team._id": new Types.ObjectId(memberId) },
			{ $pull: { team: { _id: new Types.ObjectId(memberId) } } }
		);
		if (!result.modifiedCount) throw new NotFoundException("Team member not found.");
	}

	/**
	 * Soft delete: the record stays for tenancy and payment history, but the
	 * account can no longer sign in (sessions and password cleared, email
	 * replaced). Refused while an active tenancy still has unpaid rent, or while
	 * Seek still holds collected rent for this landlord (it could never be paid out after).
	 * Mailboxes are disconnected (token revoked, synced emails deleted), landlord
	 * shares revoked, listings unpublished and Seek Passport files erased first, so a failure leaves
	 * the account intact and the user can retry. Tenancy files, contracts and
	 * payments are kept: they belong to the tenancy record, not the profile.
	 */
	/**
	 * Keys a tenancy, a contract or a synced email still points at: those files must stay.
	 * `leavingUser`'s own emails are ignored, as they are deleted with the account.
	 */
	private async referencedKeys(candidates: string[], leavingUser?: Types.ObjectId): Promise<Set<string>> {
		if (!candidates.length) return new Set();
		const tenancyKeys = (await this.tenancyModel.distinct("documents.key", { "documents.key": { $in: candidates } })).map(String);
		const contractKeys = this.moduleRef
			? await this.moduleRef.get(ContractsService, { strict: false }).referencedDocumentKeys(candidates)
			: candidates;
		const messageKeys = (await this.messageModel.distinct("attachments.key", {
			...(leavingUser ? { user: { $ne: leavingUser } } : {}),
			"attachments.key": { $in: candidates }
		})).map(String);
		return new Set([...tenancyKeys, ...contractKeys, ...messageKeys]);
	}

	/** A Seek Passport file replaced by a new upload is erased, unless the account or anything else still uses it. A failure only logs. */
	async eraseReplacedDocument(userId: Types.ObjectId, key?: string) {
		if (!key?.startsWith("private/") || !isKeyOwnedBy(key, userId.toString())) return;
		try {
			if (await this.userModel.exists({ _id: userId, "documents.key": key })) return;
			if ((await this.referencedKeys([key])).has(key)) return;
			await this.uploads.deletePrivateObject(key);
		} catch (error) {
			this.logger.warn(`Erasing replaced document for ${userId.toString()} failed: ${(error as Error).message}`);
		}
	}

	/**
	 * Privacy policy: identity documents are erased 30 days after the student last shared them with a landlord.
	 * Never-shared ones stay. The entry is removed so the Passport shows the item as missing and the student can
	 * upload again; the file stays when a tenancy, contract or email still points at it. Returns how many were erased.
	 */
	async eraseStaleIdentityDocuments(now: Date = new Date(), limit = 200): Promise<number> {
		const cutoff = new Date(now.getTime() - IDENTITY_RETENTION_MS);
		const isStale = (doc: { type: DocumentType; lastSharedAt?: Date }) =>
			IDENTITY_DOCUMENT_TYPES.includes(doc.type) && !!doc.lastSharedAt && new Date(doc.lastSharedAt) < cutoff;
		const users = await this.userModel
			.find({ documents: { $elemMatch: { type: { $in: IDENTITY_DOCUMENT_TYPES }, lastSharedAt: { $lt: cutoff } } } })
			.select("documents")
			.limit(limit)
			.lean()
			.exec();
		const stale = users.flatMap(user => (user.documents ?? []).filter(isStale).map(doc => ({ user, doc })));
		const referenced = await this.referencedKeys(
			stale.map(({ doc }) => doc.key).filter((key): key is string => !!key?.startsWith("private/"))
		);
		let erased = 0;
		const told = new Set<string>();
		for (const { user, doc } of stale) {
			try {
				// Another document of the same account may still use the file (same key under a fresher entry).
				const keptByAccount = (user.documents ?? []).some(other => other !== doc && !isStale(other) && other.key === doc.key);
				if (doc.key?.startsWith("private/") && isKeyOwnedBy(doc.key, user._id.toString()) && !referenced.has(doc.key) && !keptByAccount) {
					await this.uploads.deletePrivateObject(doc.key);
				}
				// Matches the stale entry only: a re-upload in the meantime has no (or a fresh) lastSharedAt.
				await this.userModel.updateOne(
					{ _id: user._id },
					{ $pull: { documents: { type: doc.type, lastSharedAt: { $lt: cutoff } } } }
				);
				erased += 1;
				told.add(user._id.toString());
			} catch (error) {
				this.logger.warn(`Erasing identity document ${doc.type} for ${user._id.toString()} failed: ${(error as Error).message}`);
			}
		}
		// A missing ID can drop the student's household out of the queue: tell them once, so they can upload again.
		await this.notifications?.notifyMany([...told].map(user => ({
			user,
			kind: NotificationKind.IDENTITY_DOCUMENTS_ERASED,
			title: "We deleted your identity documents",
			body: "For your privacy we delete ID documents 30 days after you last shared them. Upload them again to stay in the queue.",
			...notificationTarget("student", NotificationTargetKind.APPLICATION),
			dedupeKey: `identity-erased:${now.toISOString().slice(0, 10)}`
		})));
		return erased;
	}

	async deleteAccount(userId: Types.ObjectId) {
		const tenancies = await this.tenancyModel
			// An ENDED tenancy can still owe arrears (fixed terms now end on their own date).
			.find({ status: { $in: [TenancyStatus.ACTIVE, TenancyStatus.ENDED] }, $or: [{ tenants: userId }, { landlord: userId }] })
			.select("_id")
			.lean()
			.exec();
		if (tenancies.length) {
			const unpaid = await this.paymentModel.exists({
				tenancy: { $in: tenancies.map(tenancy => tenancy._id) },
				// Rent cancelled by an early end is no longer owed.
				status: { $nin: [PaymentStatus.PAID, PaymentStatus.CANCELLED] },
				$or: [{ tenant: userId }, { landlord: userId }]
			});
			if (unpaid) {
				throw new ConflictException(
					"You still have rent to pay or collect on a tenancy. End the tenancy or settle it before deleting your account."
				);
			}
		}
		// The payout sweep skips a deleted landlord, so rent Seek still holds for them would never be paid out.
		const heldPayout = await this.paymentModel.exists({
			landlord: userId,
			status: PaymentStatus.PAID,
			payoutStatus: PayoutStatus.HELD,
			refundDue: { $ne: true },
			$expr: { $gt: [{ $subtract: [{ $subtract: ["$amount", { $ifNull: ["$refundedAmount", 0] }] }, "$seekFee"] }, 0] }
		});
		if (heldPayout) {
			throw new ConflictException("Seek is still holding rent collected for you. Finish setting up payouts so it can be paid out before deleting your account.");
		}
		// A checkout opened before deletion could still complete and leave money held for a deleted landlord.
		const openCheckout = await this.paymentModel.exists({ landlord: userId, status: PaymentStatus.PENDING, providerRef: /^(cs_|pi_)/ });
		if (openCheckout) {
			throw new ConflictException("A payment to you is still in progress. Wait for it to complete or expire before deleting your account.");
		}
		const deletedAt = new Date();
		const importedAttachmentKeys = (await this.messageModel.distinct("attachments.key", {
			user: userId,
			"attachments.key": { $type: "string" }
		})).map(String).filter(key => key.startsWith("private/"));
		const connections = await this.connectionModel
			.find({ user: userId, status: { $ne: ConnectionStatus.DISCONNECTED } })
			.select("_id")
			.lean()
			.exec();
		for (const connection of connections) await this.connectors.disconnect({ _id: userId }, connection._id.toString());
		await this.shareModel.updateMany({ owner: userId, revokedAt: null }, { $set: { revokedAt: deletedAt } });
		// A tenancy still waiting on invites can never activate without this account (nor should it schedule rent to it): call it off.
		await this.tenancyModel.updateMany(
			{ status: TenancyStatus.PENDING_ACCEPTANCE, $or: [{ tenants: userId }, { pendingTenants: userId }, { landlord: userId }] },
			{ $set: { status: TenancyStatus.ENDED } }
		);
		// Take the landlord's listings offline, as a suspension does; NEEDS_CHANGES keeps the moderation retry from re-approving them.
		await this.listingModel.updateMany(
			{ landlord: userId, isDraft: false },
			{ $set: { isVerified: false, moderationStatus: ModerationStatus.NEEDS_CHANGES, moderationReasons: ["This account was deleted."], lastUpdated: deletedAt } }
		);
		// Repair photos stay with the property's repair history (owner decision 2026-11-19); the student shows as "Deleted user".
		const profile = await this.userModel.findById(userId).select("documents.key profilePicUrl").lean().exec();
		const keys = [...new Set([
			...(profile?.documents ?? []).map(doc => doc.key),
			...importedAttachmentKeys
		].filter((key): key is string => !!key?.startsWith("private/")))];
		const picKey = profile?.profilePicUrl ? publicKeyFromUrl(profile.profilePicUrl) : null;
		const referencedCandidates = picKey ? [...keys, picKey] : keys;
		// A file referenced anywhere else stays: another account or tenancy still needs it.
		const referenced = await this.referencedKeys(referencedCandidates, userId);
		for (const key of keys) {
			if (!referenced.has(key)) {
				await this.uploads.deletePrivateObject(key);
			}
		}
		// Uploaded avatar (public/<userId>/...): erase the object too. A Google avatar URL is not ours, so it is skipped.
		if (picKey && isKeyOwnedBy(picKey, userId.toString()) && !referenced.has(picKey)) await this.uploads.deletePublicObject(picKey);
		const result = await this.userModel.updateOne(
			{ _id: userId, deletedAt: null },
			{
				$set: {
					deletedAt,
					email: `deleted-${userId.toString()}@deleted.invalid`,
					refreshSessions: [],
					pushTokens: [],
					isGoogle: false,
					team: [],
					name: "Deleted user",
					documents: [],
					referenceRequests: []
				},
				$unset: {
					password: 1,
					username: 1,
					phone: 1,
					pendingEmail: 1,
					pendingEmailToken: 1,
					resetPasswordToken: 1,
					emailVerificationToken: 1,
					otpVerificationCode: 1,
					// Frees the university address so it can be verified again on a new account.
					universityEmail: 1,
					dateOfBirth: 1,
					profilePicUrl: 1,
						universityDetails: 1,
						university: 1,
						studentVerifiedAt: 1,
						studentEmailPending: 1,
						studentEmailCodeHash: 1,
						studentEmailCodeExpires: 1,
						studentEmailAttempts: 1,
						companyName: 1,
						registrations: 1,
						notificationPrefs: 1,
						rentReminderSchedule: 1,
						connectorSettings: 1,
						payoutBank: 1,
						lastSeen: 1,
						emailVerificationTokenExpires: 1,
						emailVerificationAttempts: 1,
						emailVerificationLastSentAt: 1,
						emailVerificationWindowStartedAt: 1,
						emailVerificationSendCount: 1,
						pendingEmailExpires: 1,
						pendingEmailLastSentAt: 1,
						pendingEmailWindowStartedAt: 1,
						pendingEmailSendCount: 1,
						resetPasswordExpires: 1,
						resetPasswordLastSentAt: 1,
						resetPasswordWindowStartedAt: 1,
						resetPasswordSendCount: 1,
						weeklySummarySentAt: 1,
						stripeAccountId: 1,
						stripeCustomerId: 1
					}
			}
		);
		if (!result.matchedCount) throw new NotFoundException("Account not found.");
		// Drop the address from other landlords' teams too.
		await this.userModel.updateMany({ "team.user": userId }, { $pull: { team: { user: userId } } });
		// Co-tenants' signing and deductions stop waiting for this account. It is already deleted, so a failure only logs.
		await this.moduleRef
			?.get(ContractsService, { strict: false })
			.settleForDeletedTenant(userId)
			.catch(error => this.logger.warn(`Contract re-check after deleting ${userId.toString()} failed: ${(error as Error).message}`));
		// Households this account was in must not keep a deleted owner or member nobody can replace.
		await this.moduleRef
			?.get(ApplicationService, { strict: false })
			.releaseDeletedMember(userId)
			.catch(error => this.logger.warn(`Leaving applications after deleting ${userId.toString()} failed: ${(error as Error).message}`));
		return { deletedAt };
	}
}
