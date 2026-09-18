import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { UsersModule } from "../users/users.module";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { LocalStrategy } from "./strategies/local.strategy";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtRefreshStrategy } from "./strategies/jwt-refresh.strategy";
import { MailService } from "./mail.service";
import { GoogleStrategy } from "./strategies/google.strategy";
import { RedisModule } from "../redis/redis.module";
import { ThrottlerModule } from "@nestjs/throttler";

@Module({
	imports: [
		UsersModule,
		PassportModule,
		JwtModule,
		RedisModule,
		ThrottlerModule.forRoot({
			throttlers: [{ name: "auth", ttl: 60_000, limit: 20 }]
		})
	],
	providers: [
		AuthService,
		LocalStrategy,
		JwtStrategy,
		JwtRefreshStrategy,
		GoogleStrategy,
		MailService,
	],
	controllers: [AuthController],
	exports: [MailService]
})
export class AuthModule { }
