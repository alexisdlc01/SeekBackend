import { Expose, Transform, Type } from "class-transformer";
import { IsOptional } from "class-validator";
import { Role } from "../../auth/role.enum";
import { ApiProperty } from "@nestjs/swagger";
import { RegistrationKind, RegistrationStatus } from "../types/landlord-registration";
import { TeamScope } from "../types/team-scope";

export class TeamOfDto {
	@ApiProperty()
	ownerId: string;

	@ApiProperty()
	ownerName: string;

	@ApiProperty({ enum: TeamScope, isArray: true, description: "Never includes payouts: payments endpoints answer 403." })
	scopes: TeamScope[];
}

export class RegistrationDto {
	@ApiProperty({ enum: RegistrationKind })
	@Expose()
	kind: RegistrationKind;

	@ApiProperty()
	@Expose()
	number: string;

	@ApiProperty({ description: "Always false: Seek does not check numbers against the registers. Use status." })
	@Expose()
	verified: boolean;

	@ApiProperty({ enum: RegistrationStatus, description: "Format check only: DECLARED or INVALID_FORMAT." })
	@Expose()
	status: RegistrationStatus;
}

export class NotificationPrefsDto {
	@ApiProperty({ default: 3 })
	@Expose()
	rentReminderDaysBefore: number;

	@ApiProperty({ default: true })
	@Expose()
	receiptEveryPayment: boolean;

	@ApiProperty({ default: true })
	@Expose()
	landlordEveryPayment: boolean;

	@ApiProperty({ default: true })
	@Expose()
	newQualifiedHousehold: boolean;

	@ApiProperty({ default: true })
	@Expose()
	complianceDue: boolean;

	@ApiProperty({ default: false })
	@Expose()
	weeklySummary: boolean;
}

export class UserDto {
	@ApiProperty()
	@Expose()
	@Transform(({ obj }) => obj?._id.toString())
	_id: string;

	@ApiProperty()
	@Expose()
	name: string;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	username?: string;

	@ApiProperty()
	@Expose()
	email: string;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	phone?: string;

	@ApiProperty({ required: false, type: String, format: "date" })
	@IsOptional()
	@Expose()
	dateOfBirth?: Date;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	universityDetails?: string;

	@ApiProperty({ enum: Role })
	@Expose()
	role: Role;

	@ApiProperty({ description: "Proved a university email address (student badge)." })
	@Expose()
	// Reads its own output too: @Serialize transforms an already-built UserDto a second time.
	@Transform(({ obj }) => Boolean(obj?.studentVerifiedAt ?? obj?.studentVerified))
	studentVerified: boolean;

	@ApiProperty({ type: String, nullable: true, description: "University behind the badge, e.g. \"University of St Andrews\"." })
	@Expose()
	@Transform(({ obj }) => ((obj?.studentVerifiedAt ?? obj?.studentVerified) && obj?.university) || null)
	university: string | null;

	@ApiProperty()
	@IsOptional()
	@Expose()
	profilePicUrl?: string;

	@ApiProperty()
	@Expose()
	isVerified: boolean;

	@ApiProperty()
	@Expose()
	lastSeen: Date;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	companyName?: string;

	@ApiProperty({ type: [RegistrationDto], required: false })
	@IsOptional()
	@Expose()
	@Type(() => RegistrationDto)
	registrations?: RegistrationDto[];

	@ApiProperty({ type: NotificationPrefsDto, required: false })
	@IsOptional()
	@Expose()
	@Type(() => NotificationPrefsDto)
	notificationPrefs?: NotificationPrefsDto;

	@ApiProperty({ required: false, description: "Whether rent payouts are connected (landlords)." })
	@Expose()
	@Transform(({ obj }) => Boolean(obj?.stripeAccountId))
	payoutsConnected?: boolean;

	@ApiProperty({
		required: false,
		nullable: true,
		description: "Where payouts go (landlords): { last4, bankName, verified }. Null until Stripe has a bank account."
	})
	@Expose()
	@Transform(({ obj }) => obj?.payoutBank ?? null)
	payoutBank?: { last4: string | null; bankName: string | null; verified: boolean } | null;

	@ApiProperty({ type: TeamOfDto, required: false, nullable: true, description: "Set when this account is on a landlord's team: whose account it helps run." })
	@Expose()
	@Transform(({ obj }) => obj?.teamOf ?? null)
	teamOf?: TeamOfDto | null;
}
