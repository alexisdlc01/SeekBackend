import { ApiProperty } from "@nestjs/swagger";
import { Matches } from "class-validator";

export class EndTenancyDto {
	@ApiProperty({ type: String, format: "date", description: "The first London calendar day no longer covered by the tenancy." })
	@Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: "endDate must look like YYYY-MM-DD" })
	endDate: string;
}

export class GiveNoticeDto {
	@ApiProperty({
		type: String,
		format: "date",
		description:
			"The first London calendar day the tenancy no longer covers (it ends at 00:00 London time that day). At least 28 days from today in Scotland, Wales and Northern Ireland; in England at least two months away and on a rent day (the start date's day of the month)."
	})
	@Matches(/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, { message: "endDate must look like YYYY-MM-DD" })
	endDate: string;
}
