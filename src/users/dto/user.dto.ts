import { Expose } from "class-transformer";
import { IsOptional } from "class-validator";
import { Role } from "../../auth/role.enum";
import { ApiProperty } from "@nestjs/swagger";

export class UserDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	name: string;

	@ApiProperty()
	@Expose()
	email: string;

	@ApiProperty({ enum: Role })
	@Expose()
	role: Role;

	@ApiProperty()
	@IsOptional()
	@Expose()
	profilePicUrl?: string;

	@ApiProperty()
	@Expose()
	isVerified: string;
}
