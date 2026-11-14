"use server";

import { z } from "zod";
import {
  deleteLocation,
  deleteService,
  saveLocation,
  saveService,
} from "@/server/admin-foundation/catalog";
import { locationInputSchema, serviceInputSchema } from "@/server/admin-foundation/catalog-schemas";
import { ownerAction } from "@/server/admin-foundation/owner-action";

const idSchema = z.object({ id: z.uuid() });

/** Create or update a service (include `id` to update). Prices are typed in dollars and validated to cents. */
export async function saveServiceAction(input: unknown) {
  return ownerAction(serviceInputSchema, input, (parsed, { db, actor }) =>
    saveService(db, actor, parsed),
  );
}

export async function deleteServiceAction(id: string) {
  return ownerAction(idSchema, { id }, async (parsed, { db, actor }) => {
    await deleteService(db, actor, parsed.id);
  });
}

export async function saveLocationAction(input: unknown) {
  return ownerAction(locationInputSchema, input, (parsed, { db, actor }) =>
    saveLocation(db, actor, parsed),
  );
}

export async function deleteLocationAction(id: string) {
  return ownerAction(idSchema, { id }, async (parsed, { db, actor }) => {
    await deleteLocation(db, actor, parsed.id);
  });
}
