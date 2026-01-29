import {
	IsString
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AccessReqDto {
	@ApiProperty()
	@IsString()
	key: string;
};
