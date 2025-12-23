import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { Application } from "./application.schema";

@Injectable()
export class ApplicationService {
	constructor(
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>
	) {}


}
