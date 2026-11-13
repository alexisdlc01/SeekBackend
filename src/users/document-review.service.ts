import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { DocumentStatus } from "./types/document-type";
import { User } from "./users.schema";

const SWEEP_EVERY_MS = 15 * 60 * 1000;

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

	constructor(
		@InjectModel(User.name) private readonly userModel: Model<User>,
		private readonly config: ConfigService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		this.firstRun = setTimeout(() => void this.sweep(), 10_000);
		this.interval = setInterval(() => void this.sweep(), SWEEP_EVERY_MS);
		this.firstRun.unref();
		this.interval.unref();
	}

	onModuleDestroy() {
		if (this.firstRun) clearTimeout(this.firstRun);
		if (this.interval) clearInterval(this.interval);
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
