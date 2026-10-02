import { isEsignProviderConfigured, isFakeEsignAdapterEnabled } from "@/lib/esign/config";
import { createDropboxSignEsignProvider } from "@/lib/esign/dropbox-sign";
import { getSharedFakeEsignProvider, type FakeEsignProvider } from "@/lib/esign/fake";
import { EsignProviderError, type EsignProvider } from "@/lib/esign/types";

let cached: EsignProvider | null | undefined;

export function getEsignProvider(): EsignProvider | null {
  if (cached !== undefined) return cached;
  if (!isEsignProviderConfigured()) {
    cached = null;
    return cached;
  }
  cached = isFakeEsignAdapterEnabled()
    ? getSharedFakeEsignProvider()
    : createDropboxSignEsignProvider();
  return cached;
}

export function requireEsignProvider(): EsignProvider {
  const provider = getEsignProvider();
  if (!provider) {
    throw new EsignProviderError(
      "No e-sign provider is connected. TBBT will not invent a digital signature.",
    );
  }
  return provider;
}

/** Local/script fake adapter only. Null when Dropbox Sign is the live provider. */
export function getFakeEsignProvider(): FakeEsignProvider | null {
  if (!isFakeEsignAdapterEnabled()) return null;
  return getEsignProvider() as FakeEsignProvider;
}

export function resetEsignProviderCache() {
  cached = undefined;
}
