import { Body, Controller, HttpCode, HttpException, HttpStatus, Inject, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Throttle, ThrottlerStorage } from "@nestjs/throttler";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { ErrorDto } from "../dto/errorDto.dto";
import { AiService } from "./ai.service";
import { AdviceRequestDto, AdviceResponseDto, SearchChatDto, SearchChatResponseDto } from "./dto/ai.dto";

/** Each call can reach a paid model, so both routes have a tighter limit than the default. */
const AI_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

/** Per account (both routes together), on top of the per-IP limit above. */
export const AI_USER_LIMITS = [
	{ name: "ai-min", ttl: 60_000, limit: 10, message: "You're asking Seek AI too quickly. Wait a minute and try again." },
	{ name: "ai-day", ttl: 86_400_000, limit: 60, message: "You've reached today's limit of 60 Seek AI requests. Try again tomorrow." }
];

@Controller("ai")
export class AiController {
	constructor(
		private readonly ai: AiService,
		@Inject(ThrottlerStorage) private readonly storage: ThrottlerStorage
	) {}

	private async capPerUser(user: User) {
		for (const { name, ttl, limit, message } of AI_USER_LIMITS) {
			// Block for one window once over the limit: with blockDuration 0 the count resets instead.
			const hit = await this.storage.increment(`${name}:${user._id}`, ttl, limit, ttl, name);
			if (hit.isBlocked) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
		}
	}

	@Post("search-chat")
	@HttpCode(200)
	@StudentOrLandlord()
	@Throttle(AI_THROTTLE)
	@ApiOperation({ summary: "Describe the home you want in words; returns the filters understood and matching listings." })
	@ApiResponse({ status: 200, type: SearchChatResponseDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 429, type: ErrorDto })
	async searchChat(@Body() body: SearchChatDto, @CurrentUser() user: User) {
		await this.capPerUser(user);
		return this.ai.searchChat(body.messages, new Date(), user.role === Role.STUDENT ? user : undefined);
	}

	@Post("advice")
	@HttpCode(200)
	@StudentOrLandlord()
	@Throttle(AI_THROTTLE)
	@ApiOperation({ summary: "Short guidance on a tenancy topic, based on your tenancy, bills, payments and inbox." })
	@ApiResponse({ status: 200, type: AdviceResponseDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 429, type: ErrorDto })
	async advice(@Body() body: AdviceRequestDto, @CurrentUser() user: User) {
		await this.capPerUser(user);
		return this.ai.advice(user, body);
	}
}
