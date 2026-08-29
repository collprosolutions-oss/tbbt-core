-- AlterTable
ALTER TABLE "ServiceCatalogItem" ADD COLUMN     "category" TEXT NOT NULL DEFAULT 'Other Services';

-- Deterministic backfill for existing rows, generated from the single
-- source of truth in src/lib/handyman-starter-catalog.ts
-- (HANDYMAN_STARTER_SERVICES). This mirrors the exact name -> category
-- mapping the application already used to derive each service's displayed
-- category (see the pre-existing starterCategoryForName() /
-- groupServicesByStarterCategory() helpers), so every existing Handyman
-- starter-catalog row keeps the same category it already displays under.
--
-- Matching is case-insensitive and trims outer whitespace to mirror the
-- app's existing catalogNameKey() comparison. Any row whose name does not
-- match one of these known starter names (i.e. a business's own
-- custom/unmapped service) keeps the 'Other Services' default set above --
-- the same fallback the application's existing OTHER_SERVICES_CATEGORY
-- constant already used for unmatched names. No row is deleted, and no
-- price/pricingMode/active/description value is touched by this migration.
UPDATE "ServiceCatalogItem" AS sci
SET "category" = mapping.category
FROM (VALUES
  ('Standard Door Knob Replacement', 'Doors & Locks'),
  ('Deadbolt Replacement', 'Doors & Locks'),
  ('Door Knob + Deadbolt Set', 'Doors & Locks'),
  ('Keypad / Electronic Deadbolt Replacement', 'Doors & Locks'),
  ('Interior Door Adjustment', 'Doors & Locks'),
  ('Exterior Door Adjustment', 'Doors & Locks'),
  ('Interior Door Replacement', 'Doors & Locks'),
  ('Door Closer Installation / Adjustment', 'Doors & Locks'),
  ('TV Mounting Up to 55 Inches', 'Mounting & Hanging'),
  ('TV Mounting 56–75 Inches', 'Mounting & Hanging'),
  ('TV Mounting 76+ Inches', 'Mounting & Hanging'),
  ('Curtain Rod Installation', 'Mounting & Hanging'),
  ('Blind / Shade Installation', 'Mounting & Hanging'),
  ('Large Mirror Mounting', 'Mounting & Hanging'),
  ('Shelving Installation', 'Mounting & Hanging'),
  ('Picture / Art Hanging', 'Mounting & Hanging'),
  ('Wall-Mounted Accessory', 'Mounting & Hanging'),
  ('Small Drywall Patch Up to Approx. 6 Inches', 'Walls & Drywall'),
  ('Medium Drywall Repair', 'Walls & Drywall'),
  ('Large Drywall Repair', 'Walls & Drywall'),
  ('Minor Wall / Ceiling Crack Repair', 'Walls & Drywall'),
  ('Small Hole / Anchor Repairs', 'Walls & Drywall'),
  ('Baseboard / Trim Repair', 'Trim & Carpentry'),
  ('Small Wood Repair', 'Trim & Carpentry'),
  ('Closet Shelf / Rod Repair', 'Trim & Carpentry'),
  ('Closet Shelf / Rod Installation', 'Trim & Carpentry'),
  ('Minor Molding Repair', 'Trim & Carpentry'),
  ('Decorative Wall Paneling & Finish Carpentry', 'Trim & Carpentry'),
  ('Interior Trim & Finish Carpentry', 'Trim & Carpentry'),
  ('Tub / Shower Recaulk', 'Bathroom / Caulking / Accessories'),
  ('Sink / Countertop Recaulk', 'Bathroom / Caulking / Accessories'),
  ('Toilet Paper Holder / Towel Bar Installation', 'Bathroom / Caulking / Accessories'),
  ('Bathroom Accessory Set Installation', 'Bathroom / Caulking / Accessories'),
  ('Grab Bar Installation', 'Bathroom / Caulking / Accessories'),
  ('Small Furniture Assembly', 'Furniture & Assembly'),
  ('Medium Furniture Assembly', 'Furniture & Assembly'),
  ('Large / Complex Furniture Assembly', 'Furniture & Assembly'),
  ('Bed Frame Assembly', 'Furniture & Assembly'),
  ('Shelving Unit / Bookcase Assembly', 'Furniture & Assembly'),
  ('Small Window Screen Repair', 'Exterior Repairs'),
  ('Window Screen Replacement / Re-screen', 'Exterior Repairs'),
  ('Screen Door Adjustment / Repair', 'Exterior Repairs'),
  ('Exterior Trim Minor Repair', 'Exterior Repairs'),
  ('Minor Wood Rot Repair', 'Exterior Repairs'),
  ('Fence / Gate Adjustment', 'Exterior Repairs'),
  ('Fence / Gate Minor Repair', 'Exterior Repairs'),
  ('Mailbox Replacement', 'Exterior Repairs'),
  ('House Number Installation', 'Exterior Repairs'),
  ('Cabinet Door / Hinge Adjustment', 'Cabinets / Kitchen'),
  ('Cabinet Handle / Pull Installation', 'Cabinets / Kitchen'),
  ('Cabinet Door Repair', 'Cabinets / Kitchen'),
  ('Minor Cabinet Repair', 'Cabinets / Kitchen'),
  ('Under-Sink Shelf / Base Minor Repair', 'Cabinets / Kitchen'),
  ('Ceiling Fan Replacement', 'Fans & Fixtures'),
  ('Standard Light Fixture Replacement', 'Fans & Fixtures'),
  ('Bathroom Vanity Light Replacement', 'Fans & Fixtures'),
  ('Smoke / CO Detector Replacement', 'Fans & Fixtures'),
  ('Doorbell Replacement Using Existing Wiring', 'Fans & Fixtures'),
  ('Video Doorbell Installation Using Existing Wiring', 'Fans & Fixtures'),
  ('Punch List / Multiple Small Repairs', 'Punch Lists / Small Jobs'),
  ('Minor Hardware Replacement', 'General Home Repairs'),
  ('Weatherstripping Replacement', 'General Home Repairs'),
  ('Minor Adjustment / Repair Visit', 'General Home Repairs')
) AS mapping(name, category)
WHERE lower(btrim(sci.name)) = lower(btrim(mapping.name));
