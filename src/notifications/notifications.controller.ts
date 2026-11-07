import { Controller, Get, Param, Patch } from "@nestjs/common";
import { ApiOperation, ApiResponse } from "@nestjs/swagger";
import { StudentOrLandlordOrSuperuser } from "../auth/decorators/role-auth.decorator";
import { CurrentUser } from "../auth/decorators/current-user.decorator";
import { User } from "../users/users.schema";
import { ParseObjectIdPipe } from "../shared/parse-object-id.pipe";
import { NotificationsService } from "./notifications.service";
import { Notification } from "./notification.schema";
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
}
