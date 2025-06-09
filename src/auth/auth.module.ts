import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { UsersModule } from "../users/users.module";
import { AuthGuard, PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { LocalStrategy } from "./strategies/local.strategy";

@Module({
	imports: [UsersModule, PassportModule, JwtModule],
	providers: [AuthService, LocalStrategy],
	controllers: [AuthController]
})
export class AuthModule {}
