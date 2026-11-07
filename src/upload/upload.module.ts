import { Module } from "@nestjs/common";
import { UploadController } from "./upload.controller";
import { UploadService } from "./upload.service";
import { SharedModule } from "../shared/shared.module";
import { MongooseModule } from "@nestjs/mongoose";
import { Listing, ListingSchema } from "../listings/listings.schema";
import { User, UserSchema } from "../users/users.schema";
import {
	DocumentShare,
	DocumentShareSchema
} from "../users/shares/document-share.schema";
import { DocumentAccess, DocumentAccessSchema } from "../users/shares/document-access.schema";
import { Tenancy, TenancySchema } from "../tenancies/tenancy.schema";
import { Contract, ContractSchema } from "../contracts/contract.schema";

@Module({
	imports: [
		MongooseModule.forFeature([
			{ name: Listing.name, schema: ListingSchema },
			{ name: User.name, schema: UserSchema },
			{ name: DocumentShare.name, schema: DocumentShareSchema },
			{ name: DocumentAccess.name, schema: DocumentAccessSchema },
			{ name: Tenancy.name, schema: TenancySchema },
			{ name: Contract.name, schema: ContractSchema }
		]),
		SharedModule
	],
	controllers: [UploadController],
	providers: [UploadService],
	exports: [UploadService]
})
export class UploadModule {}
