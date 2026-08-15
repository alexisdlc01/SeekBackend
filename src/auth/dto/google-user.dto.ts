import {
	IsEmail,
	IsOptional,
	IsString
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class GoogleUserDto {
	@ApiProperty()
	@IsString()
	name: string;

	@ApiProperty()
	@IsEmail()
	email: string;

	@ApiProperty()
	@IsString()
	@IsOptional()
	profilePicUrl?: string;

	isGoogle?: boolean;
	isVerified?: boolean;
}
