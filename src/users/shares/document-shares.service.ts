import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { DocumentShare, SHARE_TTL_MS } from "./document-share.schema";
import { User } from "../users.schema";
import { IDENTITY_DOCUMENT_TYPES } from "../types/document-type";
import { Application } from "../../application/application.schema";
import { ApplicationStage } from "../../application/enums/application-stage.enum";

export interface ShareView {
	_id: string;
	viewer: { _id: string; name?: string; companyName?: string } | string;
	listing: { _id: string; propertyTitle?: string; streetAddress?: string } | string | null;
	application: string | null;
	expiresAt: Date;
	revokedAt: Date | null;
	revokedBy: "system" | "student" | null;
	active: boolean;
	createdAt?: Date;
}

export function isShareActive(
	share: Pick<DocumentShare, "expiresAt" | "revokedAt">,
	now: Date = new Date()
): boolean {
	return !share.revokedAt && new Date(share.expiresAt).getTime() > now.getTime();
}

/** Still open for this student: not rejected or withdrawn, and they are still an applicant. */
function openApplicationFilter(owner: Types.ObjectId) {
	return { applicants: owner, stage: { $nin: [ApplicationStage.REJECTED, ApplicationStage.WITHDRAWN] } };
}

@Injectable()
export class DocumentSharesService {
	constructor(
		@InjectModel(DocumentShare.name)
		private readonly shareModel: Model<DocumentShare>,
		@InjectModel(User.name)
		private readonly userModel: Model<User>,
		@InjectModel(Application.name)
		private readonly applicationModel: Model<Application>
	) {}

	/** Starts (or restarts) the 30-day erasure clock of these students' identity documents: a landlord can now open them. */
	async markIdentityShared(ownerIds: (Types.ObjectId | string)[], now: Date = new Date()): Promise<void> {
		if (ownerIds.length === 0) return;
		await this.userModel.updateMany(
			{ _id: { $in: ownerIds.map(id => new Types.ObjectId(id.toString())) } },
			{ $set: { "documents.$[doc].lastSharedAt": now } },
			{ arrayFilters: [{ "doc.type": { $in: IDENTITY_DOCUMENT_TYPES } }] }
		);
	}

	/** An identity document uploaded while a share is live is exposed too, so its clock starts now. */
	async markIdentitySharedIfActive(ownerId: Types.ObjectId | string, now: Date = new Date()): Promise<void> {
		const live = await this.shareModel.exists({
			owner: new Types.ObjectId(ownerId.toString()),
			revokedAt: null,
			expiresAt: { $gt: now }
		});
		if (live) await this.markIdentityShared([ownerId], now);
	}

	/**
	 * Grants the landlord a fresh 14-day window on each applicant's files.
	 * Re-sending refreshes the window and reopens a share Seek closed (lapsed
	 * offer, member left) but never resurrects a share the student revoked,
	 * unless `reconsent` (the student just joined the household again).
	 */
	async shareForApplication(params: {
		ownerIds: (Types.ObjectId | string)[];
		viewer: Types.ObjectId | string;
		listing?: Types.ObjectId | string;
		application: Types.ObjectId | string;
		now?: Date;
		reconsent?: boolean;
	}): Promise<void> {
		const now = params.now ?? new Date();
		const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);
		if (params.ownerIds.length === 0) return;
		await this.shareModel.bulkWrite(
			params.ownerIds.map(owner => ({
				updateOne: {
					filter: {
						owner: new Types.ObjectId(owner.toString()),
						application: new Types.ObjectId(params.application.toString())
					},
					update: {
						$set: {
							viewer: new Types.ObjectId(params.viewer.toString()),
							...(params.listing
								? { listing: new Types.ObjectId(params.listing.toString()) }
								: {}),
							expiresAt
						},
						$setOnInsert: { revokedAt: null }
					},
					upsert: true
				}
			}))
		);
		await this.shareModel.updateMany(
			{
				owner: { $in: params.ownerIds.map(id => new Types.ObjectId(id.toString())) },
				application: new Types.ObjectId(params.application.toString()),
				revokedAt: { $ne: null },
				...(params.reconsent ? {} : { revokedBy: "system" })
			},
			{ $set: { revokedAt: null, revokedBy: null } }
		);
		await this.markIdentityShared(params.ownerIds, now);
	}

	/** Access ends when the application closes: revokes its shares (only these owners' when given). */
	async revokeForApplication(application: Types.ObjectId | string, ownerIds?: (Types.ObjectId | string)[]): Promise<void> {
		await this.shareModel.updateMany(
			{
				application: new Types.ObjectId(application.toString()),
				revokedAt: null,
				...(ownerIds ? { owner: { $in: ownerIds.map(id => new Types.ObjectId(id.toString())) } } : {})
			},
			{ $set: { revokedAt: new Date(), revokedBy: "system" } }
		);
	}

	async listForOwner(ownerId: string, now: Date = new Date()): Promise<ShareView[]> {
		const shares = await this.shareModel
			.find({ owner: new Types.ObjectId(ownerId) })
			.populate({ path: "viewer", select: "name companyName" })
			.populate({ path: "listing", select: "propertyTitle streetAddress cityTown" })
			.sort({ expiresAt: -1 })
			.lean()
			.exec();
		// A stop on an application that has since closed can never be shared again (reopen() is 409): hide it.
		const stopped = shares.filter(share => share.revokedBy === "student" && share.application).map(share => share.application);
		const open = stopped.length
			? new Set((await this.applicationModel.distinct("_id", { _id: { $in: stopped }, ...openApplicationFilter(new Types.ObjectId(ownerId)) })).map(String))
			: new Set<string>();
		return shares.filter(share => share.revokedBy !== "student" || !share.application || open.has(String(share.application))).map(share => ({
			_id: share._id.toString(),
			viewer: share.viewer as unknown as ShareView["viewer"],
			listing: (share.listing ?? null) as unknown as ShareView["listing"],
			application: share.application?.toString() ?? null,
			expiresAt: share.expiresAt,
			revokedAt: share.revokedAt ?? null,
			revokedBy: share.revokedBy ?? null,
			active: isShareActive(share, now),
			createdAt: share.createdAt
		}));
	}

	/** The student undoes their own "Stop sharing". A share Seek closed (application over) never reopens here. */
	async reopen(ownerId: string, shareId: string, now: Date = new Date()): Promise<ShareView> {
		const filter = { _id: new Types.ObjectId(shareId), owner: new Types.ObjectId(ownerId), revokedBy: "student" as const };
		const share = await this.shareModel.findOne(filter).lean().exec();
		if (!share) throw new NotFoundException("Share not found");
		// Closed: rejected, withdrawn, deleted, or the student has left the household.
		if (share.application) {
			const open = await this.applicationModel.exists({ _id: share.application, ...openApplicationFilter(filter.owner) });
			if (!open) throw new ConflictException("This application is closed.");
		}
		const result = await this.shareModel.updateOne(filter, {
			$set: { revokedAt: null, revokedBy: null, expiresAt: new Date(now.getTime() + SHARE_TTL_MS) }
		});
		if (result.matchedCount === 0) throw new NotFoundException("Share not found");
		await this.markIdentityShared([ownerId], now);
		const view = (await this.listForOwner(ownerId, now)).find(item => item._id === shareId);
		if (!view) throw new NotFoundException("Share not found");
		return view;
	}

	async revoke(ownerId: string, shareId: string): Promise<void> {
		if (!Types.ObjectId.isValid(shareId)) {
			throw new NotFoundException("Share not found");
		}
		const result = await this.shareModel.updateOne(
			{
				_id: new Types.ObjectId(shareId),
				owner: new Types.ObjectId(ownerId)
			},
			{ $set: { revokedAt: new Date(), revokedBy: "student" } }
		);
		if (result.matchedCount === 0) {
			throw new NotFoundException("Share not found");
		}
	}

	/** Owners whose documents this viewer may open right now, with the share's end. */
	async activeOwnersFor(
		viewerId: string,
		ownerIds: (Types.ObjectId | string)[],
		now: Date = new Date()
	): Promise<Map<string, Date>> {
		if (ownerIds.length === 0) return new Map();
		const shares = await this.shareModel
			.find({
				viewer: new Types.ObjectId(viewerId),
				owner: { $in: ownerIds.map(id => new Types.ObjectId(id.toString())) },
				revokedAt: null,
				expiresAt: { $gt: now }
			})
			.select("owner expiresAt")
			.lean()
			.exec();
		const result = new Map<string, Date>();
		for (const share of shares) {
			const owner = share.owner.toString();
			const current = result.get(owner);
			if (!current || current < share.expiresAt) {
				result.set(owner, share.expiresAt);
			}
		}
		return result;
	}
}
