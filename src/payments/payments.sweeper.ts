import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PaymentsService } from "./payments.service";
import { ApplicationService } from "../application/application.service";

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

/** Runs the payments sweep on an interval. Disabled under NODE_ENV=test. */
@Injectable()
export class PaymentsSweeper implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(PaymentsSweeper.name);
	private interval?: NodeJS.Timeout;
	private firstRun?: NodeJS.Timeout;
	private running = false;

	constructor(
		private readonly payments: PaymentsService,
		private readonly config: ConfigService,
		private readonly applications: ApplicationService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		const configured = Number(this.config.get<string>("PAYMENTS_SWEEP_INTERVAL_MS"));
		const everyMs = Number.isFinite(configured) && configured >= 60_000 ? configured : DEFAULT_INTERVAL_MS;
		this.firstRun = setTimeout(() => void this.run(), 10_000);
		this.interval = setInterval(() => void this.run(), everyMs);
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
			await this.payments.sweep();
			await this.applications.expireOffers();
		} catch (error) {
			this.logger.error(`Payments sweep failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}
}
