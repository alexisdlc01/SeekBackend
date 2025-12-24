import { Module } from "@nestjs/common";
import { ApplicationService } from "./application.service";
import { ApplicationController } from "./application.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Application, ApplicationSchema } from "./application.schema";
import { ListingsModule } from "../listings/listing.module";
import { SharedModule } from "../shared/shared.module";

@Module({
	imports: [
		MongooseModule.forFeature([
			{
				name: Application.name,
				schema: ApplicationSchema
			}
		]),
		ListingsModule,
		SharedModule
	],
	controllers: [ApplicationController],
	providers: [ApplicationService]
})
export class ApplicationModule {}
