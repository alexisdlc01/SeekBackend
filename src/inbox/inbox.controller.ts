import { TeamAccess } from "../auth/decorators/team-access.decorator";
import { TeamScope } from "../users/types/team-scope";
import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiParam, ApiResponse } from "@nestjs/swagger";
import { StudentOrLandlord } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ErrorDto } from "../dto/errorDto.dto";
import { InboxService } from "./inbox.service";
import { InboxQueryDto, InboxReplyDto, InboxThreadDetailDto, InboxThreadDto } from "./dto/inbox.dto";

@Controller("inbox")
export class InboxController {
	constructor(private readonly inbox: InboxService) {}

	@TeamAccess(TeamScope.VIEWINGS_INBOX)
	@Get("threads")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Seek conversations and housing email threads in one list, newest first." })
	@ApiResponse({ status: 200, type: [InboxThreadDto] })
	async threads(@Query() query: InboxQueryDto, @CurrentUser() user: User) {
		return this.inbox.listThreads(user, query.category);
	}

	@TeamAccess(TeamScope.VIEWINGS_INBOX)
	@Get("threads/:id")
	@StudentOrLandlord()
	@ApiOperation({ summary: "Messages of one thread (Seek and email), oldest first. Marks the thread read." })
	@ApiParam({ name: "id", example: "seek-6650f0c2a1b2c3d4e5f60718" })
	@ApiResponse({ status: 200, type: InboxThreadDetailDto })
	@ApiResponse({ status: 403, type: ErrorDto })
	@ApiResponse({ status: 404, type: ErrorDto })
	async thread(@Param("id") id: string, @CurrentUser() user: User) {
		return this.inbox.getThread(user, id);
	}

	@TeamAccess(TeamScope.VIEWINGS_INBOX)
	@Post("threads/:id/reply")
	@StudentOrLandlord()
	@ApiOperation({
		summary: "Reply in a thread: through Seek, or by email from your own connected address. Returns the updated thread."
	})
	@ApiParam({ name: "id", example: "email-3f2a9c0d1e4b5a6c7d8e9f01" })
	@ApiResponse({ status: 201, type: InboxThreadDetailDto })
	@ApiResponse({ status: 400, type: ErrorDto })
	@ApiResponse({ status: 502, type: ErrorDto, description: "The mail provider refused the message." })
	async reply(@Param("id") id: string, @Body() body: InboxReplyDto, @CurrentUser() user: User) {
		return this.inbox.reply(user, id, body);
	}
}
