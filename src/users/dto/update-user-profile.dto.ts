import {
	ArrayMaxSize,
	IsArray,
	IsBoolean,
	IsEnum,
	IsInt,
	Max,
	Min,
	ValidateNested,
	IsDateString,
	IsOptional,
	IsString,
	Matches,
	MaxLength,
	MinLength,
	ValidateIf
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { RegistrationKind } from "../types/landlord-registration";

export class RegistrationInputDto {
	@ApiProperty({ enum: RegistrationKind })
	@IsEnum(RegistrationKind)
	kind: RegistrationKind;

	@ApiProperty({ example: "HMO/2024/0917" })
	@IsString()
	@MinLength(2)
	@MaxLength(60)
	number: string;
}

export class NotificationPrefsInputDto {
	@ApiPropertyOptional({ minimum: 0, maximum: 14, default: 3 })
	@IsOptional()
	@IsInt()
	@Min(0)
	@Max(14)
	rentReminderDaysBefore?: number;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	receiptEveryPayment?: boolean;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	landlordEveryPayment?: boolean;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	newQualifiedHousehold?: boolean;

	@ApiPropertyOptional({ default: true })
	@IsOptional()
	@IsBoolean()
	complianceDue?: boolean;

	@ApiPropertyOptional({ default: false })
	@IsOptional()
	@IsBoolean()
	weeklySummary?: boolean;
}

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

	@ApiPropertyOptional({ description: "Landlord company name. Send an empty string to clear it." })
	@IsOptional()
	@IsString()
	@MaxLength(120)
	companyName?: string;

	@ApiPropertyOptional({
		type: [RegistrationInputDto],
		description: "Replaces the landlord's registrations. Verification is kept for unchanged numbers."
	})
	@IsOptional()
	@IsArray()
	@ArrayMaxSize(20)
	@ValidateNested({ each: true })
	@Type(() => RegistrationInputDto)
	registrations?: RegistrationInputDto[];

	@ApiPropertyOptional({ type: NotificationPrefsInputDto })
	@IsOptional()
	@ValidateNested()
	@Type(() => NotificationPrefsInputDto)
	notificationPrefs?: NotificationPrefsInputDto;

	@ApiPropertyOptional({
		description: "Stripe Connect account (acct_...) that receives rent payouts. Landlords only. Empty string clears it."
	})
	@IsOptional()
	@IsString()
	@Matches(/^$|^acct_[A-Za-z0-9]{6,40}$/, {
		message: "stripeAccountId must be a Stripe account id (acct_...)"
	})
	stripeAccountId?: string;
}
