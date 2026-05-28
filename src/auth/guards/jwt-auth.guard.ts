import { ExecutionContext, Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { Role } from "../role.enum";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
	canActivate(context: ExecutionContext) {
		if (
			process.env.NODE_ENV !== "production" &&
			process.env.DEV_AUTH_BYPASS === "true"
		) {
			const request = context.switchToHttp().getRequest();
			request.user = {
				_id:
					process.env.DEV_AUTH_BYPASS_USER_ID ??
					"665000000000000000000002",
				name: "Dev Student",
				email: "student@seek.local",
				role: Role.STUDENT,
				isVerified: true
			};
			return true;
		}

		return super.canActivate(context);
	}
}
