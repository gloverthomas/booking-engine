import { z } from "zod";
import { getDb } from "@/db/client";
import { getEnv } from "@/lib/env";
import { getBusiness } from "../admin-foundation/business";
import { hasPermission, type AccessSession } from "../auth/access-core";
import { PERMISSIONS } from "../auth/permissions";

export const googleSignInSchema = z.object({
  /** The Google ID token the iOS app gets from native Google Sign-In. */
  idToken: z.string().min(20).max(4096),
  nonce: z.string().max(256).optional(),
});

export interface MeView {
  userId: string;
  email: string;
  name: string | null;
  role: AccessSession["role"];
  staffId: string | null;
  /** What this person may do, so the app can hide controls instead of showing errors. */
  permissions: string[];
  business: { name: string; timezone: string };
}

export function permissionsFor(role: AccessSession["role"]): string[] {
  return PERMISSIONS.filter((p) => hasPermission(role, p));
}

export async function buildMe(session: AccessSession): Promise<MeView> {
  const business = await getBusiness(getDb());
  return {
    userId: session.userId,
    email: session.email,
    name: session.name ?? null,
    role: session.role,
    staffId: session.staffId,
    permissions: permissionsFor(session.role),
    business: { name: business.name, timezone: business.timezone },
  };
}

/** Env is read lazily so importing this module never needs configuration. */
export const ownerEmailsRaw = () => getEnv().OWNER_EMAILS;
