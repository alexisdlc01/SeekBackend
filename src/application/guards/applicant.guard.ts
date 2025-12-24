import {
	CanActivate,
	ExecutionContext,
	Injectable,
	ForbiddenException
} from "@nestjs/common";
import { ApplicationService } from "../application.service";

@Injectable()
export class ApplicantGuard implements CanActivate {
	constructor(private readonly applicationService: ApplicationService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user = request.user;

		if (!user || !user._id) {
			throw new ForbiddenException("User not authenticated");
		}

		const applicationId = request.params.id;

		const application =
			await this.applicationService.findApplicationById(applicationId);

		if (!application) {
			throw new ForbiddenException("Application not found");
		}

		const applicants = application.toObject().applicants;
		applicants.forEach(applicant => {
			if (applicant.toString() === user._id) {
				return true;
			}
		});

		return false;
	}
}
