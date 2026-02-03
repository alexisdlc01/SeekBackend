import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";
import { IsOptional } from "class-validator";
import { MessageDto } from "src/message/dto/message.dto";

export class ConversationDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	name: string;

	@ApiProperty({ required: false })
	@IsOptional()
	@Expose()
	lastMessage?: MessageDto;

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	groupDescription: string;

	@ApiProperty()
	@Expose()
	avatar?: string;

	@ApiProperty()
	@Expose()
	users: string[];

	@ApiProperty({ type: MessageDto, isArray: true })
	@Expose()
	messages: MessageDto[];
}
