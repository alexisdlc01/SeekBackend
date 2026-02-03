import { ApiProperty } from "@nestjs/swagger";
import { Expose, Type } from "class-transformer";
import { Listing } from "../../listings/listings.schema";
import { ApplicationStage } from "../enums/application-stage.enum";
import { ConversationDto } from "src/conversation/dto/conversation.dto";
import { ValidateNested } from "class-validator";

export class ApplicationDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	listing: Listing;

	@ApiProperty({ type: ConversationDto })
	@Expose()
	@ValidateNested({ each: true })
	@Type(() => ConversationDto)
	conversation: ConversationDto;

	@ApiProperty()
	@Expose()
	landlord: string;

	@ApiProperty({ isArray: true, type: String })
	@Expose()
	applicants: string[];

	@ApiProperty()
	@Expose()
	createdAt: Date;

	@ApiProperty()
	@Expose()
	owner: string;

	@ApiProperty({ enum: ApplicationStage })
	@Expose()
	stage: ApplicationStage;
}
