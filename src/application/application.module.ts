import { Module } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { ApplicationController } from "./application.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Application, ApplicationSchema } from "./application.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Application.name,
				schema: ApplicationSchema
			}
		])
	],
	controllers: [ApplicationController],
	providers: [ApplicationService]
})
export class ApplicationModule {}
