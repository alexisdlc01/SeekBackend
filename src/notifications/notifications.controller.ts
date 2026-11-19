import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { StudentOrLandlordOrSuperuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { NotificationsService } from "./notifications.service";
import { Notification } from "./notification.schema";
import { PushTokenDto } from "./dto/push-token.dto";
import { ErrorDto } from "../dto/errorDto.dto";

@Controller("notifications")
export class NotificationsController {
	constructor(private readonly notificationsService: NotificationsService) {}

	@Get()
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "The signed-in user's latest notifications, newest first." })
	@ApiResponse({ status: 200, type: [Notification] })
	@ApiResponse({ status: 401, type: ErrorDto })
	async list(@CurrentUser() user: User) {
		return this.notificationsService.listForUser(user._id.toString());
	}

	@Patch(":id/read")
	@StudentOrLandlordOrSuperuser()
	@ApiOperation({ summary: "Mark a notification as read." })
	@ApiResponse({ status: 200, type: Notification })
	@ApiResponse({ status: 404, type: ErrorDto })
	async markRead(
		@Param("id", ParseObjectIdPipe) id: string,
		@CurrentUser() user: User
	) {
		return this.notificationsService.markRead(user._id.toString(), id);
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
