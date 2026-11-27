import { FilterQuery, PipelineStage } from "mongoose";
import { Conversation } from "./converstaion.schema";

// Application chats are named `${student}'s application to ${propertyTitle}` (ApplicationService.create).
const JOIN = "'s application to ";

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const codePoints = (value: string) => [...value].length;

type Rename = [FilterQuery<Conversation>, PipelineStage.Set[]];

/** Filter and update that swap the student's name at the start of their application chats' names. */
export function renameStudent(from: string, to: string): Rename {
	// The schema trims the stored name, so it starts with the trimmed student name.
	const prefix = from.trimStart() + JOIN;
	return [
		{ name: { $regex: `^${escapeRegExp(prefix)}` } },
		// $literal: a name starting with "$" would otherwise be read as a field path.
		[{ $set: { name: { $concat: [{ $literal: to.trimStart() + JOIN }, { $substrCP: ["$name", codePoints(prefix), { $strLenCP: "$name" }] }] } } }]
	];
}

/** Filter and update that swap the property title at the end of its application chats' names. */
export function renameProperty(from: string, to: string): Rename {
	from = from.trimEnd();
	to = to.trimEnd();
	return [
		{ name: { $regex: `${escapeRegExp(JOIN + from)}$` } },
		[{ $set: { name: { $concat: [{ $substrCP: ["$name", 0, { $subtract: [{ $strLenCP: "$name" }, codePoints(from)] }] }, { $literal: to }] } } }]
	];
}
