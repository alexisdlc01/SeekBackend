import { Expose } from "class-transformer";
import { IsEnum } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { MessageType } from "../message.schema";

export class MessageDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	sender: string;

	@ApiProperty({ enum: MessageType })
	@IsEnum(MessageType)
	@Expose()
	messageType: MessageType;

	@ApiProperty()
	@Expose()
	data: string;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	conversation: string;

	@ApiProperty()
	@Expose()
	seenUsers: string[];

	@ApiProperty()
	@Expose()
	deliveredTo: string[];
}
