import { applyDecorators } from "@nestjs/common";
import { ApiResponse } from "@nestjs/swagger";
import { ContactDto } from "./dto/contact.dto";
import { ErrorDto } from "src/dto/errorDto.dto";

export const ApiContactDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		})
	);
