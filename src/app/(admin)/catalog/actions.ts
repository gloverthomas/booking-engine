"use server";

import { z } from "zod";
import {
  deleteLocation,
  deleteService,
  saveLocation,
  saveService,
} from "@/server/admin-foundation/catalog";
import { catalogAction } from "@/server/admin-foundation/catalog-access";
import { locationInputSchema, serviceInputSchema } from "@/server/admin-foundation/catalog-schemas";

const idSchema = z.object({ id: z.uuid() });

/**
 * Create or update a service (include `id` to update), including its per-stylist overrides and its
 * seniority price table. Prices are typed in dollars and validated to cents. Needs `catalog.edit`.
 */
export async function saveServiceAction(input: unknown) {
  return catalogAction("catalog.edit", serviceInputSchema, input, (parsed, { db, actor }) =>
    saveService(db, actor, parsed),
  );
}

export async function deleteServiceAction(id: string) {
  return catalogAction("catalog.edit", idSchema, { id }, async (parsed, { db, actor }) => {
    await deleteService(db, actor, parsed.id);
  });
}

export async function saveLocationAction(input: unknown) {
  return catalogAction("catalog.edit", locationInputSchema, input, (parsed, { db, actor }) =>
    saveLocation(db, actor, parsed),
  );
}

export async function deleteLocationAction(id: string) {
  return catalogAction("catalog.edit", idSchema, { id }, async (parsed, { db, actor }) => {
    await deleteLocation(db, actor, parsed.id);
  });
}
