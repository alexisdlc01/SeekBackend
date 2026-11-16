import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Payment } from "./payment.schema";
import { PaymentStatus, PayoutStatus } from "./payment.enums";
import { formatPence } from "./payments.service";
import { Application } from "../application/application.schema";
import { Listing } from "../listings/listings.schema";
import { Tenancy } from "../tenancies/tenancy.schema";
import { TenancyStatus } from "../tenancies/tenancy.enums";
import { listingCompliance, tenancyCompliance } from "../tenancies/compliance";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { MailService } from "../auth/mail.service";

const DAY_MS = 24 * 60 * 60 * 1000;

function londonMsSinceMidnight(date: Date) {
	const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(date);
	const part = (type: string) => Number(parts.find(p => p.type === type)?.value);
	return ((part("hour") * 60 + part("minute")) * 60 + part("second")) * 1000 + date.getMilliseconds();
}

// Monday 00:00 Europe/London of the week containing `date`. Stepping whole days can land an hour off across a DST change, so re-align to London midnight.
function londonWeekStart(date: Date) {
	const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(date);
	const daysBack = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(weekday);
	const guess = new Date(date.getTime() - londonMsSinceMidnight(date) - daysBack * DAY_MS);
	const off = londonMsSinceMidnight(guess);
	return new Date(guess.getTime() - (off < DAY_MS / 2 ? off : off - DAY_MS));
}

/** Emails opted-in landlords a weekly digest. Daily tick; each landlord with something to report is sent at most once per London week (Mon 00:00), so a failed send is retried on the next tick. Disabled under NODE_ENV=test. */
@Injectable()
export class WeeklySummarySweeper implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(WeeklySummarySweeper.name);
	private interval?: NodeJS.Timeout;
	private firstRun?: NodeJS.Timeout;
	private running = false;

	constructor(
		@InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
		@InjectModel(Application.name) private readonly applicationModel: Model<Application>,
		@InjectModel(Listing.name) private readonly listingModel: Model<Listing>,
		@InjectModel(Tenancy.name) private readonly tenancyModel: Model<Tenancy>,
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly mail: MailService,
		private readonly config: ConfigService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		this.firstRun = setTimeout(() => void this.run(), 5 * 60_000);
		this.interval = setInterval(() => void this.run(), DAY_MS);
		this.firstRun.unref();
		this.interval.unref();
	}

	onModuleDestroy() {
		if (this.firstRun) clearTimeout(this.firstRun);
		if (this.interval) clearInterval(this.interval);
	}

	private async run() {
		if (this.running) return;
		this.running = true;
		try {
			const now = new Date();
			await this.sendAll(now);
		} catch (error) {
			this.logger.error(`Weekly summary failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}

	async sendAll(now: Date = new Date()) {
		const landlords = await this.userModel
			.find({ role: Role.LANDLORD_AGENCY, deletedAt: null, "notificationPrefs.weeklySummary": true }, { email: 1, name: 1, weeklySummarySentAt: 1 })
			.lean()
			.exec();
		for (const landlord of landlords) {
			// One landlord's failure must not stop the others.
			await this.sendOne(landlord, now).catch(error => this.logger.error(`Weekly summary for ${landlord._id} failed: ${(error as Error)?.message}`));
		}
	}

	private async sendOne(landlord: { _id: unknown; email: string; name: string; weeklySummarySentAt?: Date | null }, now: Date) {
		// Never re-count what the previous digest already covered; 14 days so a failed send does not drop events.
		const weekAgo = now.getTime() - 14 * DAY_MS;
		const since = new Date(Math.max(weekAgo, landlord.weeklySummarySentAt?.getTime() ?? 0));
		const horizon = new Date(now.getTime() + 30 * DAY_MS);
		const [applications, paid, listings, tenancies] = await Promise.all([
			this.applicationModel.countDocuments({ landlord: landlord._id, sentAt: { $gte: since } }),
			this.paymentModel.find({ landlord: landlord._id, status: PaymentStatus.PAID, paidAt: { $gte: since } }, { payout: 1, payoutStatus: 1 }).lean().exec(),
			this.listingModel
				.find({
					landlord: landlord._id,
					$or: [
						{ gasSafetyExpiry: { $lte: horizon } },
						{ eicrExpiry: { $lte: horizon } },
						{ epcExpiry: { $lte: horizon } },
						{ hmoLicenceExpiry: { $lte: horizon } }
					]
				})
				.lean()
				.exec(),
			this.tenancyModel
				.find({ landlord: landlord._id, status: TenancyStatus.ACTIVE, depositProtectedAt: null, depositAmount: { $gt: 0 } })
				.populate({ path: "listing", select: "propertyTitle streetAddress nation" })
				.lean()
				.exec()
		]);
		const compliance = [
			...listings.flatMap(listing => listingCompliance(listing as never, now)),
			...tenancies.flatMap(tenancy => tenancyCompliance(tenancy as never, tenancy.listing as never, now))
		];

		const lines: string[] = [];
		if (applications) lines.push(`${applications} new ${applications === 1 ? "application" : "applications"}`);
			const received = paid.filter(payment => payment.payoutStatus !== PayoutStatus.HELD);
			const held = paid.filter(payment => payment.payoutStatus === PayoutStatus.HELD);
			const sum = (items: typeof paid) => formatPence(items.reduce((total, payment) => total + payment.payout, 0));
			if (received.length) lines.push(`${received.length} ${received.length === 1 ? "payment" : "payments"} received, ${sum(received)} in total`);
			if (held.length) lines.push(`${sum(held)} held by Seek until you set up payouts`);
		const day = (date: Date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
		for (const item of compliance) lines.push(`${item.listingTitle ?? "A property"}: ${item.message} (${day(item.dueDate)})`);
		if (!lines.length) return;
		// Atomic per-landlord claim: restarts and multiple instances can't resend this week's digest.
		const weekStart = londonWeekStart(now);
		const claimed = await this.userModel
			.findOneAndUpdate(
				{ _id: landlord._id, $or: [{ weeklySummarySentAt: null }, { weeklySummarySentAt: { $exists: false } }, { weeklySummarySentAt: { $lt: weekStart } }] },
				{ $set: { weeklySummarySentAt: now } }
			)
			.lean()
			.exec();
		if (!claimed) return;
		try {
			await this.mail.sendWeeklySummaryEmail(landlord.email, landlord.name, lines);
		} catch (error) {
			// Release the claim (only if still ours) so the next daily tick this week can retry.
			await this.userModel.updateOne({ _id: landlord._id, weeklySummarySentAt: now }, { $set: { weeklySummarySentAt: claimed.weeklySummarySentAt ?? null } }).exec();
			throw error;
		}
	}
}
