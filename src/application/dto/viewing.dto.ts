import { ApiProperty } from "@nestjs/swagger";
import { IsDateString } from "class-validator";

export class ScheduleViewingDto {
	@ApiProperty({ type: String, format: "date-time", example: "2026-11-12T17:30:00.000Z" })
	@IsDateString()
	viewingAt: string;
}
