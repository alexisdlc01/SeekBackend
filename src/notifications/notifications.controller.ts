import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { StudentOrLandlordOrSuperuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { NotificationsService, teamNotificationKinds } from "./notifications.service";
import type { AuthenticatedUser } from "../auth/auth.service";
import { Notification } from "./notification.schema";
import { PushTokenDto } from "./dto/push-token.dto";
import { ErrorDto } from "../dto/errorDto.dto";

@Controller("notifications")
export class NotificationsController {
	constructor(private readonly notificationsService: NotificationsService) {}

	/** A team member reads the owner's notifications, limited to their scopes. */
	private reader(user: AuthenticatedUser) {
		const team = user.teamOf;
		return team
			? { userId: team.ownerId, kinds: teamNotificationKinds(team.scopes) }
			: { userId: user._id.toString(), kinds: undefined };
	}

	@Get()
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "The signed-in user's latest notifications, newest first." })
	@ApiResponse({ status: 200, type: [Notification] })
	@ApiResponse({ status: 401, type: ErrorDto })
	async list(@CurrentUser() user: AuthenticatedUser) {
		const { userId, kinds } = this.reader(user);
		return this.notificationsService.listForUser(userId, 50, kinds);
	}

	@Patch(":id/read")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Mark a notification as read." })
	@ApiResponse({ status: 200, type: Notification })
	@ApiResponse({ status: 404, type: ErrorDto })
	async markRead(
		@Param("id", ParseObjectIdPipe) id: string,
		@CurrentUser() user: AuthenticatedUser
	) {
		const { userId, kinds } = this.reader(user);
		return this.notificationsService.markRead(userId, id, kinds);
	}

	@Post("push-token")
	@HttpCode(204)
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Register this device's Expo push token. Idempotent." })
	@ApiResponse({ status: 204 })
	@ApiResponse({ status: 400, type: ErrorDto })
	async addPushToken(@Body() dto: PushTokenDto, @CurrentUser() user: User) {
		await this.notificationsService.addPushToken(user._id.toString(), dto.token);
	}

	@Delete("push-token")
	@HttpCode(204)
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Remove an Expo push token (on logout)." })
	@ApiResponse({ status: 204 })
	@ApiResponse({ status: 400, type: ErrorDto })
	async removePushToken(@Body() dto: PushTokenDto, @CurrentUser() user: User) {
		await this.notificationsService.removePushToken(user._id.toString(), dto.token);
	}
}
