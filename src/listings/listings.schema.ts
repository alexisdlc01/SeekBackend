import { Schema, SchemaFactory } from "@nestjs/mongoose";

@Schema()
export class Listing {}

export const ListingSchema = SchemaFactory.createForClass(Listing);
