import { ApiProperty } from "@nestjs/swagger";
import { IsString, Matches, MaxLength } from "class-validator";

export class PushTokenDto {
	@ApiProperty({ example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" })
	@IsString()
	@MaxLength(200)
	@Matches(/^Expo(nent)?PushToken\[[^\]\s]+\]$/, { message: "token must be an Expo push token" })
	token: string;
}
