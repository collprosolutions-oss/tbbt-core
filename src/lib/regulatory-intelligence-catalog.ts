/**
 * One researched official-source example for unincorporated Lee County,
 * Florida, Handyman. Retrieved 2026-09-27 from current primary sources.
 *
 * This is a citation, not a license determination and not nationwide coverage.
 */
import type { RegulatoryNoteInput } from "@/lib/regulatory-intelligence";

export const LEE_COUNTY_HANDYMAN_JURISDICTION_CODE = "US-FL-LEE";
export const LEE_COUNTY_HANDYMAN_TRADE_CODE = "HANDYMAN";

export const LEE_COUNTY_CONTRACTOR_LICENSING_URL = "https://www.leegov.com/dcd/ContLic";
export const LEE_COUNTY_ORDINANCE_23_09_URL = "https://www.leegov.com/bocc/Ordinances/23-09.pdf";
export const FLORIDA_STATUTE_489_103_URL =
  "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0400-0499/0489/Sections/0489.103.html";
export const FLORIDA_DBPR_CONSTRUCTION_FAQ_URL = "https://www2.myfloridalicense.com/construction-industry/faqs/";

export const LEE_COUNTY_HANDYMAN_RETRIEVED_AT = new Date("2026-09-27T00:00:00.000Z");
export const LEE_COUNTY_ORDINANCE_23_09_EFFECTIVE_ON = new Date("2023-05-03T00:00:00.000Z");

export const LEE_COUNTY_HANDYMAN_CITATION =
  "Lee County Department of Community Development, Contractor Licensing (https://www.leegov.com/dcd/ContLic), retrieved 2026-09-27. " +
  "Lee County Ordinance No. 23-09, Lee County Construction License Ordinance, adopted 2 May 2023 and filed with the Florida Department of State on 3 May 2023 (https://www.leegov.com/bocc/Ordinances/23-09.pdf). " +
  "Florida Statutes § 489.103(9) (Online Sunshine) (https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0400-0499/0489/Sections/0489.103.html). " +
  "Florida DBPR, Construction Industry FAQs (https://www2.myfloridalicense.com/construction-industry/faqs/).";

export const LEE_COUNTY_HANDYMAN_SUMMARY =
  "Lee County Contractor Licensing administers contractor eligibility in the county and registers state contractor licenses for permitting. " +
  "Ordinance 23-09 applies to contractors performing work in unincorporated Lee County. Section Three states that if the Florida Building Code governs a scope of work and state law requires a license, a State construction license is required, and state law prevails on conflict. " +
  "Section Five lists local license categories that no longer require a local license as of the ordinance effective date, including Finish Carpentry, Painting, Flooring, and Fence Erection; those scopes are not thereby certified as exempt for any specific job. " +
  "Florida Statutes § 489.103(9) exempts casual, minor, or inconsequential work under a $2,500 aggregate contract price from Part I, except when the work is part of a larger operation or the person advertises as a contractor. " +
  "DBPR's official FAQ says to check the local building department and that work requiring a permit typically is not casual, minor, or inconsequential. " +
  "Whether any named business, advertisement, or job is licensed or exempt remains UNKNOWN.";

export function leeCountyHandymanCatalogNote(): RegulatoryNoteInput {
  return {
    jurisdictionCode: LEE_COUNTY_HANDYMAN_JURISDICTION_CODE,
    jurisdictionLabel: "Unincorporated Lee County, Florida",
    tradeCode: LEE_COUNTY_HANDYMAN_TRADE_CODE,
    officialSourceUrl: LEE_COUNTY_CONTRACTOR_LICENSING_URL,
    officialSourceTitle: "Lee County Department of Community Development — Contractor Licensing",
    citation: LEE_COUNTY_HANDYMAN_CITATION,
    retrievedAt: LEE_COUNTY_HANDYMAN_RETRIEVED_AT,
    effectiveOn: LEE_COUNTY_ORDINANCE_23_09_EFFECTIVE_ON,
    expiresOn: null,
    recordedState: "CURRENT",
    summary: LEE_COUNTY_HANDYMAN_SUMMARY,
  };
}

export function catalogNoteMatchesLookup(lookup: {
  jurisdictionCode: string | null;
  tradeCode: string | null;
}): boolean {
  if (!lookup.jurisdictionCode && !lookup.tradeCode) return false;
  if (lookup.jurisdictionCode && lookup.jurisdictionCode !== LEE_COUNTY_HANDYMAN_JURISDICTION_CODE) {
    return false;
  }
  if (lookup.tradeCode && lookup.tradeCode !== LEE_COUNTY_HANDYMAN_TRADE_CODE) {
    return false;
  }
  return true;
}
