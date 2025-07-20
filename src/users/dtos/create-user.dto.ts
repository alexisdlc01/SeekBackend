import {
	IsEmail,
	IsStrongPassword,
	IsEnum,
	IsOptional,
	IsString
} from "class-validator";
import { Role } from "../../auth/role.enum";

export class CreateUserDto {
	@IsString()
	name: string;

	@IsEmail()
	email: string;

	@IsEnum(Role)
	@IsOptional()
	role?: Role;

	@IsString()
	@IsOptional()
	imageUrl?: string;

	@IsStrongPassword()
	password: string;
}
