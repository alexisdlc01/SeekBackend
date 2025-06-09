import { Injectable, UnauthorizedException } from "@nestjs/common";
import { UsersService } from "../users/users.service";
import { compare } from "bcryptjs";

@Injectable()
export class AuthService {
	constructor(private readonly usersService: UsersService) {}

	async verifyUser(email: string, password: string) {
		try {
			const user = await this.usersService.getUser({
				email
			});
			const authenticated = await compare(password, user.password);
			if (!authenticated) {
				throw new UnauthorizedException();
			}
		} catch (err) {
			throw new UnauthorizedException("Credentials are not valid.");
		}
	}
}
