import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiResponse } from "@nestjs/swagger";
import { ContactDto } from "./dto/contact.dto";
import { ErrorDto } from "src/dto/errorDto.dto";

export const ApiContactDocs = () =>
	applyDecorators(
		ApiBody({ type: ContactDto }),
		ApiResponse({
			status: 201,
			schema: {
				type: "object",
				properties: {}
			}
		}),
		ApiResponse({
			status: 400,
			type: ErrorDto
		}),
		ApiResponse({
			status: 401,
			type: ErrorDto
		})
	);
