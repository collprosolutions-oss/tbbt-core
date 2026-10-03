/** iOS-only field-app helpers. Keep this file free of react-native so Node proofs can import it. */

import { NATIVE_APP_VERSION } from "./android";

export const NATIVE_IOS_BUNDLE_IDENTIFIER = "com.tbbt.field";
export const NATIVE_IOS_BUILD_NUMBER = "1";
export const NATIVE_PREVIEW_API_ORIGIN = "https://www.collproreno.com";

export function nativeIosBuildStampLabel(
  version = NATIVE_APP_VERSION,
  buildNumber = NATIVE_IOS_BUILD_NUMBER,
) {
  return `TBBT Field ${version} (${buildNumber})`;
}

export function isReachablePreviewApiOrigin(url: string) {
  const trimmed = url.trim().replace(/\/$/, "");
  return trimmed === NATIVE_PREVIEW_API_ORIGIN;
}

export function easConfigIncludesAppleCredentials(value: unknown) {
  const text = JSON.stringify(value);
  return /appleId|ascAppId|appleTeamId|ASC_API_KEY|APPLE_ID|AuthKey_|provisioningProfile/i.test(
    text,
  );
}

export function parseGeneratedIosProject(pbxproj: string) {
  const bundleId = firstAssignment(pbxproj, "PRODUCT_BUNDLE_IDENTIFIER");
  const projectVersion = firstAssignment(pbxproj, "CURRENT_PROJECT_VERSION");
  const marketingVersion = firstAssignment(pbxproj, "MARKETING_VERSION");
  const developmentTeams = [
    ...pbxproj.matchAll(/DEVELOPMENT_TEAM = ([^;]+);/g),
  ].map((match) => match[1].replace(/"/g, "").trim()).filter(Boolean);
  return {
    bundleId,
    projectVersion,
    marketingVersion,
    developmentTeams,
  };
}

function firstAssignment(source: string, key: string) {
  const match = source.match(new RegExp(`${key} = ([^;]+);`));
  return match?.[1]?.replace(/"/g, "").trim() ?? "";
}
