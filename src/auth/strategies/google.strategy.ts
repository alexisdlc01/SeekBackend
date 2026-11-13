import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";
import { GoogleUserDto } from "../dto/google-user.dto";
import { Role } from "../role.enum";
import { Request } from "express";
import { randomBytes } from "node:crypto";
import type { StateStore } from "passport-oauth2";

const STATE_COOKIE = "GoogleOAuthState";

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, "google") {
	constructor(configService: ConfigService) {
		super({
			clientID: configService.getOrThrow("GOOGLE_CLIENT_ID"),
			clientSecret: configService.getOrThrow("GOOGLE_CLIENT_SECRET"),
			callbackURL: configService.getOrThrow("GOOGLE_CALLBACK_URL"),
			scope: ["profile", "email"],
			// Login-CSRF guard: bind the callback to the browser that started the flow.
			store: {
				store(req: Request, callback: (err: Error | null, state: string) => void) {
					const state = randomBytes(16).toString("hex");
					req.res?.cookie(STATE_COOKIE, state, {
						httpOnly: true,
						secure: configService.get("NODE_ENV") === "production",
						sameSite: "lax",
						path: "/auth/google",
						maxAge: 10 * 60_000
					});
					callback(null, state);
				},
				verify(
					req: Request,
					state: string,
					callback: (err: Error | null, ok: boolean, info?: unknown) => void
				) {
					const expected = req.cookies?.[STATE_COOKIE];
					req.res?.clearCookie(STATE_COOKIE, { path: "/auth/google" });
					const ok = typeof expected === "string" && expected.length > 0 && state === expected;
					callback(null, ok, ok ? undefined : { message: "Invalid OAuth state." });
				}
			} as StateStore // passport-oauth2 dispatches on arity; its typings list overloads
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
