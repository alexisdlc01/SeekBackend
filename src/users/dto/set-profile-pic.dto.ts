import {
	IsString
} from "class-validator";

export class SetProfilePicDto {
	@IsString()
	url: string;
}
