import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { DocumentStatus } from "./types/document-type";
import { User } from "./users.schema";
import { AccountService } from "./account.service";

const SWEEP_EVERY_MS = 15 * 60 * 1000;
const ERASE_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Seek never reads personal documents (no AI, no staff): every upload is PROVIDED and the landlord
 * checks it through the share. The sweep only moves uploads still PENDING from before this rule.
 */
@Injectable()
export class DocumentReviewService implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(DocumentReviewService.name);
	private interval?: NodeJS.Timeout;
	private firstRun?: NodeJS.Timeout;
	private running = false;
	private eraseInterval?: NodeJS.Timeout;
	private erasing = false;

	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly config: ConfigService,
		private readonly account?: AccountService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		// Also erases at boot: a deploy more often than daily would otherwise reset the daily timer forever.
		this.firstRun = setTimeout(() => { void this.sweep(); void this.eraseIdentityDocuments(); }, 10_000);
		this.interval = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
		this.eraseInterval = setInterval(() => void this.eraseIdentityDocuments(), ERASE_EVERY_MS);
		this.firstRun.unref();
		this.interval.unref();
		this.eraseInterval.unref();
	}

	onModuleDestroy() {
		if (this.firstRun) clearTimeout(this.firstRun);
		if (this.interval) clearInterval(this.interval);
		if (this.eraseInterval) clearInterval(this.eraseInterval);
	}

	/** Daily: identity documents last shared with a landlord more than 30 days ago (privacy policy). */
	async eraseIdentityDocuments(): Promise<void> {
		if (this.erasing || !this.account) return;
		this.erasing = true;
		try {
			const erased = await this.account.eraseStaleIdentityDocuments();
			if (erased) this.logger.log(`Erased ${erased} identity document(s) 30 days after their last share`);
		} catch (error) {
			this.logger.error(`Identity document erasure failed: ${(error as Error)?.message}`);
		} finally {
			this.erasing = false;
		}
	}

	async sweep(): Promise<void> {
		if (this.running) return;
		this.running = true;
		try {
			await this.userModel.updateMany(
				{ documents: { $elemMatch: { status: DocumentStatus.PENDING } } },
				{ $set: { "documents.$[doc].status": DocumentStatus.PROVIDED } },
				{ arrayFilters: [{ "doc.status": DocumentStatus.PENDING }] }
			);
		} catch (error) {
			this.logger.error(`Document sweep failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}
}
