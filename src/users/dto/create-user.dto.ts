import {
	IsEmail,
	IsStrongPassword,
	IsEnum,
	IsOptional,
	IsString
} from "class-validator";
import { Transform } from "class-transformer";
import { Role } from "../../auth/role.enum";
import { ApiProperty } from "@nestjs/swagger";

export class CreateUserDto {
	@ApiProperty()
	@IsString()
	name: string;

	@ApiProperty()
	@IsEmail()
	@Transform(({ value }) => value?.trim().toLowerCase())
	email: string;

	@ApiProperty({ enum: Role, required: false, default: Role.STUDENT })
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
}
