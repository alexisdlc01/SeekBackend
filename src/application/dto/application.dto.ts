import { ApiProperty } from "@nestjs/swagger";
import { Expose, Transform, Type } from "class-transformer";
import { Listing } from "../../listings/listings.schema";
import { ApplicationStage } from "../enums/application-stage.enum";
import { ConversationDto } from "../../conversation/dto/conversation.dto";
import { ValidateNested } from "class-validator";
import { ObjectIdString } from "src/shared/object-id.transform";
import { UserDto } from "src/users/dto/user.dto";
import { PassportDto } from "src/users/dto/passport.dto";

export class UniversityDetailsDto {
	@ApiProperty({ description: "What the student wrote on their profile." })
	text: string;

	@ApiProperty({ required: false })
	course?: string;

	@ApiProperty({ required: false })
	university?: string;

	@ApiProperty({ required: false, description: "1-4, or Final." })
	year?: string;
}

export class ApplicationCriterionDto {
	@ApiProperty({ enum: ["PASSPORTS", "HOUSEHOLD_SIZE", "MAX_HOUSEHOLD", "GUARANTOR", "REFERENCES"] })
	key: string;

	@ApiProperty()
	label: string;

	@ApiProperty()
	passed: boolean;

	@ApiProperty({ example: "2 of 3 members have a verified guarantor agreement" })
	detail: string;
}

export class ApplicationMemberDto {
	@ApiProperty()
	@Expose()
	user: string;

	@ApiProperty({ required: false })
	@Expose()
	name?: string;

	@ApiProperty({ type: PassportDto, description: "File links are only included while the member's share is active." })
	@Expose()
	passport: PassportDto;

	@ApiProperty({ type: String, format: "date-time", nullable: true })
	@Expose()
	shareExpiresAt: Date | null;

	@ApiProperty({ type: UniversityDetailsDto, nullable: true, description: "Course, university and year from the student's profile." })
	@Expose()
	universityDetails: UniversityDetailsDto | null;
}

export class ApplicationDto {
	@ApiProperty()
	@Expose()
	@Transform(({ obj }) => obj?._id.toString())
	_id: string;

	@ApiProperty()
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => Listing)
	listing: Listing;

	@ApiProperty({ type: ConversationDto })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => ConversationDto)
	conversation: ConversationDto;

	@ApiProperty()
	@Expose()
	@ObjectIdString()
	landlord: string;

	@ApiProperty({ isArray: true, type: String })
	@Expose()
	@ObjectIdString()
	applicants: string[];

	@ApiProperty({ type: UserDto, isArray: true, required: false })
	@Expose()
	@Type(() => UserDto)
	applicantUsers?: UserDto[];

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	@ObjectIdString()
	owner: string;

	@ApiProperty({ enum: ApplicationStage })
	@Expose()
	stage: ApplicationStage;

	@ApiProperty({ type: String, format: "date-time", nullable: true, required: false })
	@Expose()
	@Type(() => Date)
	sentAt?: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true, required: false })
	@Expose()
	@Type(() => Date)
	viewingAt?: Date | null;

	@ApiProperty({ type: String, format: "date-time", nullable: true, required: false })
	@Expose()
	@Type(() => Date)
	offeredAt?: Date | null;

	@ApiProperty({
		type: String,
		format: "date-time",
		nullable: true,
		required: false,
		description: "Deadline for the household to accept the offer (15 days after it was made)."
	})
	@Expose()
	@Type(() => Date)
	offerExpiresAt?: Date | null;

	@ApiProperty({ type: Number, nullable: true, required: false, description: "Holding deposit per room in whole pounds, recorded with the offer." })
	@Expose()
	holdingDeposit?: number | null;

	@ApiProperty({ type: String, nullable: true, required: false })
	@Expose()
	rejectReason?: string | null;

	@ApiProperty({ type: ApplicationCriterionDto, isArray: true, required: false, description: "Landlord view: pass or fail for each criterion on the listing." })
	@Expose()
	criteria?: ApplicationCriterionDto[];

	@ApiProperty({ required: false, description: "Share of members whose passport is ready, 0-100." })
	@Expose()
	readiness?: number;

	@ApiProperty({ required: false, description: "Every member ready and the group meets the listing criteria." })
	@Expose()
	qualified?: boolean;

	@ApiProperty({
		type: Number,
		nullable: true,
		required: false,
		description: "Student view: place among qualified households, 1 = first in line. Null while not qualified."
	})
	queuePosition?: number | null;

	@ApiProperty({ required: false, description: "Student view: qualified households in this listing's queue." })
	queueSize?: number;

		@ApiProperty({ type: ApplicationMemberDto, isArray: true, required: false })
	@Expose()
	members?: ApplicationMemberDto[];
}
