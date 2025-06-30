import { Expose } from "class-transformer";
import { IsOptional } from "class-validator";

export class UserDto {
	@Expose()
	email: string;

	@Expose()
	@IsOptional()
	isStudent: boolean

	@Expose()
	@IsOptional()
	isLandlordOrAgency: boolean

	@Expose()
	@IsOptional()
	isSuperUser: boolean
}