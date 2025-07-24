import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { UsersModule } from "../users/users.module";
import { PassportModule } from "@nestjs/passport";
import { JwtModule } from "@nestjs/jwt";
import { LocalStrategy } from "./strategies/local.strategy";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { JwtRefreshStrategy } from "./strategies/jwt-refresh.strategy";
import { MailService } from './mail.service';

@Module({
	imports: [UsersModule, PassportModule, JwtModule],
	providers: [AuthService, LocalStrategy, JwtStrategy, JwtRefreshStrategy, MailService],
	controllers: [AuthController]
})
export class AuthModule {}
