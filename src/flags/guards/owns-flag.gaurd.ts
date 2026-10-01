import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from "@nestjs/common";
import { FlagsService } from "../flags.service";
import { User } from "../../users/users.schema";
import { Role } from "../../auth/role.enum";

@Injectable()
export class CreatedFlagOrSuperuserGuard implements CanActivate {
	constructor(private readonly flagService: FlagsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user: User | undefined = request.user;

		// Check the user resolved before reading anything off it, so an
		// unauthenticated request is a clean 403 rather than a 500.
		if (!user?._id) {
			throw new ForbiddenException("User not authenticated");
		}

		if (user.role === Role.SUPERUSER) {
			return true;
		}

		const flagId = request.params.id;
		const flag = await this.flagService.findOne(flagId);
		if (flag.createdBy.toString() !== user._id.toString()) {
			throw new ForbiddenException("You do not own this flag");
		}
		return true;
	}
}
