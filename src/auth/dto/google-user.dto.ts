import {
	IsEmail,
	IsStrongPassword,
	IsEnum,
	IsOptional,
	IsString
} from "class-validator";
import { Role } from "../role.enum";
import { ApiProperty } from "@nestjs/swagger";

export class GoogleUserDto {
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
}
