import { ApiProperty } from "@nestjs/swagger";
import { Bill, BillCategory } from "../bill.schema";

export class BillShareAmountDto {
	@ApiProperty({ type: String })
	user: string;

	@ApiProperty({ description: "Amount in pence." })
	amount: number;
}

export class BillShareDto {
	@ApiProperty({ type: String })
	user: string;

	@ApiProperty({ description: "This tenant's share, in pence." })
	amount: number;

	@ApiProperty({ description: "This tenant has paid their share." })
	paid: boolean;
}

export class BillAllowanceDto {
	@ApiProperty({ enum: BillCategory })
	utility: BillCategory;

	@ApiProperty({ description: "Household allowance for this bill's period, in pence." })
	allowance: number;

	@ApiProperty({ description: "What this bill used, in pence." })
	used: number;

	@ApiProperty({ description: "Share of the allowance used, as a whole percentage (can exceed 100)." })
	percentUsed: number;

	@ApiProperty({ description: "Usage over the allowance, in pence (0 when within it)." })
	overage: number;

	@ApiProperty({ type: [BillShareAmountDto], description: "The overage split between the tenants, in pence." })
	overagePerMember: BillShareAmountDto[];
}

/** A bill as the API returns it: the stored bill plus each tenant's share. */
export class BillViewDto extends Bill {
	@ApiProperty({ type: String, nullable: true, description: "Name of the tenant in paidBy." })
	paidByName: string | null;

	@ApiProperty({ type: [BillShareDto] })
	shares: BillShareDto[];

	@ApiProperty({ description: "The signed-in tenant's share, in pence (0 if they don't share it)." })
	myShare: number;

	@ApiProperty({ description: "The signed-in tenant's share is paid (or the bill is settled)." })
	myPaid: boolean;

	@ApiProperty({ type: BillAllowanceDto, nullable: true, description: "Energy fair-use allowance for this bill, when the tenancy has one." })
	allowance: BillAllowanceDto | null;
}
