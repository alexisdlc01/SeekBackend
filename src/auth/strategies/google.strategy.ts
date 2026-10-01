import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";
import { GoogleUserDto } from "../dto/google-user.dto";
import { Role } from "../role.enum";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
	constructor(configService: ConfigService) {
		super({
			clientID: configService.getOrThrow("GOOGLE_CLIENT_ID"),
			clientSecret: configService.getOrThrow("GOOGLE_CLIENT_SECRET"),
			callbackURL: configService.getOrThrow("GOOGLE_CALLBACK_URL"),
			scope: ["profile", "email"]
		});
	}

	async validate(
		_accessToken: string,
		_refreshToken: string,
		profile: any,
		done: VerifyCallback
	) {
		const name: string = profile.displayName;
		const primaryEmail = profile.emails?.[0];
		// The address is what links this identity to an account, so only accept
		// one Google states it has verified.
		const emailIsVerified =
			profile._json?.email_verified === true ||
			profile._json?.email_verified === "true" ||
			primaryEmail?.verified === true ||
			primaryEmail?.verified === "true";

		if (!primaryEmail?.value || !emailIsVerified) {
			return done(
				new UnauthorizedException(
					"A verified Google email address is required."
				),
				false
			);
		}

		const email: string = primaryEmail.value;
		const profilePicUrl: string | undefined = profile.photos?.[0]?.value;
		const user = {
			email,
			name,
			profilePicUrl,
			isGoogle: true,
			role: Role.STUDENT,
			isVerified: true
		} as GoogleUserDto & { role: Role };
		done(null, user);
	}
}
