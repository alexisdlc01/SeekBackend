import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { User } from "./users.schema";
import { InviteTeamMemberDto, TeamInviteDto, TeamMemberDto } from "./dto/team.dto";
import { Role } from "../auth/role.enum";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { Payment } from "../payments/payment.schema";
import { PaymentStatus } from "../payments/payment.enums";
import { DocumentShare } from "./shares/document-share.schema";
import { ConnectionStatus, EmailConnection } from "../connectors/email-connection.schema";
import { ConnectorsService } from "../connectors/connectors.service";
import { UploadService } from "../upload/upload.service";
import { isKeyOwnedBy } from "../upload/object-key";

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
	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(DocumentShare.name) private readonly shareModel: Model<DocumentShare>,
		@InjectModel(EmailConnection.name) private readonly connectionModel: Model<EmailConnection>,
		private readonly connectors: ConnectorsService,
		private readonly uploads: UploadService
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
	async invite(owner: Pick<User, "_id" | "email">, dto: InviteTeamMemberDto) {
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
	 * replaced). Refused while an active tenancy still has unpaid rent.
	 * Mailboxes are disconnected (token revoked, synced emails deleted), landlord
	 * shares revoked and Seek Passport files erased first, so a failure leaves
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
		const deletedAt = new Date();
		const connections = await this.connectionModel
			.find({ user: userId, status: { $ne: ConnectionStatus.DISCONNECTED } })
			.select("_id")
			.lean()
			.exec();
		for (const connection of connections) await this.connectors.disconnect({ _id: userId }, connection._id.toString());
		await this.shareModel.updateMany({ owner: userId, revokedAt: null }, { $set: { revokedAt: deletedAt } });
		const profile = await this.userModel.findById(userId).select("documents.key profilePicUrl").lean().exec();
		const keys = (profile?.documents ?? []).map(doc => doc.key).filter(key => key?.startsWith("private/"));
		// A file also filed on a tenancy stays: the landlord and co-tenants keep that record.
		const tenancyKeys = new Set(
			keys.length ? (await this.tenancyModel.distinct("documents.key", { "documents.key": { $in: keys } })).map(String) : []
		);
		for (const key of keys) if (!tenancyKeys.has(key)) await this.uploads.deletePrivateObject(key);
		// Uploaded avatar (public/<userId>/...): erase the object too. A Google avatar URL is not ours, so it is skipped.
		const picKey = profile?.profilePicUrl ? publicKeyFromUrl(profile.profilePicUrl) : null;
		if (picKey && isKeyOwnedBy(picKey, userId.toString())) await this.uploads.deletePublicObject(picKey);
		const result = await this.userModel.updateOne(
			{ _id: userId, deletedAt: null },
			{
				$set: {
					deletedAt,
					email: `deleted-${userId.toString()}@deleted.invalid`,
					refreshSessions: [],
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
					university: 1
				}
			}
		);
		if (!result.matchedCount) throw new NotFoundException("Account not found.");
		// Drop the address from other landlords' teams too.
		await this.userModel.updateMany({ "team.user": userId }, { $pull: { team: { user: userId } } });
		return { deletedAt };
	}
}
