import { IsString } from "class-validator";

export class SendMessageDto {
	@IsString()
	messageData: string;
}
