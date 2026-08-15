import { ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { RefreshSession, User } from "./users.schema";
import { Model } from "mongoose";

type CreateUserData = Pick<User, "email" | "name"> & Partial<User>;

@Injectable()
export class UsersRepository {
	constructor(@InjectModel(User.name) private readonly userModel: Model<User>) { }

	async getUserById(id: string): Promise<User | null> {
		return await this.userModel.findById(id);
	}

	async getUserByEmail(email: string): Promise<User | null> {
		return await this.userModel.findOne({
			email: email.trim().toLowerCase(),
		});
	}

	async create(data: CreateUserData): Promise<User | null> {
		try {
			return await this.userModel.create(data);
		} catch (err) {
			if (err.code === 11000 && err.keyPattern?.email) {
				throw new ConflictException("Email already in use.");
			}
			return null;
		}
	}

	async createPaswordless(data: CreateUserData): Promise<User | null> {
		return await this.userModel.create(data);
	}

	async addRefreshSession(
		userId: string,
		session: RefreshSession,
		maxSessions: number
	): Promise<boolean> {
		await this.userModel.updateOne(
			{ _id: userId },
			{ $pull: { refreshSessions: { expiresAt: { $lte: new Date() } } } }
		);

		const result = await this.userModel.updateOne(
			{ _id: userId },
			{
				$push: {
					refreshSessions: {
						$each: [session],
						$slice: -maxSessions
					}
				}
			}
		);

		return result.matchedCount === 1;
	}

	async rotateRefreshSession(
		userId: string,
		sessionId: string,
		previousTokenHash: string,
		nextTokenHash: string,
		expiresAt: Date
	): Promise<boolean> {
		const updated = await this.userModel.findOneAndUpdate(
			{
				_id: userId,
				refreshSessions: {
					$elemMatch: {
						sessionId,
						tokenHash: previousTokenHash,
						expiresAt: { $gt: new Date() }
					}
				}
			},
			{
				$set: {
					"refreshSessions.$.tokenHash": nextTokenHash,
					"refreshSessions.$.expiresAt": expiresAt,
					"refreshSessions.$.lastUsedAt": new Date()
				}
			},
			{ new: true }
		);

		return updated !== null;
	}

	async removeRefreshSession(userId: string, sessionId: string): Promise<void> {
		await this.userModel.updateOne(
			{ _id: userId },
			{ $pull: { refreshSessions: { sessionId } } }
		);
	}

	async clearRefreshSessions(userId: string): Promise<void> {
		await this.userModel.updateOne(
			{ _id: userId },
			{ $set: { refreshSessions: [] } }
		);
	}

	async consumePasswordReset(
		userId: string,
		resetTokenHash: string,
		passwordHash: string
	): Promise<boolean> {
		const updated = await this.userModel.findOneAndUpdate(
			{
				_id: userId,
				resetPasswordToken: resetTokenHash,
				resetPasswordExpires: { $gt: new Date() }
			},
			{
				$set: {
					password: passwordHash,
					refreshSessions: []
				},
				$unset: {
					resetPasswordToken: 1,
					resetPasswordExpires: 1
				}
			}
		);

		return updated !== null;
	}
}
