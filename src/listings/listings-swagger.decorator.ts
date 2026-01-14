import { applyDecorators } from "@nestjs/common";
import { ApiBody, ApiResponse } from "@nestjs/swagger";
import { ErrorDto } from "../dto/errorDto.dto";
import {
	CreateListingDto,
	Step2ListingDto,
	Step3ListingDto
} from "./dto/create-listing.dto";
import { Listing } from "./listings.schema";

export const ApiDraftDocs = () =>
	applyDecorators(
		ApiResponse({
			status: 201,
			type: String
		}),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiCreateStep1Docs = () =>
	applyDecorators(
		ApiBody({ type: CreateListingDto }),
		ApiResponse({ status: 204, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiCreateStep2Docs = () =>
	applyDecorators(
		ApiBody({ type: Step2ListingDto }),
		ApiResponse({ status: 204, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiCreateStep3Docs = () =>
	applyDecorators(
		ApiBody({ type: Step3ListingDto }),
		ApiResponse({ status: 204, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiPublishDocs = () =>
	applyDecorators(
		ApiBody({ type: CreateListingDto }),
		ApiResponse({ status: 204, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiDeleteListingDocs = () =>
	applyDecorators(
		ApiResponse({ status: 204, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiMyListingsDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200, type: Listing, isArray: true }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiGetListingDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 403, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiGetAllUnverifiedDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200, type: Listing, isArray: true }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiGetAllVerifiedDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200, type: Listing, isArray: true }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto })
	);

export const ApiGetByIdDocs = () =>
	applyDecorators(
		ApiResponse({ status: 200, type: Listing }),
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);

export const ApiVerifyListingDocs = () =>
	applyDecorators(
		ApiResponse({ status: 400, type: ErrorDto }),
		ApiResponse({ status: 401, type: ErrorDto }),
		ApiResponse({ status: 404, type: ErrorDto })
	);
