import {
	CanActivate,
	ExecutionContext,
	ForbiddenException,
	Injectable
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

@Injectable()
export class BrowserOriginGuard implements CanActivate {
	constructor(private readonly configService: ConfigService) { }

	canActivate(context: ExecutionContext) {
		if (context.getType() !== "http") {
			return true;
		}

		const request = context.switchToHttp().getRequest<Request>();
		if (
			["GET", "HEAD", "OPTIONS"].includes(request.method) ||
			request.headers.platform === "mobile" ||
			this.configService.get("NODE_ENV") !== "production"
		) {
			return true;
		}

		const origin = request.headers.origin;
		const configuredOrigins = (
			this.configService.get<string>("FRONTEND_URL") ?? ""
		)
			.split(",")
			.map(value => value.trim().replace(/\/$/, ""))
			.filter(Boolean);

		if (
			!origin ||
			!configuredOrigins.includes(origin.replace(/\/$/, ""))
		) {
			throw new ForbiddenException("Request origin is not allowed.");
		}

		return true;
	}
}
