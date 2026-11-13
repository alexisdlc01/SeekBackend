import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter } from "@nestjs/common";
import { Error as MongooseError } from "mongoose";
import type { Response } from "express";

/** A malformed id reaching mongoose (any `:id` route) is a client error: 400 instead of 500. */
@Catch(MongooseError.CastError)
export class CastErrorFilter implements ExceptionFilter {
	catch(_error: MongooseError.CastError, host: ArgumentsHost): void {
		const exception = new BadRequestException("Invalid id.");
		host.switchToHttp().getResponse<Response>().status(exception.getStatus()).json(exception.getResponse());
	}
}
