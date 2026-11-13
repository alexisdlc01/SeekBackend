import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ConnectorsService } from "./connectors.service";

const EVERY_MS = 15 * 60 * 1000;

/** Syncs connected mailboxes every 15 minutes (same scheduler as PaymentsSweeper). Disabled under NODE_ENV=test. */
@Injectable()
export class ConnectorsSweeper implements OnApplicationBootstrap, OnModuleDestroy {
	private readonly logger = new Logger(ConnectorsSweeper.name);
	private interval?: NodeJS.Timeout;
	private running = false;

	constructor(
		private readonly connectors: ConnectorsService,
		private readonly config: ConfigService
	) {}

	onApplicationBootstrap() {
		if (this.config.get<string>("NODE_ENV") === "test" || process.env.NODE_ENV === "test") return;
		this.interval = setInterval(() => void this.run(), EVERY_MS);
		this.interval.unref();
	}

	onModuleDestroy() {
		if (this.interval) clearInterval(this.interval);
	}

	private async run() {
		// A slow sweep (many mailboxes) must not overlap the next tick.
		if (this.running) return;
		this.running = true;
		try {
			await this.connectors.syncAll();
		} catch (error) {
			this.logger.error(`Mailbox sync sweep failed: ${(error as Error)?.message}`);
		} finally {
			this.running = false;
		}
	}
}
