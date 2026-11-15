import { z } from "zod";

export const STAFF_ROLES = ["owner", "manager", "stylist", "reception"] as const;

export const ROLE_LABELS: Record<(typeof STAFF_ROLES)[number], string> = {
  owner: "Owner",
  manager: "Manager",
  stylist: "Stylist",
  reception: "Reception",
};

/** One line saying what each role may do, shown beside the role picker. */
export const ROLE_HINTS: Record<(typeof STAFF_ROLES)[number], string> = {
  owner: "Everything, including settings, integrations and refunds.",
  manager: "Runs the day: all calendars, roster, catalog, reports and the team. No settings or money.",
  stylist: "Their own calendar, clients, roster, timesheet and numbers.",
  reception: "Books and checks out for everyone, manages the waitlist. No reports.",
};

const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** What the add / edit form submits. Email is lower-cased so uniqueness is case-insensitive. */
export const staffInputSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120, "Keep the name under 120 characters"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Enter their Google email")
    .max(254, "That email is too long")
    .email("Enter a valid email address"),
  phone: z.string().trim().max(40, "That phone number is too long").default(""),
  role: z.enum(STAFF_ROLES),
  level: z.number().int("Level is a whole number").min(0, "Level can't be negative").max(20),
  colour: z
    .string()
    .trim()
    .refine((v) => v === "" || HEX_COLOUR.test(v), "Pick a colour")
    .default(""),
});

export type StaffInput = z.output<typeof staffInputSchema>;
export type StaffFormInput = z.input<typeof staffInputSchema>;

export const staffIdSchema = z.object({ id: z.uuid("Unknown team member") });

export const staffActiveSchema = staffIdSchema.extend({ active: z.boolean() });
