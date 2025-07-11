import { Expose } from "class-transformer";
import { IsOptional } from "class-validator";
import { Role } from "../../auth/role.enum";

export class UserDto {
	@Expose()
	_id: string;

	@Expose()
	email: string;

	@Expose()
	role: Role;

	@IsOptional()
	@Expose()
	profilePicUrl?: string;

	@Expose()
	isVerified: string;
}
