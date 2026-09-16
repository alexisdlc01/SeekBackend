import {
	IsDateString,
	IsEmail,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	MinLength,
	ValidateIf
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateUserProfileDto {
	@ApiPropertyOptional()
	@IsOptional()
	@IsString()
	@MinLength(1)
	@MaxLength(80)
	@Matches(/\S/, { message: "name must not be empty" })
	name?: string;

	@ApiPropertyOptional({
		description:
			"A unique username using letters, numbers, dots, underscores, or hyphens. Send an empty string to clear it."
	})
	@IsOptional()
	@IsString()
	@Matches(/^$|^[A-Za-z0-9._-]{3,30}$/, {
		message:
			"username must be 3-30 characters and contain only letters, numbers, dots, underscores, or hyphens"
	})
	username?: string;

	@ApiPropertyOptional()
	@IsOptional()
	@IsEmail()
	@MaxLength(254)
	email?: string;

	@ApiPropertyOptional({ description: "Send an empty string to clear it." })
	@IsOptional()
	@IsString()
	@Matches(/^$|^[0-9+()\-\s]{5,30}$/, {
		message: "phone must be a valid phone number"
	})
	phone?: string;

	@ApiPropertyOptional({
		type: String,
		format: "date",
		description: "ISO date (YYYY-MM-DD). Send an empty string to clear it."
	})
	@IsOptional()
	@ValidateIf((_object, value) => value !== "")
	@IsDateString({ strict: true })
	dateOfBirth?: string;

	@ApiPropertyOptional({ description: "Send an empty string to clear it." })
	@IsOptional()
	@IsString()
	@MaxLength(200)
	universityDetails?: string;
}
