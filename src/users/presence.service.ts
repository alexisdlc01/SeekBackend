import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";

@Injectable()
export class PresenceService {
	constructor(@Inject("REDIS_CLIENT") private readonly redisService: Redis) {}

	async userConnected(userId: string): Promise<boolean> {
		const key = `presence:user:${userId}`;
		const count = await this.redisService.incr(key);
		await this.redisService.expire(key, 60);

		return count === 1; // true = user just came online
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

	// TODO: move this to usersService and add lastSeen to users.schema
	async updateLastSeen(userId: string) {
		const key = `presence:user:${userId}`;
	}

	async isOnline(userId: string): Promise<boolean> {
		const count = await this.redisService.get(`presence:user:${userId}`);
		return !!count && Number(count) > 0;
	}
}
