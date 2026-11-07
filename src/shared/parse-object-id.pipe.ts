import { BadRequestException, Injectable, PipeTransform } from "@nestjs/common";
import { isValidObjectId } from "mongoose";

/** Rejects route ids that are not Mongo ObjectIds with a 400 instead of a cast error. */
@Injectable()
export class ParseObjectIdPipe implements PipeTransform<string, string> {
	transform(value: string): string {
		if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value) || !isValidObjectId(value)) {
			throw new BadRequestException("Invalid id.");
		}
		return value;
	}
}
