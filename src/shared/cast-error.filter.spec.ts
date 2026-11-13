import { ArgumentsHost } from "@nestjs/common";
import { Error as MongooseError } from "mongoose";
import { CastErrorFilter } from "./cast-error.filter";

describe("CastErrorFilter", () => {
	it("turns a CastError into a 400 Invalid id", () => {
		const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
		const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
		new CastErrorFilter().catch(new MongooseError.CastError("ObjectId", "me", "_id"), host);
		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.json).toHaveBeenCalledWith({ statusCode: 400, message: "Invalid id.", error: "Bad Request" });
	});

	it("is only bound to CastError, so other errors keep Nest's default handling", () => {
		expect(Reflect.getMetadata("__filterCatchExceptions__", CastErrorFilter)).toEqual([MongooseError.CastError]);
	});
});
