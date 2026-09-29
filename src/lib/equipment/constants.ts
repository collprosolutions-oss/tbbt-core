/**
 * Trade-neutral OWNER equipment register for tools and vehicles.
 *
 * Inspected Materials vs Expenses first:
 * - MaterialCatalogItem / purchase lists are consumable job materials.
 * - Expense already has TOOLS_EQUIPMENT and VEHICLE spend categories.
 * This register records durable owned items. An optional purchase
 * reference may point at a same-business Expense in the matching
 * category. It is not inventory stock, telemetry, depreciation, tax
 * treatment, or an automated reminder engine.
 */

export const EQUIPMENT_ROUTE = "/equipment";
export const EQUIPMENT_MIGRATION_NAME = "20260929010000_owner_equipment_register";
export const EQUIPMENT_SCHEMA_SOURCE = "prisma-migrate";

export const EQUIPMENT_KINDS = ["TOOL", "VEHICLE"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];

export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = {
  TOOL: "Tool",
  VEHICLE: "Vehicle",
};

/** Expense categories that may back a purchase reference, by kind. */
export const EQUIPMENT_PURCHASE_CATEGORIES = {
  TOOL: "TOOLS_EQUIPMENT",
  VEHICLE: "VEHICLE",
} as const;

export const MAX_EQUIPMENT_NAME_LENGTH = 80;
export const MAX_EQUIPMENT_NOTES_LENGTH = 500;
export const MAX_MAINTENANCE_NOTES_LENGTH = 500;
export const MAX_ATTEMPT_KEY_LENGTH = 128;

/** Hard cap for register, due, purchase-choice, and maintenance reads. */
export const EQUIPMENT_READ_LIMIT = 50;
export const EQUIPMENT_MAINTENANCE_READ_LIMIT = 20;
export const EQUIPMENT_PURCHASE_CHOICE_LIMIT = 50;

export const EQUIPMENT_LIMITS_MESSAGE =
  "This is a private owner register of tools and vehicles for this business. It is not inventory stock, not telemetry, not depreciation, not tax treatment, and not an automated reminder.";

export const EQUIPMENT_DUE_MESSAGE =
  "Due items come only from a service date the owner recorded. TBBT does not invent the next service from mileage, hours, intervals, or maintenance history.";

export const EQUIPMENT_OWNER_ONLY_MESSAGE =
  "Only the owner can record equipment or maintenance. Admins can read the register.";

export const EQUIPMENT_FIELD_SCOPED_MESSAGE =
  "Equipment is an owner register. Field members stay on assigned jobs.";

export const EQUIPMENT_OVERFLOW_MESSAGE =
  "This list is capped. More matching records may exist in this business.";

export const EQUIPMENT_PURCHASE_MESSAGE =
  "A purchase reference is optional. It may link one same-business Tools & Equipment or Vehicle expense that matches this item's kind. Materials catalog rows and job purchase lists are not stock for this register.";

export const EQUIPMENT_UNAVAILABLE_MESSAGE =
  "Equipment is unavailable on this environment until the equipment register migration is applied. Opening the page does not create the table.";

export const FORBIDDEN_EQUIPMENT_CLAIM_PATTERNS = [
  /live telemetry/i,
  /depreciation schedule/i,
  /tax treatment/i,
  /inventory stock/i,
  /automatic reminder/i,
] as const;
