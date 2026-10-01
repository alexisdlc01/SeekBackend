import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable,
	NotFoundException
} from "@nestjs/common";
import { ApplicationService } from "../application.service";
import { User } from "../../users/users.schema";
import { ApplicationStage } from "../enums/application-stage.enum";

/**
 * Admins of an application group: the student who created it, and the
 * landlord once the application has been sent to them (before that the
 * landlord is not part of the conversation).
 */
@Injectable()
export class ApplicationAdminGuard implements CanActivate {
	constructor(private readonly applicationService: ApplicationService) { }

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user: User = request.user;
		if (!user) {
			throw new NotFoundException("Failed to get user for account.");
		}

		const application = await this.applicationService.findApplicationById(
			request.params.id
		);
		const userId = user._id.toString();
		const isOwner = application.owner?.toString() === userId;
		const isLandlord =
			application.landlord?.toString() === userId &&
			application.stage !== ApplicationStage.NOT_SENT;
		if (!isOwner && !isLandlord) {
			throw new ForbiddenException("You are not an admin of this application");
		}

		return true;
	}
}
