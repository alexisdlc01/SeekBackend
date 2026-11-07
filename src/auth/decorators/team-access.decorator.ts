import { SetMetadata } from "@nestjs/common";
import { TeamScope } from "../../users/types/team-scope";

export const TEAM_SCOPES_KEY = "teamScopes";

/**
 * Lets a landlord's team member call this handler as their owner when they
 * hold one of the scopes. With no scopes the handler is owner-only (payouts,
 * payments): team members get 403. Handlers without it act as the caller.
 */
export const TeamAccess = (...scopes: TeamScope[]) => SetMetadata(TEAM_SCOPES_KEY, scopes);

export const ANY_TEAM_SCOPE = Object.values(TeamScope);
