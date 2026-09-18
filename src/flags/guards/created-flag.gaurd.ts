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
export class CreatedFlagGaurd implements CanActivate {
	constructor(private readonly flagService: FlagsService) {}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const request = context.switchToHttp().getRequest();
		const user: User = request.user;

		// if superuser allow access
		if (user.role === Role.SUPERUSER) {
			return true;
		}

		// ensure the user is authenticated and the owner
		if (!user || !user._id) {
			throw new ForbiddenException("User not authenticated");
		}

		const flagId = request.params.id;
		const flag = await this.flagService.findOne(flagId);
		if (flag.createdBy.toString() !== user._id.toString()) {
			throw new ForbiddenException("You do not own this flag");
		}
		return true;
	}
}
