import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { ListingsGateway } from "./listings.gateway";

@Injectable()
export class ListingsChangeListenerService implements OnModuleInit {
	private readonly logger = new Logger(ListingsChangeListenerService.name);

	constructor(
		@InjectConnection() private readonly connection: Connection,
		private readonly listingsGateway: ListingsGateway
	) {}

	onModuleInit() {
		const changeStream = this.connection.collection("listings").watch();

		changeStream.on("change", change => {
			if (change.operationType === "delete") {
				const deletedId = change.documentKey._id.toString();
				this.logger.log(`deleted listing: ${deletedId}`);
				this.listingsGateway.emitListingDeleted(deletedId);
			}
			this.logger.log("Listening for listing deletions");
		});
	}
}
