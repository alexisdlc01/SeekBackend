import { Expose, Transform } from "class-transformer";
import { IsOptional } from "class-validator";
import { Role } from "../../auth/role.enum";
import { ApiProperty } from "@nestjs/swagger";

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
}
