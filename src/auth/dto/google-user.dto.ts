import {
	IsEmail,
	IsStrongPassword,
	IsEnum,
	IsOptional,
	IsString
} from "class-validator";
import { Role } from "../role.enum";

export class GoogleUserDto {
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
}
