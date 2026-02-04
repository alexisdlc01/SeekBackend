import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ForbiddenException
} from "@nestjs/common";
import { ApplicationService } from "../application.service";
import { User } from "../../users/users.schema";

@Injectable()
export class ApplicantGuard implements CanActivate {
	constructor(private readonly applicationService: ApplicationService) { }

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user: User = request.user;

		const applicationId = request.params.id;

		const application =
			await this.applicationService.findApplicationById(applicationId);

		if (!application) {
			throw new ForbiddenException("Application not found");
		}

		const isApplicant = application.applicants.some(
			applicant => applicant.toString() === user._id.toString()
		);
		if (!isApplicant) {
			throw new ForbiddenException("You are not an applicant");
		}

		return true;
	}
}
