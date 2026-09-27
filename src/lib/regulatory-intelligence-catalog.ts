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
  "Lee County Contractor Licensing oversees contractor eligibility and compliance within the county by verifying contractor licenses, insurance, and authorized signer information, and manages contractor registration for permitting. " +
  "Ordinance 23-09 Section Three: this ordinance applies to contractors performing work or contracting to perform work within unincorporated Lee County. " +
  "Regarding Section Five, if the Florida Building Code governs a scope of work and state law requires a license for that scope of work, a construction license issued by the State is required. In the event of a conflict between this ordinance and state law, Section Three says state law prevails. " +
  "Section Five lists Lee County local license categories for which a local license is no longer required as of the ordinance effective date, including Finish Carpentry Contractor, Painting Contractor, Flooring, and Fence Erection Contractor. That list is not a determination that any specific job, person, or business is exempt, licensed, or compliant. " +
  "Florida Statutes § 489.103 states that this part does not apply to the listed exemptions. Subsection (9) covers any work or operation of a casual, minor, or inconsequential nature in which the aggregate contract price for labor, materials, and all other items is less than $2,500. " +
  "That exemption does not apply if the construction, repair, remodeling, or improvement is a part of a larger or major operation, whether undertaken by the same or a different contractor, or in which a division of the operation is made in contracts of amounts less than $2,500 for the purpose of evading this part or otherwise. " +
  "It also does not apply to a person who advertises that he or she is a contractor or otherwise represents that he or she is qualified to engage in contracting. " +
  "The Florida DBPR Construction Industry FAQ is not the statute. The FAQ says that as of July 1, 2020, handyman jobs where the total construction costs are below $2,500 are exempt from State licensure requirements when the jobs are of a casual, minor, or inconsequential nature; to check with the building department whether the jobs so qualify and whether there are any local licensing requirements; and that typically, work requiring a permit is not of a casual, minor, or inconsequential nature. " +
  "Whether any named business, advertisement, or job is licensed, exempt, or legally compliant remains UNKNOWN.";

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
