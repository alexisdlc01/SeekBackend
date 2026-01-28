import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";
import UsersService from "../../users/users.service";
import { User } from "../../users/users.schema";
import { GoogleUserDto } from "../dto/google-user.dto";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
	constructor(
		private readonly configService: ConfigService,
		private readonly usersService: UsersService
	) {
		super({
			clientID: configService.getOrThrow("GOOGLE_CLIENT_ID"),
			clientSecret: configService.getOrThrow("GOOGLE_CLIENT_SECRET"),
			callbackURL: configService.getOrThrow("GOOGLE_CALLBACK_URL"),
			scope: ["profile", "email"]
		});
	}

	async validate(
		accessToken: string,
		refreshToken: string,
		profile: any,
		done: VerifyCallback
	) {
		const name: string = profile.displayName;
		const email: string = profile.emails[0].value;
		const profilePicUrl: string = profile.photos[0].value;
		const user = {
			email,
			name,
			profilePicUrl,
			isGoogle: true,
			role: "LANDLORD_AGENCY",
			isVerified: true
		} as GoogleUserDto;
		done(null, user);
	}
}
