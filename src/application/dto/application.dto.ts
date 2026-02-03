import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";
import { Listing } from "../../listings/listings.schema";
import { ApplicationStage } from "../enums/application-stage.enum";
import { ConversationDto } from "src/conversation/dto/conversation.dto";

export class ApplicationDto {
	@ApiProperty()
	@Expose()
	_id: string;

	@ApiProperty()
	@Expose()
	listing: Listing;

	@ApiProperty({ type: ConversationDto })
	@Expose()
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
