import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Role } from "../auth/role.enum";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Bill, BillCategory, BillSource, BillStatus } from "./bill.schema";
import { CreateBillDto } from "./dto/create-bill.dto";
import { TenanciesService } from "../tenancies/tenancies.service";
import { User } from "../users/users.schema";
import { splitPence } from "./shares";

type Viewer = Pick<User, "_id" | "role"> & { name?: string };
type Allowanced = { energyAllowance?: number | null; tenants?: { toString(): string }[] };

/**
 * Energy fair-use: the tenancy's monthly allowance, scaled to the months the
 * bill covers, against what the bill used. Anything over is split between the tenants.
 */
export function allowanceFor(bill: Bill, tenancy: Allowanced) {
	if (bill.category !== BillCategory.ENERGY || tenancy?.energyAllowance == null) return null;
	const days =
		bill.periodStart && bill.periodEnd
			? (new Date(bill.periodEnd).getTime() - new Date(bill.periodStart).getTime()) / 86_400_000
			: 0;
	const months = Math.max(1, Math.round(days / 30.44));
	const allowance = tenancy.energyAllowance * months;
	const used = bill.amount;
	const overage = Math.max(0, used - allowance);
	const members = (tenancy.tenants ?? []).map(id => id.toString());
	return {
		utility: bill.category,
		allowance,
		used,
		percentUsed: allowance > 0 ? Math.round((used / allowance) * 100) : 0,
		overage,
		overagePerMember: splitPence(overage, members)
	};
}

@Injectable()
export class BillsService {
	constructor(
		@InjectModel(Bill.name) private readonly billModel: Model<Bill>,
		private readonly tenancies: TenanciesService
	) {}

	/** Bills for a tenancy with each tenant's share and the viewer's own share. */
	async listForTenancy(tenancyId: string, viewer: Viewer) {
		const tenancy = await this.tenancies.findForMember(tenancyId, viewer);
		const bills = await this.billModel
			.find({ tenancy: new Types.ObjectId(tenancyId) })
			.sort({ dueDate: -1, createdAt: -1 })
			.populate("paidBy", "name")
			.lean()
			.exec();
		const viewerId = viewer._id.toString();
		return bills.map(bill => this.withShares(bill, viewerId, tenancy));
	}

	async create(dto: CreateBillDto, viewer: Viewer) {
		const tenancy = await this.tenancies.findForMember(dto.tenancy, viewer);
		const tenantIds = tenancy.tenants.map(tenant => tenant.toString());
		const split = dto.splitBetween?.length ? [...new Set(dto.splitBetween)] : tenantIds;
		if (split.some(id => !tenantIds.includes(id))) {
			throw new BadRequestException("A bill can only be split between tenants of this tenancy.");
		}
		// A tenant adding a manual expense has fronted it: their own share is paid in the same write.
		const source = dto.source ?? BillSource.MANUAL;
		const viewerId = viewer._id.toString();
		const payer = !dto.includedInRent && source === BillSource.MANUAL && tenantIds.includes(viewerId) ? viewerId : null;
		const paidShares = payer && split.includes(payer) ? [payer] : [];
		const settled = dto.includedInRent || (split.length > 0 && split.every(id => paidShares.includes(id)));
		const bill = await this.billModel.create({
			tenancy: tenancy._id,
			provider: dto.provider.trim(),
			category: dto.category,
			amount: dto.amount,
			periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
			periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
			dueDate: dto.dueDate ? new Date(dto.dueDate) : null,
			includedInRent: dto.includedInRent ?? false,
			splitBetween: split.map(id => new Types.ObjectId(id)),
			paidBy: payer ? new Types.ObjectId(payer) : null,
			paidShares: paidShares.map(id => new Types.ObjectId(id)),
			// Bills already covered by the rent (or fronted by their only sharer) have nothing left to pay.
			status: settled ? BillStatus.PAID : BillStatus.DUE,
			paidAt: settled && !dto.includedInRent ? new Date() : null,
			source
		});
		return this.withShares({ ...bill.toObject(), paidBy: payer ? { _id: bill.paidBy, name: viewer.name } : null } as never, viewerId, tenancy);
	}

	/**
	 * A tenant who shares the bill marks only their own share as paid; the bill
	 * turns PAID once every share is. Anyone else on the tenancy (the landlord)
	 * settles the whole bill, as before.
	 */
	async markPaid(billId: string, viewer: Viewer) {
		if (!Types.ObjectId.isValid(billId)) throw new BadRequestException("Invalid bill id.");
		const bill = await this.billModel.findById(billId).populate("paidBy", "name").lean().exec();
		if (!bill) throw new NotFoundException("Bill not found.");
		const tenancy = await this.tenancies.findForMember(bill.tenancy.toString(), viewer);
		const viewerId = viewer._id.toString();
		const sharer = !bill.includedInRent && (bill.splitBetween ?? []).some(id => id.toString() === viewerId);
		// Only the landlord (or support) settles the whole bill; a flatmate outside the split can't clear others' shares.
		const settlesAll = tenancy.landlord?.toString() === viewerId || viewer.role === Role.SUPERUSER;
		if (!sharer && !bill.includedInRent && !settlesAll) {
			throw new ForbiddenException("You are not part of this bill's split.");
		}
		let updated = sharer
			? await this.billModel
					.findByIdAndUpdate(bill._id, { $addToSet: { paidShares: viewer._id } }, { new: true })
					.populate("paidBy", "name")
					.lean()
					.exec()
			: bill;
		const paid = new Set((updated?.paidShares ?? []).map(id => id.toString()));
		const everyone = !sharer || (updated?.splitBetween ?? []).every(id => paid.has(id.toString()));
		if (everyone && updated?.status !== BillStatus.PAID) {
			updated = await this.billModel
				.findByIdAndUpdate(
					bill._id,
					{ $set: { status: BillStatus.PAID, paidAt: bill.paidAt ?? new Date() } },
					{ new: true }
				)
				.populate("paidBy", "name")
				.lean()
				.exec();
		}
		return this.withShares(updated!, viewerId, tenancy);
	}

	/** paidBy arrives populated with the payer's name; the API returns the id plus paidByName. */
	private withShares(bill: Bill, viewerId: string, tenancy?: Allowanced) {
		const payer = bill.paidBy as unknown as { _id?: Types.ObjectId; name?: string } | Types.ObjectId | null;
		const payerId = payer && "_id" in payer && payer._id ? payer._id : (payer as Types.ObjectId | null);
		const people = (bill.splitBetween ?? []).map(id => id.toString());
		const paid = new Set((bill.paidShares ?? []).map(id => id.toString()));
		// A bill marked PAID before per-share tracking counts as settled for everyone.
		const settled = (user: string) => bill.includedInRent || bill.status === BillStatus.PAID || paid.has(user);
		const shares = (bill.includedInRent ? people.map(user => ({ user, amount: 0 })) : splitPence(bill.amount, people)).map(
			share => ({ ...share, paid: settled(share.user) })
		);
		return {
			...bill,
			paidBy: payerId ? payerId.toString() : null,
			paidByName: (payer && "name" in payer ? payer.name : null) ?? null,
			shares,
			myShare: shares.find(share => share.user === viewerId)?.amount ?? 0,
			myPaid: settled(viewerId),
			allowance: tenancy ? allowanceFor(bill, tenancy) : null
		};
	}
}
