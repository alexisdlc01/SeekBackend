import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ContractsService } from "./contracts.service";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Sends the daily signing reminders (same scheduler as PaymentsSweeper). Disabled under NODE_ENV=test. */
@Injectable()
export class ContractsSweeper implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(ContractsSweeper.name);
	private interval?: NodeJS.Timeout;
	private firstRun?: NodeJS.Timeout;
	private running = false;

	constructor(
		private readonly contracts: ContractsService,
		private readonly config: ConfigService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		this.firstRun = setTimeout(() => void this.run(), 60_000);
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
			await this.contracts.remindStale();
		} catch (error) {
			this.logger.error(`Contract reminders failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}
}
