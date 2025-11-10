import {
	IsEmail,
	IsStrongPassword,
	IsEnum,
	IsOptional,
	IsString
} from "class-validator";
import { Role } from "../../auth/role.enum";
import { ApiProperty } from "@nestjs/swagger";

export class CreateUserDto {
	@ApiProperty()
	@IsString()
	name: string;

	@ApiProperty()
	@IsEmail()
	email: string;

	@ApiProperty()
	@IsEnum(Role)
	@IsOptional()
	role?: Role;

	@ApiProperty()
	@IsString()
	@IsOptional()
	imageUrl?: string;

	@ApiProperty()
	@IsStrongPassword()
	password: string;

	@ApiProperty()
	@IsString()
	@IsOptional()
	emailVerificationToken?: string;

	@ApiProperty()
	@IsString()
	@IsOptional()
	emailVerificationTokenExpires?: Date;
}
