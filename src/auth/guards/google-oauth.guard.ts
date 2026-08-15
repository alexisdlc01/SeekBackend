import { ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class GoogleOauthGuard extends AuthGuard("google") {
	constructor(private readonly configService: ConfigService) {
		super();
	}

	canActivate(context: ExecutionContext) {
		const enabled = this.configService.get<string | boolean>(
			"AUTH_GOOGLE_ENABLED"
		);
		if (enabled !== true && enabled !== "true") {
			throw new ForbiddenException("Google authentication is not enabled.");
		}
		return super.canActivate(context);
	}
}
