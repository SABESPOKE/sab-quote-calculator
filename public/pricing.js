// ───────────────────────────────────────────────────────────────────────────────────
// pricing.js — SINGLE SOURCE OF TRUTH for the SAB quote pricing engine.
//
// Loaded two ways:
//   • Browser: <script src="/pricing.js"> in index.html, BEFORE the React/Babel block
//     — defines DB + all calc* + priceItem as page globals for the React app.
//   • Server: require("./public/pricing.js") in server.js — to recompute item pricing
//     on read (GET /api/quotes) so updated figures (e.g. labour hours) appear without
//     anyone re-saving the quote.
//
// MUST stay free of React/DOM references. The only browser-only bit (the localStorage
// settings merge below) is already inside a try/catch, so Node loads this file unchanged
// and simply prices with the canonical defaults.
// ───────────────────────────────────────────────────────────────────────────────────
// ─── PRICING DATABASE ──────────────────────────────────────────────────────────
const DB = {
  settings: {
    labourRate: 30,         // £/hr direct labour
    overheadRate: 37,       // £/hr overhead absorption (shop costs per labour hour)
    margin: 2.0,            // sell price multiplier on manufacturing cost
    vat: 0.20,
    designRoundsPerRoom: 2,     // number of design iterations per room
    designHoursPerRound: 8,     // hours per design round (1 working day)
    technicalDrawingDays: 2,    // days to produce technical drawings
    workingHoursPerDay: 8,
    designHourlyRate: 50,       // £/hr billed to client for design time
    // ── Carcass assembly labour (adjustable) ──────────────────────────────────
    carcassBaseHrs: 1,          // hrs for reference 600×720×560 cabinet
    carcassShelfHrs: 0,         // additional hrs per shelf fitted
    carcassDrawerPrepHrs: 0.5,  // additional hrs when any drawers are present
    // ── Project-level cost defaults (all adjustable) ──────────────────────────
    surveyFee: 250,             // £ flat — site survey visit (per project)
    installDayRate: 350,        // £/day — billed PER FITTER per day on site
    fittingHoursPerPersonPerDay: 7.5,  // effective fitting hours per fitter per day (8h - 0.5h clean-down)
    deliveryFee: 200,           // £ flat — delivery & transport (per project)
    pmPercent: 6,               // % of mfg sell ex VAT — project management
    consumablesPerItem: 60,     // £ per line item — fixings, glue, edge tape, abrasives
    contingencyPercent: 7.5,    // % uplift on project subtotal (optional)
    warrantyPercent: 1.5,       // % of total ex VAT — warranty & aftercare allowance (optional)
    // ── WRP Mouldings ─────────────────────────────────────────────────────────
    wrpMouldingMarkupPct: 35,        // default markup % for WRP mouldings (editable per-line)
    wrpMouldingGirthMultiplier: 1.2, // (w+h) × this = estimated painted girth per metre
    wrpMouldingDefaultFinish: "paint", // default finish for new WRP items: paint|lacquer|stain_lacquer|none
    // ── Spray finishing — in-house booth, area-based ──────────────────────────
    // PAINT = opaque (primer + topcoats). LACQUER = clear (2 coats, no primer).
    // STAIN = pre-treatment before lacquer. Sanding between every coat except final.
    sprayFinish: {
      // Booth & technician
      techLabourRate:   25,   // £/hr — spray tech (lower than bench rate)
      boothCostPerHr:    5,   // £/hr — electricity, extraction, depreciation
      setupMinsPerDoor:  5,   // mins per door: hanging, masking, repositioning
      doorThicknessMm:  19,   // thickness used to calculate edge area (standard MDF door)

      // Prep — sanding between coats (applied between every coat except the final)
      sandFaceHrsPerM2:  0.05,  // hrs per m² — random orbital on flat faces (primer-grade prep)
      sandEdgeHrsPerM:   0.05,  // hrs per linear metre — careful sanding of 4 edges
      sandQuirkHrsPerM:  0.08,  // hrs per linear metre — into shaker groove (hardest access)

      // Edge polish (no spray) — hand-sanded + hand-applied wax/oil on visible edges only
      // Used by finishType "edge_polish" — bypasses booth entirely, just bench labour + tiny material
      edgePolish: {
        applyHrsPerM: 0.04,    // hrs per linear metre — wipe/buff wax or oil
        materialCostPerM: 0.20,// £ per linear metre — wax/oil consumable
      },

      // Prep — caulking (shaker & framed-inset only, applied ONCE before priming)
      // Fills the quirk groove for a gap-free surface. Includes: apply, dry, sand flat.
      caulkHrsPerM:    0.13,   // hrs per linear metre of quirk groove (~8 min/m, production rate)
      caulkCostPerM:   0.50,   // £ per linear metre — flexible sealant material

      // Paint finish — opaque (primer seals + colour topcoats)
      paint: {
        primerCoats:            1,
        primerSprayHrsPerM2:    0.12,  // face spray time per coat
        primerEdgeHrsPerM:      0.04,  // edge spray per coat
        primerQuirkHrsPerM:     0.03,  // quirk spray per coat
        primerCostPerLitre:     8,     // £/litre — e.g. Zinsser, Tikkurila Otex
        primerCoverageM2PerL:   12,

        topCoats:               2,     // reduce to 1 for budget option
        topCoatSprayHrsPerM2:   0.21,  // ~75% slower than primer — careful application
        topCoatEdgeHrsPerM:     0.07,
        topCoatQuirkHrsPerM:    0.053,
        topCoatCostPerLitre:    14,    // £/litre — e.g. Teknos, Tikkurila water-based
        topCoatCoverageM2PerL:  10,
        topCoatReworkFactor:    1.33,  // 1.33× buffer on topcoat labour + material (rework allowance)
        topCoatSandFaceHrsPerM2: 0.08, // finer-grit sand between topcoats (vs lighter primer-prep above)
      },

      // Lacquer finish — clear (2 coats, no primer, sanding between)
      lacquer: {
        coats:              2,
        sprayHrsPerM2:      0.10,   // slightly faster than paint (thinner application)
        edgeHrsPerM:        0.035,
        quirkHrsPerM:       0.025,
        costPerLitre:       16,     // clear lacquer costs more than topcoat
        coverageM2PerL:     10,
      },

      // Stain — optional pre-treatment before lacquer (brush/wipe applied)
      stain: {
        applyHrsPerM2:      0.15,  // brush/wipe is slower than spray
        edgeHrsPerM:        0.05,
        quirkHrsPerM:       0.06,  // careful application into groove
        costPerLitre:       12,
        coverageM2PerL:     15,    // stains are thin, go further
      },
    },
  },
  materials: {
    // naturalFinish drives the default carcass spray treatment when the material is picked.
    //   'none'    — prefinished, melamine, or face-finished boards: no spray needed
    //   'lacquer' — raw veneers (oak/walnut/maple/birch ply UNF, Douglas Fir): seal with clear lacquer
    //   'paint'   — paint-grade MDF: prime + topcoat
    "MAT_DF_PLY_18":        { name: "Douglas Fir Plywood 18mm",            costPerM2: 62.15, thicknessMm: 18, wasteFactor: 1.15, naturalFinish: "lacquer" },
    "MAT_BIRCH_UNF_18":     { name: "Birch Plywood Unfinished 18mm",       costPerM2: 33.59, thicknessMm: 18, wasteFactor: 1.15, naturalFinish: "lacquer" },
    "MAT_BIRCH_PREF_18":    { name: "Birch Plywood Prefinished 18mm",      costPerM2: 40.31, thicknessMm: 18, wasteFactor: 1.15, naturalFinish: "none" },
    "MAT_OAK_MDF_UNF_19":   { name: "Oak Veneered MDF Unfinished 19mm",   costPerM2: 26.87, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "lacquer" },
    "MAT_OAK_MDF_PREF_19":  { name: "Oak Veneered MDF Prefinished 19mm",  costPerM2: 33.59, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "none" },
    "MAT_WAL_MDF_UNF_19":   { name: "Walnut Veneered MDF Unfinished 19mm",costPerM2: 40.31, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "lacquer" },
    "MAT_WAL_MDF_PREF_19":  { name: "Walnut Veneered MDF Prefinished 19mm",costPerM2: 47.03, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "none" },
    "MAT_MAPLE_MDF_UNF_19": { name: "Maple Veneered MDF Unfinished 19mm", costPerM2: 30.23, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "lacquer" },
    "MAT_MDF_FH_18":        { name: "Finsa Hydrofuga MDF 18mm",            costPerM2: 16.80, thicknessMm: 18, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_MDF_FH_22":        { name: "Finsa Hydrofuga MDF 22mm",            costPerM2: 20.16, thicknessMm: 22, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_MDF_FH_6":  { name: "Finsa Hydrofuga MDF 6mm",  costPerM2:  5.60, thicknessMm:  6, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_MDF_FH_9":  { name: "Finsa Hydrofuga MDF 9mm",  costPerM2:  8.40, thicknessMm:  9, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_MDF_FH_12": { name: "Finsa Hydrofuga MDF 12mm", costPerM2: 11.20, thicknessMm: 12, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_MDF_FH_15": { name: "Finsa Hydrofuga MDF 15mm", costPerM2: 14.00, thicknessMm: 15, wasteFactor: 1.12, naturalFinish: "paint" },
    "MAT_BACK_HDF_6":       { name: "HDF Back Panel 6mm",                  costPerM2:  8.50, thicknessMm:  6, wasteFactor: 1.10, naturalFinish: "none" },
    "MAT_MEL_EGGER_18":     { name: "Melamine - Egger 18mm",               costPerM2: 22.00, thicknessMm: 18, wasteFactor: 1.12, naturalFinish: "none" },
    "MAT_MEL_EGGER_25":     { name: "Melamine - Egger 25mm",               costPerM2: 28.00, thicknessMm: 25, wasteFactor: 1.12, naturalFinish: "none" },
    "MAT_SHINNOKI_19":      { name: "Shinnoki Board 19mm",                 costPerM2: 55.00, thicknessMm: 19, wasteFactor: 1.12, naturalFinish: "none" },
    "MAT_BACK_PLY_9":       { name: "Back Panel Ply 9mm",                  costPerM2: 12.00, thicknessMm:  9, wasteFactor: 1.10, naturalFinish: "lacquer" },
  },
  // Door types: substrate + applied-material costs per m². Spray finishing calculated separately by area.
  // finishCostPerM2 = veneer / specialist material only; painted types = 0 (spray function handles paint materials)
  // hasQuirk = true for profiled doors where the groove/rebate adds spray time (shaker, framed)
  // shakerStileWidthMm = width of the frame member (used to calculate inner quirk perimeter)
  doorTypes: {
    "SLAB_PNT":      { name: "Slab – Painted",         baseCostPerM2: 20, finishCostPerM2:  0, extraLabourPerM2: 0.40, baseLabourHrs: 0.35, hasQuirk: false, shakerStileWidthMm: 0,   finishType: "paint"   },
    "SLAB_VEN":      { name: "Slab – Veneered",        baseCostPerM2: 20, finishCostPerM2: 30, extraLabourPerM2: 0.60, baseLabourHrs: 0.50, hasQuirk: false, shakerStileWidthMm: 0,   finishType: "lacquer" },
    "SLAB_CUST_VEN": { name: "Slab – Custom Veneer",   baseCostPerM2: 20, finishCostPerM2: 55, extraLabourPerM2: 1.00, baseLabourHrs: 0.60, hasQuirk: false, shakerStileWidthMm: 0,   finishType: "lacquer" },
    "SHAKER_PNT":    { name: "Shaker – Painted",       baseCostPerM2: 26, finishCostPerM2:  0, extraLabourPerM2: 0.50, baseLabourHrs: 0.50, hasQuirk: true,  shakerStileWidthMm: 70,  finishType: "paint"   },
    "SHAKER_VEN":    { name: "Shaker – Veneered",      baseCostPerM2: 26, finishCostPerM2: 30, extraLabourPerM2: 0.70, baseLabourHrs: 0.60, hasQuirk: true,  shakerStileWidthMm: 70,  finishType: "lacquer" },
    "J_GROOVE":      { name: "Slab – J-Groove Handle", baseCostPerM2: 22, finishCostPerM2:  0, extraLabourPerM2: 0.50, baseLabourHrs: 0.35, hasQuirk: false, shakerStileWidthMm: 0,   finishType: "paint"   },
    "FRAMED_INSET":  { name: "Framed – Inset",         baseCostPerM2: 40, finishCostPerM2:  0, extraLabourPerM2: 1.00, baseLabourHrs: 1.00, hasQuirk: true,  shakerStileWidthMm: 80,  finishType: "paint"   },
    // Solid timber shaker: solid timber frame (cope-and-stick) + finish-matching MDF panel.
    // Pricing is volume-based on the frame + area-based on the panel, not the existing m² baseCost.
    // baseCostPerM2/finishCostPerM2 are kept here as ignored fields so the spec UI / spray fn
    // can still read shakerStileWidthMm and hasQuirk.
    "SHAKER_TIM_PNT":{ name: "Shaker – Solid Timber, Painted",   baseCostPerM2: 0,  finishCostPerM2: 0, extraLabourPerM2: 0.70, baseLabourHrs: 1.50, hasQuirk: true, shakerStileWidthMm: 70, finishType: "paint",   pricingMode: "timber_frame_mdf_panel" },
    "SHAKER_TIM_LAC":{ name: "Shaker – Solid Timber, Lacquered", baseCostPerM2: 0,  finishCostPerM2: 0, extraLabourPerM2: 0.70, baseLabourHrs: 1.50, hasQuirk: true, shakerStileWidthMm: 70, finishType: "lacquer", pricingMode: "timber_frame_mdf_panel" },
    "SHAKER_TIM_OIL":{ name: "Shaker – Solid Timber, Oiled",     baseCostPerM2: 0,  finishCostPerM2: 0, extraLabourPerM2: 0.70, baseLabourHrs: 1.50, hasQuirk: true, shakerStileWidthMm: 70, finishType: "oil",     pricingMode: "timber_frame_mdf_panel" },
  },
  solidTimber: {
    "TIM_OAK":   { name: "European Oak",        effectivePerM3: 3220 },
    "TIM_TUL":   { name: "Tulipwood / Poplar",  effectivePerM3: 1320 },
    "TIM_MAPLE": { name: "Hard Maple",          effectivePerM3: 2912 },
    "TIM_WAL":   { name: "American Walnut",     effectivePerM3: 4600 },
    "TIM_ASH":   { name: "European Ash",        effectivePerM3: 2100 },
  },
  drawerTypes: {
    "DRW_SHEET":     { name: "Sheet Material Box (matches carcass)", materialCostPer: 0, labourHrs: 0.3, usesCarcassMaterial: true },
    "DRW_BIRCH_PLY": { name: "Birch Ply Box",    materialCostPer: 25, labourHrs: 0.5 },
    "DRW_SOLID_OAK": { name: "Solid Oak Box",    materialCostPer: 60, labourHrs: 4.0 },
    "DRW_SOLID_TUL": { name: "Solid Tulip Box",  materialCostPer: 35, labourHrs: 4.0 },
    "DRW_SOLID_WAL": { name: "Solid Walnut Box", materialCostPer: 90, labourHrs: 4.0 },
  },
  hardware: {
    hinges: {
      "HW_HINGE_NONE":  { name: "No Hinge",                     costEach: 0 },
      "HW_HINGE_STD":   { name: "Blum Clip-top standard",       costEach: 6.50 },
      "HW_HINGE_SM":    { name: "Blum Clip-top soft-close",     costEach: 9.50 },
      "HW_HINGE_INTEG": { name: "Blum Clip-top Blumotion",      costEach: 12.00 },
      "HW_HINGE_BUTT":  { name: "Butt Hinge Pair (2.5\")",       costEach: 2.80 },
    },
    runners: {
      "HW_RUN_BLUM_SM":  { name: "Blum Movento soft-close (pair)",    costPair: 40.00 },
    },
    handles: {
      "HW_HDL_NONE":   { name: "No handle",          costEach: 0 },
      "HW_HDL_KNOB":   { name: "Knob",               costEach: 8.00 },
      "HW_HDL_BAR128": { name: "Bar handle 128mm",   costEach: 12.00 },
      "HW_HDL_BAR192": { name: "Bar handle 192mm",   costEach: 16.00 },
      "HW_HDL_BAR256": { name: "Bar handle 256mm",   costEach: 20.00 },
      "HW_HDL_FLUSH":  { name: "Flush pull",         costEach: 18.00 },
    },
  },
  mouldings: {
    // Prices per linear metre — supply only (fixing labour charged separately via labourHrsPerM)
    // Based on current UK merchant/trade pricing March 2026
    "MLD_SKR_MDF_95":   { name:"MDF Skirting 95mm",         costPerM: 3.50,  labourHrsPerM: 0.12, category:"Skirting"   },
    "MLD_SKR_MDF_145":  { name:"MDF Skirting 145mm",        costPerM: 4.80,  labourHrsPerM: 0.12, category:"Skirting"   },
    "MLD_SKR_OAK_95":   { name:"Solid Oak Skirting 95mm",   costPerM:12.00,  labourHrsPerM: 0.18, category:"Skirting"   },
    "MLD_SKR_OAK_145":  { name:"Solid Oak Skirting 145mm",  costPerM:17.00,  labourHrsPerM: 0.18, category:"Skirting"   },
    "MLD_ARCH_MDF_69":  { name:"MDF Architrave 69mm",       costPerM: 2.80,  labourHrsPerM: 0.10, category:"Architrave" },
    "MLD_ARCH_MDF_95":  { name:"MDF Architrave 95mm",       costPerM: 3.50,  labourHrsPerM: 0.10, category:"Architrave" },
    "MLD_ARCH_OAK_69":  { name:"Solid Oak Architrave 69mm", costPerM: 9.00,  labourHrsPerM: 0.15, category:"Architrave" },
    "MLD_CORN_MDF_100": { name:"MDF Cornice 100mm",         costPerM: 7.00,  labourHrsPerM: 0.20, category:"Cornice"    },
    "MLD_CORN_MDF_150": { name:"MDF Cornice 150mm",         costPerM: 9.50,  labourHrsPerM: 0.22, category:"Cornice"    },
    "MLD_CORN_OAK_100": { name:"Solid Oak Cornice 100mm",   costPerM:21.00,  labourHrsPerM: 0.26, category:"Cornice"    },
    "MLD_PLMT_MDF_150": { name:"MDF Pelmet 150mm",          costPerM: 8.50,  labourHrsPerM: 0.18, category:"Pelmet"     },
    "MLD_PLMT_OAK_150": { name:"Solid Oak Pelmet 150mm",    costPerM:22.00,  labourHrsPerM: 0.22, category:"Pelmet"     },
    "MLD_BEAD_MDF_18":  { name:"MDF Ogee Beading 18mm",     costPerM: 2.20,  labourHrsPerM: 0.08, category:"Beading"    },
    "MLD_BEAD_OAK_18":  { name:"Solid Oak Beading 18mm",    costPerM: 5.50,  labourHrsPerM: 0.10, category:"Beading"    },
    "MLD_TG_MDF":       { name:"MDF T&G Cladding",          costPerM: 7.50,  labourHrsPerM: 0.20, category:"Cladding"   },
    "MLD_TG_OAK":       { name:"Solid Oak T&G Cladding",    costPerM:24.00,  labourHrsPerM: 0.26, category:"Cladding"   },
  },
  // ─── CABINET TYPE CATALOGUE ─────────────────────────────────────────────────
  // Standard UK bespoke cabinet types with default dimensions.
  // All dimensions are fully adjustable — these are SAB starting points.
  cabinetTypes: {
    // ── BASE CABINETS (carcass H=770, D=560 unless noted) ─────────────────────
    "B_STD_1D":     { name:"Base – 1 Door",               w:400,  h:770,  d:560, doors:1, drawers:0, shelves:1, group:"Base" },
    "B_STD_2D":     { name:"Base – 2 Door",               w:600,  h:770,  d:560, doors:2, drawers:0, shelves:1, group:"Base" },
    "B_DRW_DOOR":   { name:"Base – Door & Drawer",        w:600,  h:770,  d:560, doors:2, drawers:1, shelves:0, group:"Base" },
    "B_DRAWER3":    { name:"3-Drawer Stack",              w:500,  h:770,  d:560, doors:0, drawers:3, shelves:0, group:"Base" },
    "B_DRAWER4":    { name:"4-Drawer Stack",              w:600,  h:770,  d:560, doors:0, drawers:4, shelves:0, group:"Base" },
    "B_SINK":       { name:"Sink Base",                   w:1000, h:770,  d:560, doors:2, drawers:0, shelves:0, group:"Base" },
    "B_CORNER_BL":  { name:"Corner Base – Blind",         w:900,  h:770,  d:560, doors:1, drawers:0, shelves:1, group:"Base" },
    "B_CORNER_CAR": { name:"Corner Base – Carousel",      w:900,  h:770,  d:560, doors:2, drawers:0, shelves:2, group:"Base" },
    "B_DW_HSG":     { name:"Dishwasher Housing",          w:600,  h:820,  d:560, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_DW_DOOR":    { name:"Dishwasher – Door Only",      w:600,  h:820,  d:560, doors:1, drawers:0, shelves:0, group:"Base" },
    "B_WM_HSG":     { name:"Washing Machine Housing",     w:600,  h:820,  d:600, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_BIN":        { name:"Bin Pull-Out Cabinet",        w:600,  h:770,  d:560, doors:2, drawers:0, shelves:0, group:"Base" },
    "B_PULLOUT":    { name:"Pull-Out Base Larder",        w:300,  h:770,  d:560, doors:1, drawers:0, shelves:5, group:"Base" },
    "B_WINE":       { name:"Wine Rack Base",              w:300,  h:770,  d:560, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_OPEN":       { name:"Open Base Shelf Unit",        w:600,  h:770,  d:560, doors:0, drawers:0, shelves:2, group:"Base" },
    "B_WIDE":       { name:"Wide Base Cabinet",           w:900,  h:770,  d:560, doors:2, drawers:1, shelves:1, group:"Base" },
    // ── TALL CABINETS (carcass H=2400, D=560 unless noted) ────────────────────
    "T_LARDER":     { name:"Tall Larder Cabinet",         w:600,  h:2400, d:560, doors:2, drawers:0, shelves:5, group:"Tall" },
    "T_LARDER_PO":  { name:"Tall Pull-Out Larder",        w:300,  h:2400, d:560, doors:1, drawers:0, shelves:6, group:"Tall" },
    "T_OVEN_S":     { name:"Single Oven Housing",         w:600,  h:2400, d:560, doors:2, drawers:1, shelves:0, group:"Tall" },
    "T_OVEN_D":     { name:"Double Oven Housing",         w:600,  h:2400, d:560, doors:2, drawers:0, shelves:0, group:"Tall" },
    "T_OVEN_MW":    { name:"Oven & Microwave Tower",      w:600,  h:2400, d:560, doors:3, drawers:1, shelves:0, group:"Tall" },
    "T_FRIDGE":     { name:"Fridge Housing",              w:600,  h:2400, d:580, doors:1, drawers:0, shelves:0, group:"Tall" },
    "T_FF":         { name:"Fridge-Freezer Housing",      w:700,  h:2400, d:580, doors:2, drawers:0, shelves:0, group:"Tall" },
    "T_BROOM":      { name:"Broom / Utility Cupboard",   w:300,  h:2400, d:560, doors:1, drawers:0, shelves:2, group:"Tall" },
    "T_OPEN":       { name:"Open Tall Shelf Unit",        w:600,  h:2400, d:560, doors:0, drawers:0, shelves:5, group:"Tall" },
    "T_DRESSER":    { name:"Dresser Cabinet",             w:1200, h:2400, d:560, doors:4, drawers:3, shelves:4, group:"Tall" },
    "T_CORNER":     { name:"Tall Corner Cabinet",         w:600,  h:2400, d:560, doors:2, drawers:0, shelves:4, group:"Tall" },
    "T_STORE":      { name:"Tall Storage Cabinet",        w:600,  h:2400, d:560, doors:2, drawers:2, shelves:4, group:"Tall" },
    // ── WALL CABINETS (carcass H=1000, D=300 unless noted) ────────────────────
    "W_STD_1D":     { name:"Wall – 1 Door",               w:400,  h:1000, d:300, doors:1, drawers:0, shelves:1, group:"Wall" },
    "W_STD_2D":     { name:"Wall – 2 Door",               w:600,  h:1000, d:300, doors:2, drawers:0, shelves:1, group:"Wall" },
    "W_TALL_1D":    { name:"Wall – 1 Door (900h)",        w:400,  h:900,  d:300, doors:1, drawers:0, shelves:2, group:"Wall" },
    "W_TALL_2D":    { name:"Wall – 2 Door (900h)",        w:600,  h:900,  d:300, doors:2, drawers:0, shelves:2, group:"Wall" },
    "W_CORNER":     { name:"Corner Wall Cabinet",         w:600,  h:1000, d:600, doors:1, drawers:0, shelves:1, group:"Wall" },
    "W_GLASS":      { name:"Wall – Glass Door",           w:600,  h:1000, d:300, doors:2, drawers:0, shelves:1, group:"Wall" },
    "W_OPEN":       { name:"Open Shelf Wall Unit",        w:600,  h:1000, d:300, doors:0, drawers:0, shelves:3, group:"Wall" },
    "W_MW":         { name:"Microwave Housing",           w:600,  h:500,  d:350, doors:0, drawers:0, shelves:0, group:"Wall" },
    "W_ABOVE_FF":   { name:"Above-Fridge Wall Unit",      w:600,  h:400,  d:300, doors:1, drawers:0, shelves:0, group:"Wall" },
    "W_XTALL":      { name:"Wall – Extra Tall (1060h)",   w:600,  h:1060, d:300, doors:2, drawers:0, shelves:3, group:"Wall" },
    // ── WARDROBES (carcass H=2400, D=580 unless noted) ────────────────────────
    "WRDB_SINGLE":    { name:"Single Wardrobe – 1 Door, Hanging",   w:500,  h:2400, d:580, doors:1, drawers:0, shelves:1, group:"Wardrobe" },
    "WRDB_DOUBLE":    { name:"Double Wardrobe – 2 Door, Hanging",   w:1000, h:2400, d:580, doors:2, drawers:0, shelves:1, group:"Wardrobe" },
    "WRDB_DBL_SHELF": { name:"Double – Half Hang / Half Shelf",     w:1000, h:2400, d:580, doors:2, drawers:0, shelves:4, group:"Wardrobe" },
    "WRDB_DBL_DRW":   { name:"Double – Hanging + Drawers",          w:1000, h:2400, d:580, doors:2, drawers:3, shelves:1, group:"Wardrobe" },
    "WRDB_TRIPLE":    { name:"Triple Wardrobe – 3 Door",            w:1500, h:2400, d:580, doors:3, drawers:0, shelves:2, group:"Wardrobe" },
    "WRDB_QUAD":      { name:"Quad Wardrobe – 4 Door",              w:2000, h:2400, d:580, doors:4, drawers:0, shelves:2, group:"Wardrobe" },
    "WRDB_CORNER":    { name:"Corner Wardrobe – L-shape",           w:1200, h:2400, d:580, doors:2, drawers:0, shelves:2, group:"Wardrobe" },
    "WRDB_DRW_STACK": { name:"Wardrobe Drawer Stack (internal)",    w:500,  h:800,  d:550, doors:0, drawers:4, shelves:0, group:"Wardrobe" },
    "WRDB_LINEN":     { name:"Linen / Airing Cupboard",             w:600,  h:2400, d:450, doors:2, drawers:0, shelves:6, group:"Wardrobe" },
  },
};

// ─── FACE FRAME MATERIALS ─────────────────────────────────────────────────────
// pricingMode:
//   "linear" → cost = perimeter(m) × costPerM   (sheet MDF — same regardless of stile width)
//   "volume" → cost = perimeter(m) × memberWidth(m) × thickness(m) × speciesPerM3
//              memberWidth + thickness come from room defaults (overrideable per item).
//              speciesKey points to DB.solidTimber for the £/m³ rate.
// labourHrsPerM applies the same way in both modes.
const FRAME_MATERIALS = {
  "FRAME_NONE":         { name: "No Frame",                  pricingMode: "linear", costPerM: 0,    labourHrsPerM: 0    },
  "FRAME_MDF_18":       { name: "MDF Frame 18mm",            pricingMode: "linear", costPerM: 1.80, labourHrsPerM: 0.15 },
  "FRAME_MDF_22":       { name: "MDF Frame 22mm",            pricingMode: "linear", costPerM: 2.20, labourHrsPerM: 0.15 },
  "FRAME_MDF_PAINT":    { name: "MDF Painted Frame 18mm",    pricingMode: "linear", costPerM: 1.80, labourHrsPerM: 0.18 },
  "FRAME_TIM_OAK":      { name: "Solid Oak Frame",           pricingMode: "volume", speciesKey: "TIM_OAK",   labourHrsPerM: 0.22 },
  "FRAME_TIM_ASH":      { name: "Solid Ash Frame",           pricingMode: "volume", speciesKey: "TIM_ASH",   labourHrsPerM: 0.22 },
  "FRAME_TIM_TUL":      { name: "Tulipwood Frame (paint)",   pricingMode: "volume", speciesKey: "TIM_TUL",   labourHrsPerM: 0.20 },
  "FRAME_TIM_WAL":      { name: "Solid Walnut Frame",        pricingMode: "volume", speciesKey: "TIM_WAL",   labourHrsPerM: 0.24 },
  "FRAME_TIM_MAPLE":    { name: "Hard Maple Frame",          pricingMode: "volume", speciesKey: "TIM_MAPLE", labourHrsPerM: 0.22 },
  "FRAME_TIM_CUSTOM":   { name: "Custom Timber Frame…",      pricingMode: "volume", speciesKey: null,        labourHrsPerM: 0.22 },
  // Legacy linear-priced entries — kept for backwards compatibility with old
  // quotes saved before March 2026's switch to volume pricing. Not shown in
  // the dropdown (hidden by legacy:true). When you re-pick a frame on an old
  // quote, you'll land on the new FRAME_TIM_* equivalent.
  "FRAME_OAK_18":   { name: "Solid Oak Frame 18mm (legacy)",   pricingMode: "linear", costPerM: 8.50, labourHrsPerM: 0.22, legacy: true },
  "FRAME_ASH_18":   { name: "Solid Ash Frame 18mm (legacy)",   pricingMode: "linear", costPerM: 7.00, labourHrsPerM: 0.22, legacy: true },
  "FRAME_PINE_18":  { name: "Solid Pine Frame 18mm (legacy)",  pricingMode: "linear", costPerM: 4.50, labourHrsPerM: 0.20, legacy: true },
};

// ─── EDGEBAND TYPES ───────────────────────────────────────────────────────────
const EDGEBAND_TYPES = {
  "EDGE_NONE":        { name: "None",                    costPerM: 0,    labourHrsPerM: 0    },
  "EDGE_OAK_05":      { name: "0.5mm Oak Veneer",        costPerM: 0.85, labourHrsPerM: 0.04 },
  "EDGE_OAK_2MM":     { name: "2mm Solid Oak",           costPerM: 2.20, labourHrsPerM: 0.08 },
  "EDGE_ABS_PAINT":   { name: "Paintable ABS 0.4mm",     costPerM: 0.45, labourHrsPerM: 0.03 },
  "EDGE_MELAMINE":    { name: "Melamine Matching",       costPerM: 0.35, labourHrsPerM: 0.03 },
  "EDGE_IRON_OAK":    { name: "Iron-on Oak 0.5mm",       costPerM: 0.75, labourHrsPerM: 0.03 },
};

// Materials that DON'T need edgebanding (natural ply edge is fine / pre-edged)
const NO_EDGE_MATERIALS = new Set(["MAT_BIRCH_UNF_18","MAT_BIRCH_UNF_12","MAT_BIRCH_UNF_25"]);

// Restore saved settings from localStorage (deep merge over defaults)
try {
  const saved = JSON.parse(localStorage.getItem('sab_db_settings'));
  if (saved) {
    function deepMerge(target, source) {
      for (const key of Object.keys(source)) {
        if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
          deepMerge(target[key], source[key]);
        } else {
          target[key] = source[key];
        }
      }
    }
    deepMerge(DB, saved);
  }
} catch {}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = n => `£${(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const er = () => DB.settings.labourRate + DB.settings.overheadRate; // effective hourly rate £87/hr

function hingeCount(doorHeightMm) {
  if (doorHeightMm <= 900) return 2;
  if (doorHeightMm <= 1600) return 3;
  return 4;
}

function calcDesignTimePerRoom(roomData) {
  const s = DB.settings;
  const rounds = roomData?.designRounds ?? s.designRoundsPerRoom;
  const hrsPerRound = roomData?.designHrsPerRound ?? s.designHoursPerRound;
  const techDays = roomData?.techDays ?? s.technicalDrawingDays;
  const rate = roomData?.designRate ?? s.designHourlyRate;
  const totalHrs = rounds * hrsPerRound + techDays * s.workingHoursPerDay;
  const total = totalHrs * rate;
  return total;
}

// ─── PRICING ENGINE ───────────────────────────────────────────────────────────

// Spray finishing — full prep model: caulking + sanding between coats + spray per coat
// finishType: "none" | "edge_polish" | "primed" | "paint" | "lacquer" | "stain_lacquer"
// surfaceType: "door" (2 faces + 4 edges) | "panel" (1 face)
//
// Optional overrides for richer surface models (e.g. open carcass interiors):
//   sprayAreaM2Override   — replaces the computed face×faces area entirely
//   perimMOverride        — replaces the computed 2(W+H) perimeter
//   disableTopcoatRework  — set true for items where re-spray risk is low
//                           (e.g. flat strips like fillers): bypasses topCoatReworkFactor
function calcSprayFinishCost({ doorType, widthMm, heightMm, qty = 1, finishType = "paint", hasStain = false, surfaceType = "door", sprayAreaM2Override, perimMOverride, disableTopcoatRework = false }) {
  const sf = DB.settings.sprayFinish;
  const dt = DB.doorTypes[doorType] || {};

  // ── Short-circuits for non-spray finish types ────────────────────────────
  if (finishType === "none") {
    return { costPerDoor: 0, total: 0, breakdown: { totalHrs: 0, labourCost: 0, boothCost: 0, matCost: 0, note: "no finish required" } };
  }
  if (finishType === "edge_polish") {
    // Edges only — sanded and waxed by hand, no booth time
    const ep = sf.edgePolish || { applyHrsPerM: 0.04, materialCostPerM: 0.20 };
    const perimM = perimMOverride != null ? perimMOverride : (2 * (widthMm + heightMm) / 1000);
    const sandHrs = perimM * sf.sandEdgeHrsPerM;
    const applyHrs = perimM * ep.applyHrsPerM;
    const totalHrs = sandHrs + applyHrs;
    const labourCost = totalHrs * sf.techLabourRate;
    const matCost = perimM * ep.materialCostPerM;
    const costPerDoor = labourCost + matCost;
    return {
      costPerDoor,
      total: costPerDoor * qty,
      breakdown: { totalHrs: +totalHrs.toFixed(3), labourCost: +labourCost.toFixed(2), boothCost: 0, matCost: +matCost.toFixed(2), perimM: +perimM.toFixed(3), note: "edge polish only" },
    };
  }

  // Geometry — overrides let advanced callers (e.g. open-carcass interiors) specify the
  // total spray area + perimeter directly, bypassing the W×H×faces calculation.
  const faceAreaM2  = (widthMm / 1000) * (heightMm / 1000);
  const faces       = surfaceType === "panel" ? 1 : 2;  // doors: front+back; panels: 1 face
  const sprayAreaM2 = sprayAreaM2Override != null ? sprayAreaM2Override : (faceAreaM2 * faces);
  const perimM      = perimMOverride != null ? perimMOverride : (2 * (widthMm + heightMm) / 1000);

  // Shaker/framed quirk perimeter — inner frame groove
  const stileW      = dt.shakerStileWidthMm || 70;
  const innerW      = Math.max(0, widthMm  - 2 * stileW);
  const innerH      = Math.max(0, heightMm - 2 * stileW);
  const quirkM      = dt.hasQuirk ? (2 * (innerW + innerH) / 1000) : 0;

  let totalHrs = sf.setupMinsPerDoor / 60;
  let matCost  = 0;
  const bd     = { quirkM: +quirkM.toFixed(3), faceAreaM2: +sprayAreaM2.toFixed(4) };

  // Helper: hours to spray one coat (face + edges + quirk)
  const sprayCoatHrs = (fhrs, ehrs, qhrs) =>
    sprayAreaM2 * fhrs + perimM * ehrs + quirkM * qhrs;

  // Helper: hours to sand between coats (primer/stain/lacquer-prep — lighter)
  const sandHrs = () =>
    sprayAreaM2 * sf.sandFaceHrsPerM2 + perimM * sf.sandEdgeHrsPerM + quirkM * sf.sandQuirkHrsPerM;

  // Helper: hours to sand between TOPCOATS (finer grit, more careful — show-grade prep).
  // Falls back to the base face rate if not configured.
  const topcoatSandHrs = () => {
    const faceRate = (sf.paint && sf.paint.topCoatSandFaceHrsPerM2) ?? sf.sandFaceHrsPerM2;
    return sprayAreaM2 * faceRate + perimM * sf.sandEdgeHrsPerM + quirkM * sf.sandQuirkHrsPerM;
  };

  // ── CAULKING (shaker/framed only — once before priming) ──────────────────
  if (quirkM > 0) {
    const ch = quirkM * sf.caulkHrsPerM;
    const cm = quirkM * sf.caulkCostPerM;
    totalHrs += ch;
    matCost  += cm;
    bd.caulkHrs = +ch.toFixed(3);
    bd.caulkMat = +cm.toFixed(2);
  }

  // ── STAIN (optional — brush/wipe before lacquer) ──────────────────────────
  if (hasStain || finishType === "stain_lacquer") {
    const st = sf.stain;
    // Apply stain: face + edges + quirk (brush/wipe, slower than spray)
    const sh = sprayAreaM2 * st.applyHrsPerM2 + perimM * st.edgeHrsPerM + quirkM * st.quirkHrsPerM;
    const sm = (sprayAreaM2 / st.coverageM2PerL) * st.costPerLitre;
    // Sand after stain dries (treat as one inter-coat sand)
    const ssh = sandHrs();
    totalHrs += sh + ssh;
    matCost  += sm;
    bd.stainHrs = +(sh + ssh).toFixed(3);
    bd.stainMat = +sm.toFixed(2);
  }

  // ── PRIMED ONLY (primer coats — site painter applies topcoats later) ─────
  if (finishType === "primed") {
    const p = sf.paint;
    const pHrsPerCoat  = sprayCoatHrs(p.primerSprayHrsPerM2, p.primerEdgeHrsPerM, p.primerQuirkHrsPerM);
    const pMatPerCoat  = (sprayAreaM2 / p.primerCoverageM2PerL) * p.primerCostPerLitre;
    // Primer coats: spray each coat, sand between each coat (same prep as full paint)
    const primerHrs = pHrsPerCoat * p.primerCoats + sandHrs() * p.primerCoats;
    const primerMat = pMatPerCoat * p.primerCoats;
    totalHrs += primerHrs;
    matCost  += primerMat;
    bd.primerHrs = +primerHrs.toFixed(3);
    bd.primerMat = +primerMat.toFixed(2);
    bd.note = "primed only — site painter applies topcoats";
  }

  // ── PAINT (opaque — primer + topcoats) ───────────────────────────────────
  if (finishType === "paint") {
    const p = sf.paint;
    const pHrsPerCoat  = sprayCoatHrs(p.primerSprayHrsPerM2, p.primerEdgeHrsPerM, p.primerQuirkHrsPerM);
    const pMatPerCoat  = (sprayAreaM2 / p.primerCoverageM2PerL) * p.primerCostPerLitre;
    // Primer coats: spray each coat, sand between each coat (including after last primer before first topcoat)
    const primerHrs = pHrsPerCoat * p.primerCoats + sandHrs() * p.primerCoats;
    const primerMat = pMatPerCoat * p.primerCoats;

    const tHrsPerCoat  = sprayCoatHrs(p.topCoatSprayHrsPerM2, p.topCoatEdgeHrsPerM, p.topCoatQuirkHrsPerM);
    const tMatPerCoat  = (sprayAreaM2 / p.topCoatCoverageM2PerL) * p.topCoatCostPerLitre;
    // Top coats: spray all, sand between all except after the final coat.
    // Uses the finer-grit topcoat-specific sand rate. Rework factor scales topcoat
    // labour + material to cover re-spray risk on tricky finishes.
    // disableTopcoatRework bypasses it (used for flat strips like fillers where
    // re-spray risk is low).
    const reworkFactor = disableTopcoatRework ? 1 : (p.topCoatReworkFactor || 1);
    const topHrs = (tHrsPerCoat * p.topCoats + topcoatSandHrs() * (p.topCoats - 1)) * reworkFactor;
    const topMat = (tMatPerCoat * p.topCoats) * reworkFactor;

    totalHrs += primerHrs + topHrs;
    matCost  += primerMat + topMat;
    bd.primerHrs = +primerHrs.toFixed(3);
    bd.topCoatHrs = +topHrs.toFixed(3);
    bd.primerMat = +primerMat.toFixed(2);
    bd.topCoatMat = +topMat.toFixed(2);
    if (reworkFactor !== 1) bd.reworkFactor = reworkFactor;
  }

  // ── LACQUER (clear — 2 coats, no primer) ─────────────────────────────────
  if (finishType === "lacquer" || finishType === "stain_lacquer") {
    const lq = sf.lacquer;
    const lHrsPerCoat = sprayCoatHrs(lq.sprayHrsPerM2, lq.edgeHrsPerM, lq.quirkHrsPerM);
    const lMatPerCoat = (sprayAreaM2 / lq.coverageM2PerL) * lq.costPerLitre;
    // Sand between coats except after final
    const lacHrs = lHrsPerCoat * lq.coats + sandHrs() * (lq.coats - 1);
    const lacMat = lMatPerCoat * lq.coats;
    totalHrs += lacHrs;
    matCost  += lacMat;
    bd.lacquerHrs = +lacHrs.toFixed(3);
    bd.lacquerMat = +lacMat.toFixed(2);
  }

  const labourCost  = totalHrs * sf.techLabourRate;
  const boothCost   = totalHrs * sf.boothCostPerHr;
  const costPerDoor = labourCost + boothCost + matCost;

  return {
    costPerDoor,
    total: costPerDoor * qty,
    breakdown: { ...bd, totalHrs: +totalHrs.toFixed(3), labourCost: +labourCost.toFixed(2), boothCost: +boothCost.toFixed(2), matCost: +matCost.toFixed(2) },
  };
}

function calcDoorCost({ doorType, widthMm, heightMm, qty = 1, hingeCost = 0, handleCost = 0, sprayFinish = true, hasStain = false, sprayFinishOverride = "",
  // Solid timber shaker doors only — frame + matching MDF panel.
  timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey, frameStileWidthMm, frameThicknessMm,
  margin = DB.settings.margin }) {
  const dt = DB.doorTypes[doorType];
  if (!dt) return null;
  const area = (widthMm / 1000) * (heightMm / 1000);
  // For "no finish" / "edge polish" we still pay for the door material but skip the
  // expensive spray-grade finish cost on the material itself (finishCostPerM2 = veneer
  // overlay or paint-grade prep). Drop it when the spray application is suppressed.
  const skipMaterialFinish = sprayFinishOverride === "none" || sprayFinishOverride === "edge_polish";
  const materialFinishPerM2 = skipMaterialFinish ? 0 : dt.finishCostPerM2;
  let materialCost;
  if (dt.pricingMode === "timber_frame_mdf_panel") {
    // ─── SOLID TIMBER SHAKER ────────────────────────────────────────────────
    // Frame (solid timber, cope-and-stick): perimeter × stile width × thickness × £/m³
    // Panel (MDF, finish-matched): inner-of-frame area × £/m²
    const stileW = (frameStileWidthMm ?? 70) / 1000;       // 70mm default
    const thickM = (frameThicknessMm ?? 22) / 1000;         // 22mm default
    const perimM = 2 * (widthMm + heightMm) / 1000;
    // For panel area we subtract the visible stile/rail (frame member width) on all 4 sides.
    const innerW = Math.max(0, (widthMm / 1000) - 2 * stileW);
    const innerH = Math.max(0, (heightMm / 1000) - 2 * stileW);
    const panelAreaM2 = innerW * innerH;
    // Frame volume — perimeter × member width × thickness × waste
    const frameVolM3 = perimM * stileW * thickM * 1.20;
    const timberSpec = DB.solidTimber[timberSpeciesKey];
    const pricePerM3 = timberSpeciesKey === "TIM_CUSTOM"
      ? (+timberCustomPricePerM3 || 0)
      : (timberSpec?.effectivePerM3 || 0);
    const frameCost = frameVolM3 * pricePerM3;
    // Panel: pick a sensible default if not supplied — paint-grade MDF for paint finish,
    // oak veneered MDF for lacquered/oiled if species is oak, walnut veneered MDF if walnut, etc.
    const inferredPanel = (() => {
      if (dt.finishType === "paint") return "MAT_MDF_FH_18";
      if (timberSpeciesKey === "TIM_OAK") return "MAT_OAK_MDF_UNF_19";
      if (timberSpeciesKey === "TIM_WAL") return "MAT_WAL_MDF_UNF_19";
      return "MAT_MDF_FH_18";
    })();
    const panelMat = DB.materials[panelMaterialKey || inferredPanel] || DB.materials.MAT_MDF_FH_18;
    const panelCost = panelAreaM2 * (panelMat?.costPerM2 || 16.80) * 1.12; // 12% waste on panel
    materialCost = frameCost + panelCost;
  } else {
    materialCost = area * (dt.baseCostPerM2 + materialFinishPerM2);
  }
  const labourHours = (area * dt.extraLabourPerM2) + (dt.baseLabourHrs || 0.75);
  const labourCost = labourHours * er();
  // Area-based spray finish: faces + edges + quirks (shaker profile), primer + topcoats separately
  // sprayFinishOverride lets the caller force "none" or "edge_polish" regardless of doorType default.
  const baseFinishType   = DB.doorTypes[doorType]?.finishType || "paint";
  const finishType       = sprayFinishOverride || baseFinishType;
  // Oil (hardwax / Osmo) is hand-applied but takes similar labour + material as 2-coat
  // lacquer. Reuse the lacquer cost path until a dedicated branch is added.
  const sprayFinishType  = finishType === "oil" ? "lacquer" : finishType;
  const sprayResult      = sprayFinish ? calcSprayFinishCost({ doorType, widthMm, heightMm, qty: 1, finishType: sprayFinishType, hasStain }) : null;
  const sprayFinishCost  = sprayResult ? sprayResult.costPerDoor : 0;
  const finishHrs        = sprayResult ? sprayResult.breakdown.totalHrs : 0; // spray finishing labour, per door
  const totalCostPerDoor = materialCost + labourCost + hingeCost + handleCost + sprayFinishCost;
  const sellExVAT = totalCostPerDoor * margin;
  return {
    costPerUnit: totalCostPerDoor,
    sellPerUnit: sellExVAT,
    totalCost: totalCostPerDoor * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: {
      materialCost, labourCost, hingeCost, handleCost, area, labourHours,
      // Labour hours, person-hours per door (additive, for production scheduling)
      doorHrs: labourHours,        // door-making labour
      finishHrs,                   // spray finishing labour
      totalHrs: +(labourHours + finishHrs).toFixed(3),
      sprayFinish: sprayFinishCost,
      sprayDetail: sprayResult ? sprayResult.breakdown : null,
    },
  };
}

function calcFrameCost({ species, heightMm, widthMm, labourHrs = 3, hardwareCost = 15, qty = 1, margin = DB.settings.margin }) {
  const sp = DB.solidTimber[species];
  if (!sp) return null;
  const runningM = ((2 * heightMm + widthMm) / 1000) * 1.1;
  const sectionArea = 0.095 * 0.032;
  const volumeM3 = runningM * sectionArea;
  const materialCost = volumeM3 * sp.effectivePerM3;
  const labourCost = labourHrs * er();
  const totalCost = materialCost + labourCost + hardwareCost;
  const sellExVAT = totalCost * margin;
  return {
    costPerUnit: totalCost,
    sellPerUnit: sellExVAT,
    totalCost: totalCost * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { materialCost, labourCost, hardwareCost, volumeM3, runningM,
      frameHrs: labourHrs,                  // frame-making labour, person-hours per unit
      totalHrs: +(+labourHrs).toFixed(3) },
  };
}

function calcDrawerCost({ drawerType, widthMm = 500, heightMm = 200, depthMm = 500, qty = 1, runnerCostOverride = null, carcassMaterialKey = null, margin = DB.settings.margin }) {
  const dt = DB.drawerTypes[drawerType];
  if (!dt) return null;
  let materialCost;
  if (dt.usesCarcassMaterial) {
    // Calculate from carcass sheet material: 2 sides + front + back + base
    const matKey = carcassMaterialKey || "MAT_BIRCH_UNF_18";
    const mat = DB.materials[matKey] || DB.materials["MAT_BIRCH_UNF_18"];
    const sideArea = 2 * (depthMm / 1000) * (heightMm / 1000); // 2 sides
    const fbArea = 2 * (widthMm / 1000) * (heightMm / 1000);   // front + back
    const baseArea = (widthMm / 1000) * (depthMm / 1000);       // base
    materialCost = (sideArea + fbArea + baseArea) * mat.costPerM2 * (mat.wasteFactor || 1.12);
  } else {
    materialCost = dt.materialCostPer * (widthMm / 500);
  }
  const labourCost = dt.labourHrs * er();
  const runnerCost = runnerCostOverride !== null ? runnerCostOverride : 40;
  const totalCostPerDrawer = materialCost + labourCost + runnerCost;
  const sellExVAT = totalCostPerDrawer * margin;
  return {
    costPerUnit: totalCostPerDrawer,
    sellPerUnit: sellExVAT,
    totalCost: totalCostPerDrawer * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { materialCost, labourCost, runnerCost,
      drawerHrs: dt.labourHrs,              // drawer-box-making labour, person-hours per unit
      totalHrs: +(+dt.labourHrs).toFixed(3) },
  };
}

function calcCabinetCost({
  widthMm, heightMm, depthMm,
  carcassMaterialKey = "MAT_BIRCH_UNF_18",
  carcassFinish = "none",
  backMaterialKey,  // defaults to carcassMaterialKey below — backs match the carcass material

  doorCount = 2, doorType = "SLAB_PNT",
  drawerCount = 0, drawerType = "DRW_BIRCH_PLY",
  runnerKey = "HW_RUN_BLUM_SM",
  hingeKey = "HW_HINGE_SM",
  handleKey = "HW_HDL_BAR128",
  shelfCount = 1,
  frameKey = "FRAME_NONE",
  frameThicknessMm, frameMemberWidthMm,                       // timber face frame dims
  frameCustomSpeciesName, frameCustomPricePerM3,              // FRAME_TIM_CUSTOM only
  // Solid timber shaker door (SHAKER_TIM_*) — passed through to calcDoorCost
  timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey, frameStileWidthMm, doorFrameThicknessMm,
  edgebandKey = "EDGE_OAK_05",
  hasStain = false,
  sprayFinishOverride = "",
  qty = 1,
  margin = DB.settings.margin,
}) {
  const mat = DB.materials[carcassMaterialKey];
  // Back panels match the carcass material by default. Caller can still pass an
  // explicit backMaterialKey to override (legacy quotes that set HDF still work).
  const backMat = DB.materials[backMaterialKey || carcassMaterialKey] || mat || { costPerM2: 8.50, wasteFactor: 1.10 };
  if (!mat) return null;
  const t = mat.thicknessMm || 18;

  // Panel areas (outer dimensions for ordering, converted to m²)
  const sidesArea   = 2 * (heightMm / 1000) * (depthMm / 1000);
  const topBotArea  = 2 * (widthMm / 1000) * (depthMm / 1000);
  const shelfArea   = shelfCount > 0 ? shelfCount * ((widthMm - 2*t) / 1000) * ((depthMm - 50) / 1000) : 0;
  const mainArea    = (sidesArea + topBotArea + shelfArea) * (mat.wasteFactor || 1.15);
  const backArea    = (widthMm / 1000) * (heightMm / 1000) * (backMat.wasteFactor || 1.10);
  const carcassMaterialCost = mainArea * mat.costPerM2 + backArea * backMat.costPerM2;

  // Assembly labour: scale from DB.settings.carcassBaseHrs for a reference 600×720×560 cabinet
  const refSurfMM2 = 2*(720*560) + 2*(600*560) + 600*720; // 1,910,400 mm²
  const cabSurfMM2 = 2*(heightMm*depthMm) + 2*(widthMm*depthMm) + widthMm*heightMm;
  const scale = Math.sqrt(cabSurfMM2 / refSurfMM2);
  const assemblyHrs = (DB.settings.carcassBaseHrs * scale) + (shelfCount * DB.settings.carcassShelfHrs) + (drawerCount > 0 ? DB.settings.carcassDrawerPrepHrs : 0);
  const carcassLabourCost = assemblyHrs * er();
  const carcassHardware = 8 + shelfCount * 1.50; // cam bolts, shelf pins, etc.

  // Doors (cost only, margin applied to cabinet total)
  let doorsCost = 0;
  let doorHrs = 0;       // door-making labour, person-hours per cabinet (all doors)
  let doorFinishHrs = 0; // spray finishing labour on doors, person-hours per cabinet
  if (doorCount > 0 && doorType && DB.doorTypes[doorType]) {
    const doorW = Math.floor(widthMm / doorCount) - 2;
    const doorH = heightMm - 6;
    const hinge = DB.hardware.hinges[hingeKey] || DB.hardware.hinges["HW_HINGE_SM"];
    const handle = DB.hardware.handles[handleKey] || DB.hardware.handles["HW_HDL_BAR128"];
    const hingeCostPerDoor = hingeCount(doorH) * hinge.costEach;
    const dp = calcDoorCost({ doorType, widthMm: doorW, heightMm: doorH, qty: doorCount, hingeCost: hingeCostPerDoor, handleCost: handle.costEach, hasStain, sprayFinishOverride,
      timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey,
      frameStileWidthMm, frameThicknessMm: doorFrameThicknessMm });
    doorsCost = dp ? dp.totalCost : 0;
    doorHrs = dp ? dp.breakdown.doorHrs * doorCount : 0;
    doorFinishHrs = dp ? dp.breakdown.finishHrs * doorCount : 0;
  }

  // Drawers (cost only)
  let drawersCost = 0;
  let drawerHrs = 0; // drawer-box-making labour, person-hours per cabinet (all drawers)
  if (drawerCount > 0 && drawerType && DB.drawerTypes[drawerType]) {
    const runner = DB.hardware.runners[runnerKey] || DB.hardware.runners["HW_RUN_BLUM_SM"];
    const dp = calcDrawerCost({ drawerType, widthMm: widthMm - 26, heightMm: 180, depthMm: depthMm - 50, qty: drawerCount, runnerCostOverride: runner.costPair, carcassMaterialKey });
    drawersCost = dp ? dp.totalCost : 0;
    drawerHrs = dp ? dp.breakdown.drawerHrs * drawerCount : 0;
  }

  // ── Drawer fronts (priced like doors when drawers have a painted/finished door type) ──
  let drawerFrontsCost = 0;
  let drawerFrontHrs = 0;       // drawer-front-making labour (made like doors), per cabinet
  let drawerFrontFinishHrs = 0; // spray finishing labour on drawer fronts, per cabinet
  const drawerFrontHeights = [];
  if (drawerCount > 0 && doorType && DB.doorTypes[doorType]) {
    const topRailMm = 32;
    const gapMm = 3;
    const usableHeight = heightMm - topRailMm;
    const totalGaps = gapMm * (drawerCount - 1);
    const availableHeight = usableHeight - totalGaps;
    const defaultFrontH = Math.round(availableHeight / drawerCount);
    for (let i = 0; i < drawerCount; i++) drawerFrontHeights.push(defaultFrontH);
    const frontW = widthMm - 4; // drawer fronts span full cabinet width
    for (const fh of drawerFrontHeights) {
      const dfp = calcDoorCost({ doorType, widthMm: frontW > 0 ? frontW : widthMm - 4, heightMm: fh, qty: 1, hingeCost: 0, handleCost: 0, sprayFinish: true, hasStain, sprayFinishOverride,
        timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey,
        frameStileWidthMm, frameThicknessMm: doorFrameThicknessMm });
      if (dfp) {
        drawerFrontsCost += dfp.totalCost;
        drawerFrontHrs += dfp.breakdown.doorHrs;
        drawerFrontFinishHrs += dfp.breakdown.finishHrs;
      }
    }
  }

  // ── Face frame ──────────────────────────────────────────────────────────
  const frameResult = calcCabinetFaceFrameCost({
    frameKey: frameKey || "FRAME_NONE",
    widthMm: widthMm, heightMm: heightMm, qty: 1,
    frameThicknessMm, frameMemberWidthMm,
    frameCustomSpeciesName, frameCustomPricePerM3,
  });
  // If frame fitted, override hinge to butt hinge (similar cost bracket to Blum SM)
  const effectiveHingeKey = (frameKey && frameKey !== "FRAME_NONE")
    ? (hingeKey || "HW_HINGE_BUTT")
    : (hingeKey || "HW_HINGE_SM");

  // ── Edgebanding ─────────────────────────────────────────────────────────
  // Skip if: frame is fitted, or material is birch ply
  const needsEdgeband = (frameKey === "FRAME_NONE" || !frameKey)
    && !NO_EDGE_MATERIALS.has(carcassMaterialKey || "MAT_BIRCH_UNF_18");
  const edgebandResult = needsEdgeband ? calcCabinetEdgebandCost({
    edgebandKey: edgebandKey || "EDGE_ABS_PAINT",
    widthMm: widthMm, heightMm: heightMm,
    shelfCount: shelfCount || 0, drawerCount: drawerCount || 0,
    qty: 1
  }) : { costPerUnit: 0, total: 0, totalM: 0, labourHrs: 0 };

  // ── Carcass finish ──
  // edge_polish → hand-sanded + wax on visible front-edge perimeter (incl. shelf edges
  //   if cabinet is open). No interior face spraying.
  // primed / paint / lacquer → interior shell spray: 2 sides + top + bottom + back +
  //   each shelf (both faces). Same surface for OPEN and CLOSED cabinets — closed
  //   cabinets with raw-veneer interiors still need lacquering at build time.
  //   Difference: open cabinets include shelf-front edges in the perimeter (visible);
  //   closed cabinets don't (hidden by doors).
  let carcassFinishCost = 0;
  let carcassFinishHrs = 0; // spray-tech labour to finish the carcass shell (0 unless a carcass finish is set)
  if (carcassFinish && carcassFinish !== "none") {
    const W = widthMm / 1000;
    const H = heightMm / 1000;
    const D = depthMm / 1000;
    const innerW = Math.max(0, (widthMm - 2 * t) / 1000);
    const shelfD = Math.max(0, (depthMm - 50) / 1000);
    let sprayAreaM2Override, perimMOverride;

    if (carcassFinish === "edge_polish") {
      // Edge polish: perimeter only (+ shelf front edges if open)
      let perim = 2 * (W + H);
      if (doorCount === 0) perim += (shelfCount || 0) * innerW;
      perimMOverride = perim;
    } else {
      // primed / paint / lacquer: full interior shell
      const sidesArea  = 2 * (D * H);
      const topBotArea = 2 * (W * D);
      const backArea   = W * H;
      const shelfArea2 = (shelfCount || 0) * 2 * (innerW * shelfD);
      sprayAreaM2Override = sidesArea + topBotArea + backArea + shelfArea2;
      let perim = 2 * (W + H);
      if (doorCount === 0) perim += (shelfCount || 0) * innerW;
      perimMOverride = perim;
    }

    const cf = calcSprayFinishCost({
      doorType: "SLAB_PNT",
      widthMm, heightMm, qty: 1,
      finishType: carcassFinish,
      surfaceType: "panel",
      sprayAreaM2Override,
      perimMOverride,
    });
    carcassFinishCost = cf ? cf.costPerDoor : 0;
    carcassFinishHrs  = cf ? cf.breakdown.totalHrs : 0;
  }

  // (Filler items are now top-level items priced independently — see calcFillerCost.
  // Any legacy fillerCount on cabinet items is migrated to separate filler items at
  // quote-load time via migrateLegacyFillers.)

  const totalCostPerUnit = carcassMaterialCost + carcassLabourCost + carcassHardware + carcassFinishCost + doorsCost + drawersCost + drawerFrontsCost + frameResult.total + edgebandResult.total;
  const totalCost = totalCostPerUnit * qty;
  const sellExVAT = totalCost * margin;

  // ── Labour hours roll-up, person-hours per cabinet (additive, for production scheduling) ──
  const frameHrs    = frameResult.labourHrs || 0;     // face-frame-making labour
  const edgebandHrs = edgebandResult.labourHrs || 0;  // edgebanding labour
  const finishHrs   = doorFinishHrs + drawerFrontFinishHrs + carcassFinishHrs; // total spray finishing labour (doors + fronts + carcass shell)
  const totalHrs    = +(assemblyHrs + doorHrs + drawerHrs + drawerFrontHrs + frameHrs + edgebandHrs + finishHrs).toFixed(3);

  return {
    costPerUnit: totalCostPerUnit,
    sellPerUnit: totalCostPerUnit * margin,
    totalCost,
    totalSellExVAT: sellExVAT,
    totalSellIncVAT: sellExVAT * (1 + DB.settings.vat),
    breakdown: { carcassMaterial: carcassMaterialCost, carcassLabour: carcassLabourCost, carcassHardware, doors: doorsCost, drawers: drawersCost, drawerFronts: drawerFrontsCost, frame: frameResult.total, edgeband: edgebandResult.total,
      assemblyHrs, doorHrs, drawerHrs, drawerFrontHrs, frameHrs, edgebandHrs, carcassFinishHrs: +carcassFinishHrs.toFixed(3), finishHrs, totalHrs },
  };
}

function calcEndPanelCost({ materialKey, widthMm, heightMm, thicknessMm = 18, faces = 1, exposedEdgeCount = 2, finishType = "paint", hasStain = false, qty = 1, margin = DB.settings.margin }) {
  const mat = DB.materials[materialKey];
  if (!mat) return null;
  const areaM2  = (widthMm / 1000) * (heightMm / 1000);
  const matCost = areaM2 * mat.costPerM2 * (mat.wasteFactor || 1.12);
  // Labour: cut + sand + edge banding on exposed edges
  const perimM     = 2 * (widthMm + heightMm) / 1000;
  const edgeRateM  = 0.04; // hrs per linear metre of exposed edge
  const labourHrs  = 0.5 + (exposedEdgeCount * (perimM / 4) * edgeRateM);
  const labourCost = labourHrs * er();
  // Spray finish (treat as door — same faces/edges logic, no quirk)
  const spray = calcSprayFinishCost({ doorType: finishType === "lacquer" ? "SLAB_VEN" : "SLAB_PNT",
    widthMm, heightMm, qty: 1, finishType, hasStain, surfaceType: faces >= 2 ? "door" : "panel" });
  const sprayC = spray.costPerDoor;
  const finishHrs = spray.breakdown ? spray.breakdown.totalHrs : 0; // spray finishing labour, per panel
  const totalCostPerUnit = matCost + labourCost + sprayC;
  const sellExVAT = totalCostPerUnit * margin;
  return {
    costPerUnit: totalCostPerUnit, sellPerUnit: sellExVAT,
    totalCost: totalCostPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { material: matCost, labour: labourCost, spray: sprayC,
      panelHrs: +labourHrs.toFixed(3),      // end-panel build labour, person-hours per unit
      finishHrs,                            // spray finishing labour
      totalHrs: +(labourHrs + finishHrs).toFixed(3) },
  };
}

function calcFloatingShelfCost({ materialKey, lengthMm, depthMm, thicknessMm = 18, visibleThicknessMm = 18, faces = 1, finishType = "lacquer", hasStain = false, qty = 1, customSpeciesName = "", customPricePerM3 = 0, margin = DB.settings.margin }) {
  // Timber path: materialKey is a DB.solidTimber species (or TIM_CUSTOM).
  // Volume-based pricing replaces area-based sheet pricing.
  const timberSpec = DB.solidTimber[materialKey];
  const isCustomTimber = materialKey === "TIM_CUSTOM";
  const isTimber = !!timberSpec || isCustomTimber;
  const mat = isTimber ? null : DB.materials[materialKey];
  if (!isTimber && !mat) return null;
  const topAreaM2   = (lengthMm / 1000) * (depthMm / 1000);
  const isBoxShelf  = visibleThicknessMm > thicknessMm + 4;  // box shelf if apparent thickness significantly greater
  // Box shelf = top face + front return panel (mitred 45°) + optional bottom face
  const frontReturnAreaM2 = isBoxShelf ? (lengthMm / 1000) * (visibleThicknessMm / 1000) : 0;
  const bottomAreaM2      = isBoxShelf ? topAreaM2 : 0;  // hollow box needs bottom too
  let matCost, totalAreaM2;
  if (isTimber) {
    const pricePerM3 = isCustomTimber ? (+customPricePerM3 || 0) : timberSpec.effectivePerM3;
    const wasteFactor = 1.20; // higher waste on solid timber than sheet
    const totalVolM3 = (topAreaM2 + frontReturnAreaM2 + bottomAreaM2) * (thicknessMm / 1000) * wasteFactor;
    matCost = totalVolM3 * pricePerM3;
    totalAreaM2 = topAreaM2 + frontReturnAreaM2 + bottomAreaM2; // kept for any downstream display
  } else {
    totalAreaM2 = (topAreaM2 + frontReturnAreaM2 + bottomAreaM2) * (mat.wasteFactor || 1.12);
    matCost     = totalAreaM2 * mat.costPerM2;
  }
  // Labour: cut + sand + assembly (extra for mitre, extra for solid timber prep)
  const labourHrs   = 0.5 + (isBoxShelf ? 0.75 : 0) + (isTimber ? 0.3 : 0);
  const labourCost  = labourHrs * er();
  // Spray finish: 1 or 2 faces — top face always, bottom face if box shelf
  const sprayFaces  = faces >= 2 || isBoxShelf ? "door" : "panel";
  const spray       = calcSprayFinishCost({ doorType: finishType === "paint" ? "SLAB_PNT" : "SLAB_VEN",
    widthMm: depthMm, heightMm: lengthMm, qty: 1, finishType, hasStain, surfaceType: sprayFaces });
  const sprayC = spray.costPerDoor;
  const finishHrs = spray.breakdown ? spray.breakdown.totalHrs : 0; // spray finishing labour, per shelf
  const totalCostPerUnit = matCost + labourCost + sprayC;
  const sellExVAT = totalCostPerUnit * margin;
  return {
    costPerUnit: totalCostPerUnit, sellPerUnit: sellExVAT,
    totalCost: totalCostPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { material: matCost, labour: labourCost, spray: sprayC, isBoxShelf,
      shelfHrs: +labourHrs.toFixed(3),      // floating-shelf build labour, person-hours per unit
      finishHrs,                            // spray finishing labour
      totalHrs: +(labourHrs + finishHrs).toFixed(3) },
  };
}

function calcMouldingCost({ mouldingKey, metres, qty = 1, margin = DB.settings.margin }) {
  const mld = DB.mouldings[mouldingKey];
  if (!mld) return null;
  const wastedM    = metres * 1.10;  // 10% cutting waste
  const matCost    = wastedM * mld.costPerM;
  const labourHrs  = metres * mld.labourHrsPerM; // moulding cut & fit labour, per unit run
  const labourCost = labourHrs * er();
  const totalCostPerUnit = matCost + labourCost;
  const sellExVAT  = totalCostPerUnit * margin;
  return {
    costPerUnit: totalCostPerUnit, sellPerUnit: sellExVAT,
    totalCost: totalCostPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { material: matCost, labour: labourCost,
      mouldingHrs: +labourHrs.toFixed(3),   // moulding cut & fit labour, person-hours per unit
      totalHrs: +labourHrs.toFixed(3) },
  };
}

// ─── WRP MOULDING COST ────────────────────────────────────────────────────────
// Parse "55mm x 52mm" → { w: 55, h: 52 }. Returns null if unparseable.
function parseWRPDimensions(dimStr) {
  if (!dimStr) return null;
  const m = dimStr.match(/(\d+(?:\.\d+)?)\s*mm\s*x\s*(\d+(?:\.\d+)?)\s*mm/i);
  return m ? { w: +m[1], h: +m[2] } : null;
}

// Estimate paint cost per linear metre for a WRP moulding.
// Returns { paintCostPerM, breakdown } or { paintCostPerM: 0, breakdown: null } if finishType is "none".
function calcWRPFinishCostPerM({ dimensions, girth_mm_override, finishType, hasStain }) {
  if (!finishType || finishType === "none") return { paintCostPerM: 0, breakdown: null };
  let girth_mm = girth_mm_override;
  if (!girth_mm) {
    const parsed = parseWRPDimensions(dimensions);
    if (!parsed) return { paintCostPerM: 0, breakdown: null };
    girth_mm = (parsed.w + parsed.h) * (DB.settings.wrpMouldingGirthMultiplier || 1.2);
  }
  // Treat one metre of moulding as a "panel" of girth_mm × 1000mm, one face.
  const spray = calcSprayFinishCost({
    doorType: null, widthMm: girth_mm, heightMm: 1000, qty: 1,
    finishType, hasStain, surfaceType: "panel",
  });
  return { paintCostPerM: spray.costPerDoor, breakdown: spray.breakdown };
}

// Supply + finishing pricing: (WRP cost + paint cost) × metres × (1 + markup/100)
function calcWRPMouldingCost({
  wrp_price_per_metre, linear_metres, markup_pct, qty = 1,
  finishType, hasStain, dimensions, girth_mm_override, paint_rate_per_m_override,
}) {
  const price = wrp_price_per_metre || 0;
  const metres = linear_metres || 0;
  const markup = markup_pct ?? DB.settings.wrpMouldingMarkupPct;
  const materialCost = price * metres;
  // Finishing: manual override OR area-based auto via spray booth rates
  let paintRatePerM = 0, paintBreakdown = null;
  if (paint_rate_per_m_override != null && paint_rate_per_m_override !== "") {
    paintRatePerM = +paint_rate_per_m_override || 0;
  } else if (finishType && finishType !== "none") {
    const res = calcWRPFinishCostPerM({ dimensions, girth_mm_override, finishType, hasStain });
    paintRatePerM = res.paintCostPerM;
    paintBreakdown = res.breakdown;
  }
  const finishCost = paintRatePerM * metres;
  // Finishing labour, person-hours per unit run. paintBreakdown.totalHrs is per linear metre
  // (a 1m × girth panel); null when a manual paint-rate override is used, so hours are unknown → 0.
  const finishHrs = paintBreakdown ? +(paintBreakdown.totalHrs * metres).toFixed(3) : 0;
  const totalCost = materialCost + finishCost;
  const sellExVAT = totalCost * (1 + markup / 100);
  return {
    costPerUnit: totalCost, sellPerUnit: sellExVAT,
    totalCost: totalCost * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: {
      material: materialCost * qty,
      finishing: finishCost * qty,
      paint_rate_per_m: +paintRatePerM.toFixed(2),
      finish_type: finishType || "none",
      markup_pct: markup,
      finishHrs,                            // spray finishing labour, person-hours per unit
      totalHrs: finishHrs,
      ...(paintBreakdown ? { spray: paintBreakdown } : {}),
    },
  };
}

// ─── FACE FRAME COST (CABINET) ─────────────────────────────────────────────────
// Frame runs around the cabinet opening perimeter (2×W + 2×H).
// Linear-priced (MDF): cost = perimeter × costPerM.
// Volume-priced (solid timber): cost = perimeter × memberWidth × thickness × £/m³.
// Corner joints (pocket screw / cope-and-stick): 0.1 hrs per corner (4 corners).
// Changes hinge from Blum cup to butt hinge — handled in priceItem hinge override.
function calcCabinetFaceFrameCost({ frameKey, widthMm, heightMm, qty = 1, frameThicknessMm, frameMemberWidthMm, frameCustomSpeciesName, frameCustomPricePerM3 }) {
  const fm = FRAME_MATERIALS[frameKey];
  if (!fm) return { costPerUnit: 0, total: 0, perimM: 0 };
  const perimM = 2 * (widthMm + heightMm) / 1000;
  const cornerHrs = 4 * 0.10; // 4 corner joints
  const labourHrs = perimM * (fm.labourHrsPerM || 0) + cornerHrs;
  let matCost = 0;
  if (fm.pricingMode === "volume") {
    const memberM = (frameMemberWidthMm ?? 30) / 1000;
    const thickM  = (frameThicknessMm ?? 22) / 1000;
    const speciesPerM3 = fm.speciesKey
      ? (DB.solidTimber[fm.speciesKey]?.effectivePerM3 || 0)
      : (+frameCustomPricePerM3 || 0); // FRAME_TIM_CUSTOM
    const wasteFactor = 1.20;
    matCost = perimM * memberM * thickM * speciesPerM3 * wasteFactor;
  } else {
    if (!fm.costPerM) return { costPerUnit: 0, total: 0, perimM: 0 };
    matCost = perimM * fm.costPerM;
  }
  const labourCost = labourHrs * er();
  const costPerUnit = matCost + labourCost;
  return { costPerUnit: +costPerUnit.toFixed(2), total: +(costPerUnit * qty).toFixed(2), perimM: +perimM.toFixed(3), labourHrs: +labourHrs.toFixed(3) };
}

// ─── EDGEBAND COST (CABINET) ───────────────────────────────────────────────────
// Applied to front edges of carcass panels when no face frame and material needs it.
// Edges: 2×height (sides) + 2×width (top+bottom) + width per shelf + width per drawer box.
function calcCabinetEdgebandCost({ edgebandKey, widthMm, heightMm, shelfCount = 0, drawerCount = 0, qty = 1 }) {
  const eb = EDGEBAND_TYPES[edgebandKey];
  if (!eb || eb.costPerM === 0) return { costPerUnit: 0, total: 0, totalM: 0, labourHrs: 0 };
  // Carcass front perimeter + shelves + drawer box front edges
  const carcassM = 2 * (widthMm + heightMm) / 1000;
  const shelvesM = shelfCount * (widthMm / 1000);
  const drawersM = drawerCount * (widthMm / 1000);
  const totalM   = carcassM + shelvesM + drawersM;
  const labourHrs  = totalM * eb.labourHrsPerM;
  const matCost    = totalM * eb.costPerM;
  const labourCost = labourHrs * er();
  const costPerUnit = matCost + labourCost;
  return { costPerUnit: +costPerUnit.toFixed(2), total: +(costPerUnit * qty).toFixed(2), totalM: +totalM.toFixed(3), labourHrs: +labourHrs.toFixed(3) };
}

// ── FILLER COST ────────────────────────────────────────────────────────────
// Scribed strip in matching door finish. Self-contained line item (not bundled
// inside a cabinet). Pricing scales with strip size — bench labour is flat per
// filler since cut/sand/drill prep is constant regardless of length.
function calcFillerCost({ doorType = "SHAKER_PNT", widthMm = 50, heightMm = 720, qty = 1, hasStain = false, sprayFinishOverride = "", margin = DB.settings.margin }) {
  const dt = DB.doorTypes[doorType];
  if (!dt) return null;
  const FILLER_BENCH_LABOUR_HRS = 0.20;  // 12 min — cut, sand, edge ease, drill for fixings
  const area = (widthMm / 1000) * (heightMm / 1000);
  const materialCost = area * dt.baseCostPerM2;
  const labourCost = FILLER_BENCH_LABOUR_HRS * er();
  const finishType = sprayFinishOverride || dt.finishType || "paint";
  const spray = calcSprayFinishCost({
    doorType, widthMm, heightMm, qty: 1, finishType, hasStain,
    surfaceType: "panel",         // 1 face — back is hidden in the wall gap
    disableTopcoatRework: true,   // flat strip = low re-spray risk
  });
  const sprayCost = spray ? spray.costPerDoor : 0;
  const costPerUnit = materialCost + labourCost + sprayCost;
  const totalCost = costPerUnit * qty;
  const sellExVAT = totalCost * margin;
  return {
    costPerUnit,
    sellPerUnit: costPerUnit * margin,
    totalCost,
    totalSellExVAT: sellExVAT,
    totalSellIncVAT: sellExVAT * (1 + DB.settings.vat),
    breakdown: { material: +materialCost.toFixed(2), labour: +labourCost.toFixed(2), spray: +sprayCost.toFixed(2) },
  };
}

function priceItem(item, effectiveMargin) {
  // effectiveMargin lets a quote override the global margin (quote.marginOverride).
  // When undefined/null it falls back to DB.settings.margin, so callers that pass
  // nothing price exactly as before.
  const margin = (effectiveMargin ?? DB.settings.margin);
  // Fixed-price short-circuit: bypass the type-specific pricer entirely. Sell = cost ×
  // (1 + markup/100). Margin / overhead / consumables share are all excluded
  // downstream in distributeProjectCosts + quoteTotals — this item is a pure
  // pass-through (e.g. trade-priced worktop). Margin override does not apply here.
  if (item.fixedPrice) {
    const qty = item.qty || 1;
    const costPerUnit = +item.fixedCostExVAT || 0;
    const markup = (+item.fixedMarkupPct || 0) / 100;
    const sellPerUnit = costPerUnit * (1 + markup);
    return {
      costPerUnit, sellPerUnit,
      totalCost: costPerUnit * qty,
      totalSellExVAT: sellPerUnit * qty,
      totalSellIncVAT: sellPerUnit * qty * (1 + DB.settings.vat),
      breakdown: { fixedCost: costPerUnit, markupPct: +item.fixedMarkupPct || 0 },
      isFixedPrice: true,
    };
  }
  if (item.type === "cabinet")  return calcCabinetCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "door")     return calcDoorCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "frame")    return calcFrameCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "drawer")   return calcDrawerCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "endpanel") return calcEndPanelCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "shelf")    return calcFloatingShelfCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "moulding") return calcMouldingCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "wrp_moulding") return calcWRPMouldingCost({ ...item.params, qty: item.qty }); // WRP uses its own markup_pct, not margin
  if (item.type === "filler")   return calcFillerCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "custom") {
    const cost = (item.params.unitCostExVAT || 0) * item.qty;
    const sell = cost * margin;
    return { costPerUnit: item.params.unitCostExVAT, sellPerUnit: item.params.unitCostExVAT * margin, totalCost: cost, totalSellExVAT: sell, totalSellIncVAT: sell * (1 + DB.settings.vat), breakdown: {} };
  }
  return null;
}
// ─── Exports / global exposure ──────────────────────────────────────────────
(function () {
  const api = { DB, FRAME_MATERIALS, EDGEBAND_TYPES, NO_EDGE_MATERIALS, er, hingeCount, fmt,
    calcSprayFinishCost, calcDoorCost, calcFrameCost, calcDrawerCost, calcCabinetCost,
    calcEndPanelCost, calcFloatingShelfCost, calcMouldingCost, parseWRPDimensions,
    calcWRPFinishCostPerM, calcWRPMouldingCost, calcCabinetFaceFrameCost,
    calcCabinetEdgebandCost, calcFillerCost, priceItem };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") Object.assign(window, api);
})();
