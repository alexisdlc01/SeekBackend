import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ForbiddenException,
	NotFoundException
} from "@nestjs/common";
import { ApplicationService } from "../application.service";
import { User } from "../../users/users.schema";
import { Application } from "../application.schema";

@Injectable()
export class ApplicationOwnerGuard implements CanActivate {
	constructor(private readonly applicationService: ApplicationService) { }

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user: User = request.user;

		const applicationId = request.params.id;

		const application: Application = await this.applicationService.findApplicationById(applicationId);
		if (!application) {
			throw new NotFoundException("Application not found.");
		}

		const isOwner = application.owner === user._id;
		if (!isOwner) {
			throw new ForbiddenException("You are not an applicant");
		}

		return true;
	}
}
