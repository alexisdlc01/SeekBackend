import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Notification } from "./notification.schema";
import { NotificationKind } from "./notification-kind.enum";
import { NotificationTarget } from "./links";
import { NotificationPrefs, User } from "../users/users.schema";

export interface NotificationInput {
	user: Types.ObjectId | string;
	kind: NotificationKind;
	title: string;
	body?: string;
	link?: string;
	target?: NotificationTarget;
	/** Same user + key is stored once, so retries and sweeps never duplicate. */
	dedupeKey?: string;
}

type BooleanPref = {
	[K in keyof NotificationPrefs]: NotificationPrefs[K] extends boolean ? K : never;
}[keyof NotificationPrefs];

/** Defaults used when a user has never saved their preferences. */
const PREF_DEFAULTS: Record<BooleanPref, boolean> = {
	receiptEveryPayment: true,
	landlordEveryPayment: true,
	newQualifiedHousehold: true,
	complianceDue: true,
	weeklySummary: false
};

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const MAX_PUSH_TOKENS = 10;

@Injectable()
export class NotificationsService {
	private readonly logger = new Logger(NotificationsService.name);

	constructor(
		@InjectModel(Notification.name)
		private readonly notificationModel: Model<Notification>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>
	) {}

	/**
	 * Stores an in-app notification. When `pref` is given the user's
	 * notification preferences decide whether it is sent. Never throws:
	 * a failed notification must not fail the payment or action behind it.
	 */
	async notify(input: NotificationInput, pref?: BooleanPref): Promise<boolean> {
		try {
			if (pref && !(await this.allows(input.user, pref))) return false;
			const user = new Types.ObjectId(input.user.toString());
			const doc = {
				user,
				kind: input.kind,
				title: input.title,
				body: input.body,
				link: input.link,
				target: input.target,
				readAt: null
			};
			if (input.dedupeKey) {
				const result = await this.notificationModel.updateOne(
					{ user, dedupeKey: input.dedupeKey },
					{ $setOnInsert: { ...doc, dedupeKey: input.dedupeKey } },
					{ upsert: true }
				);
				if (result.upsertedCount > 0) {
					void this.push(user, input, result.upsertedId?.toString());
				}
				return result.upsertedCount > 0;
			}
			const created = await this.notificationModel.create(doc);
			void this.push(user, input, created._id?.toString());
			return true;
		} catch (error) {
			if ((error as { code?: number })?.code === 11000) return false;
			this.logger.warn(`Notification not stored: ${(error as Error)?.message}`);
			return false;
		}
	}

	async notifyMany(inputs: NotificationInput[], pref?: BooleanPref): Promise<void> {
		await Promise.all(inputs.map(input => this.notify(input, pref)));
	}

	async addPushToken(userId: string, token: string) {
		// A device belongs to one account: drop the token from any other user first.
		await this.userModel.updateMany(
			{ _id: { $ne: userId }, pushTokens: token },
			{ $pull: { pushTokens: token } }
		);
		// One atomic update: drop any copy, append, keep the newest MAX_PUSH_TOKENS.
		await this.userModel.updateOne({ _id: userId }, [
			{
				$set: {
					pushTokens: {
						$slice: [
							{
								$concatArrays: [
									{
										$filter: {
											input: { $ifNull: ["$pushTokens", []] },
											cond: { $ne: ["$$this", token] }
										}
									},
									[token]
								]
							},
							-MAX_PUSH_TOKENS
						]
					}
				}
			}
		]);
	}

	async removePushToken(userId: string, token: string) {
		await this.userModel.updateOne({ _id: userId }, { $pull: { pushTokens: token } });
	}

	/** Fire-and-forget Expo push; never throws. Drops tokens Expo reports as unregistered. */
	private async push(userId: Types.ObjectId, input: NotificationInput, notificationId?: string) {
		try {
			const user = await this.userModel.findById(userId, { pushTokens: 1 }).lean().exec();
			const tokens = user?.pushTokens ?? [];
			if (!tokens.length) return;
			const mobile = input.target?.mobile;
			// Deposit deductions carry the tenancy id: open that tenancy's deposit, not the current one.
			const path = mobile === "/(app)/deposit" && input.target?.id ? `${mobile}?tenancy=${encodeURIComponent(input.target.id)}` : mobile;
			const data = { notificationId, link: input.link, path };
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				Accept: "application/json"
			};
			if (process.env.EXPO_ACCESS_TOKEN) {
				headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
			}
			// At most MAX_PUSH_TOKENS per user, well under Expo's 100-message limit.
			const response = await fetch(EXPO_PUSH_URL, {
				method: "POST",
				headers,
				body: JSON.stringify(
					tokens.map(to => ({ to, title: input.title, body: input.body, data, sound: "default" }))
				),
				signal: AbortSignal.timeout(10_000)
			});
			const json = (await response.json()) as {
				data?: { status?: string; details?: { error?: string } }[];
			};
			const dead = tokens.filter(
				(_, index) => json.data?.[index]?.details?.error === "DeviceNotRegistered"
			);
			if (dead.length) {
				await this.userModel.updateOne({ _id: userId }, { $pull: { pushTokens: { $in: dead } } });
			}
		} catch (error) {
			this.logger.warn(`Push not sent: ${(error as Error)?.message}`);
		}
	}

	async listForUser(userId: string, limit = 50) {
		return this.notificationModel
			.find({ user: new Types.ObjectId(userId) }, { dedupeKey: 0, __v: 0 })
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean()
			.exec();
	}

	async markRead(userId: string, notificationId: string) {
		const notification = await this.notificationModel
			.findOneAndUpdate(
				{ _id: notificationId, user: new Types.ObjectId(userId) },
				[{ $set: { readAt: { $ifNull: ["$readAt", "$$NOW"] } } }],
				{ new: true, projection: { dedupeKey: 0, __v: 0 } }
			)
			.lean()
			.exec();
		if (!notification) {
			throw new NotFoundException("Notification not found.");
		}
		return notification;
	}

	private async allows(userId: Types.ObjectId | string, pref: BooleanPref) {
		const user = await this.userModel
			.findById(userId, { notificationPrefs: 1 })
			.lean()
			.exec();
		const value = user?.notificationPrefs?.[pref];
		return typeof value === "boolean" ? value : PREF_DEFAULTS[pref];
	}
}
