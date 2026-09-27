"use server";

import { revalidatePath } from "next/cache";
import { requireBusinessAccess } from "@/lib/access";
import { BSOS_NETWORK_PATH } from "@/lib/bsos-network";
import {
  bsosNetworkErrorMessage,
  optBusinessIntoNetwork,
  optBusinessOutOfNetwork,
} from "@/lib/bsos-network-ops";
import { prisma } from "@/lib/prisma";

export type NetworkActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function revalidateNetwork() {
  revalidatePath(BSOS_NETWORK_PATH);
}

export async function optIntoBsosNetworkAction(
  _prev: NetworkActionState,
  formData: FormData,
): Promise<NetworkActionState> {
  try {
    const access = await requireBusinessAccess();
    await optBusinessIntoNetwork(prisma, access, {
      publicName: readString(formData, "publicName"),
      tradeCode: readString(formData, "tradeCode"),
      serviceAreaLabel: readString(formData, "serviceAreaLabel"),
      publicContactMethod: readString(formData, "publicContactMethod"),
      publicContactValue: readString(formData, "publicContactValue"),
    });
    revalidateNetwork();
    return { message: "This business is now listed with only the public details you approved." };
  } catch (error) {
    return { error: bsosNetworkErrorMessage(error, "That network listing could not be saved.") };
  }
}

export async function optOutOfBsosNetworkAction(
  _prev: NetworkActionState,
  _formData: FormData,
): Promise<NetworkActionState> {
  try {
    const access = await requireBusinessAccess();
    await optBusinessOutOfNetwork(prisma, access);
    revalidateNetwork();
    return { message: "This business is no longer listed. Other businesses cannot see it." };
  } catch (error) {
    return { error: bsosNetworkErrorMessage(error, "That network listing could not be updated.") };
  }
}
