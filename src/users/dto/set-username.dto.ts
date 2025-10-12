import {
	IsString
} from "class-validator";

export class SetUsernameDto {
	@IsString()
	name: string;
}
