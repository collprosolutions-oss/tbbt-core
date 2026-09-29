import type { EquipmentKind } from "@/lib/equipment/constants";

export type EquipmentPurchaseChoice = {
  id: string;
  description: string;
  category: string;
  occurredOn: string;
};

export type EquipmentMaintenanceView = {
  id: string;
  occurredOn: string;
  notes: string;
};

export type EquipmentItemView = {
  id: string;
  kind: EquipmentKind;
  kindLabel: string;
  name: string;
  notes: string;
  serviceOn: string | null;
  due: boolean;
  purchaseExpense: EquipmentPurchaseChoice | null;
  maintenance: EquipmentMaintenanceView[];
  maintenanceOverflow: boolean;
};

export type EquipmentWorkspace = {
  available: boolean;
  canWrite: boolean;
  timeZone: string;
  readLimit: number;
  maintenanceReadLimit: number;
  purchaseChoiceLimit: number;
  items: EquipmentItemView[];
  dueItems: EquipmentItemView[];
  overflow: boolean;
  dueOverflow: boolean;
  purchaseChoices: EquipmentPurchaseChoice[];
  purchaseChoiceOverflow: boolean;
  limitsMessage: string;
  dueMessage: string;
  ownerOnlyMessage: string;
  fieldScopedMessage: string;
  purchaseMessage: string;
  overflowMessage: string;
};
