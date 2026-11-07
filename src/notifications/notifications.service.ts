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
				return result.upsertedCount > 0;
			}
			await this.notificationModel.create(doc);
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
