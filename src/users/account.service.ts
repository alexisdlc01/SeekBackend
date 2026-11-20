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

const MAX_TEAM = 20;

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
		private readonly mail?: MailService
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
	async invite(owner: Pick<User, "_id" | "email" | "name">, dto: InviteTeamMemberDto) {
		const email = dto.email.trim().toLowerCase();
		if (email === owner.email?.toLowerCase()) throw new BadRequestException("You are already the owner of this account.");
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
	async deleteAccount(userId: Types.ObjectId) {
		const tenancies = await this.tenancyModel
			.find({ status: TenancyStatus.ACTIVE, $or: [{ tenants: userId }, { landlord: userId }] })
			.select("_id")
			.lean()
			.exec();
		if (tenancies.length) {
			const unpaid = await this.paymentModel.exists({
				tenancy: { $in: tenancies.map(tenancy => tenancy._id) },
				status: { $ne: PaymentStatus.PAID },
				$or: [{ tenant: userId }, { landlord: userId }]
			});
			if (unpaid) {
				throw new ConflictException(
					"You still have rent to pay or collect on an active tenancy. End the tenancy or settle it before deleting your account."
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
		const tenancyKeys = new Set(
			referencedCandidates.length ? (await this.tenancyModel.distinct("documents.key", { "documents.key": { $in: referencedCandidates } })).map(String) : []
		);
		const contractKeys = new Set(
			this.moduleRef
				? await this.moduleRef.get(ContractsService, { strict: false }).referencedDocumentKeys(referencedCandidates)
				: referencedCandidates
		);
		const otherMessageKeys = new Set(
			referencedCandidates.length
				? (await this.messageModel.distinct("attachments.key", { user: { $ne: userId }, "attachments.key": { $in: referencedCandidates } })).map(String)
				: []
		);
		for (const key of keys) {
			if (!tenancyKeys.has(key) && !contractKeys.has(key) && !otherMessageKeys.has(key)) {
				await this.uploads.deletePrivateObject(key);
			}
		}
		// Uploaded avatar (public/<userId>/...): erase the object too. A Google avatar URL is not ours, so it is skipped.
		if (
			picKey
			&& isKeyOwnedBy(picKey, userId.toString())
			&& !tenancyKeys.has(picKey)
			&& !contractKeys.has(picKey)
			&& !otherMessageKeys.has(picKey)
		) await this.uploads.deletePublicObject(picKey);
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
