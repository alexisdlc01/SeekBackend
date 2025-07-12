import { IsEmail, IsStrongPassword, IsEnum, IsOptional } from "class-validator";
import { Role } from "../../auth/role.enum";

export class CreateUserDto {
	@IsEmail()
	email: string;

	@IsEnum(Role)
	@IsOptional()
	role?: Role;

	@IsStrongPassword()
	password: string;
}
