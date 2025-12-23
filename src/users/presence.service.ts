import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class PresenceService {
	constructor(@Inject("REDIS_CLIENT") private readonly redisService: Redis) {}

	async userConnected(userId: string): Promise<boolean> {
		const key = `presence:user:${userId}`;
		const count = await this.redisService.incr(key);
		await this.redisService.expire(key, 60);

		return count === 1;
	}

	async userDisconnected(userId: string): Promise<boolean> {
		const key = `presence:user:${userId}`;
		const count = await this.redisService.decr(key);

		if (count <= 0) {
			await this.redisService.del(key);
			return true; // user just went offline
		}

		return false;
	}

	async heartbeat(userId: string) {
		await this.redisService.expire(`presence:user:${userId}`, 60);
	}
}
