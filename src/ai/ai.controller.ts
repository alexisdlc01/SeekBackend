import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { Role } from "../auth/role.enum";
import { ErrorDto } from "../dto/errorDto.dto";
import { AiService } from "./ai.service";
import { AdviceRequestDto, AdviceResponseDto, SearchChatDto, SearchChatResponseDto } from "./dto/ai.dto";

/** Each call can reach a paid model, so both routes have a tighter limit than the default. */
const AI_THROTTLE = { default: { limit: 20, ttl: 60_000 } };

@Controller("ai")
export class AiController {
	constructor(private readonly ai: AiService) {}

	@Post("search-chat")
	@HttpCode(200)
	@StudentOrLandlord()
	@Throttle(AI_THROTTLE)
	@ApiOperation({ summary: "Describe the home you want in words; returns the filters understood and matching listings." })
	@ApiResponse({ status: 200, type: SearchChatResponseDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 429, type: ErrorDto })
	async searchChat(@Body() body: SearchChatDto, @CurrentUser() user: User) {
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
		return this.ai.advice(user, body);
	}
}
