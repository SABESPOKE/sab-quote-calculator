// ─────────────────────────────────────────────────────────────────────────────
// pricing-engine.js — SERVER-SIDE COPY of the cabinet cost engine.
//
// This is a VERBATIM copy of the cost engine inlined in public/index.html
// (the live React single-file app). It is duplicated here ON PURPOSE so the
// engine can be required() from server.js and called from another app (the
// cabinet configurator) without touching the live UI.
//
// IMPORTANT — DO NOT EDIT FORMULAS/RATES HERE INDEPENDENTLY.
//   The canonical source of truth remains public/index.html. If the engine in
//   index.html changes, this file must be re-synced by re-copying the relevant
//   functions verbatim. Temporary duplication is accepted; keep them identical.
//
// Closure copied (everything calcCabinetCost transitively uses):
//   DB, FRAME_MATERIALS, EDGEBAND_TYPES, NO_EDGE_MATERIALS,
//   er, hingeCount, calcSprayFinishCost, calcDoorCost, calcDrawerCost,
//   calcCabinetFaceFrameCost, calcCabinetEdgebandCost, calcCabinetCost.
//
// Deliberately EXCLUDED (not used by calcCabinetCost, or browser-only):
//   localStorage settings deep-merge block, fmt(), calcDesignTimePerRoom(),
//   calcFrameCost(), calcEndPanelCost(), calcFloatingShelfCost(),
//   calcMouldingCost(), priceItem(), ensurePricing(), all WRP/moulding logic,
//   and all React / DOM references.
// ─────────────────────────────────────────────────────────────────────────────

/* eslint-disable */

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
    installDayRate: 350,        // £/day — installation & fitting labour
    deliveryFee: 200,           // £ flat — delivery & transport (per project)
    pmPercent: 6,               // % of mfg sell ex VAT — project management
    consumablesPerItem: 60,     // £ per line item — fixings, glue, edge tape, abrasives
    contingencyPercent: 7.5,    // % uplift on project subtotal (optional)
    warrantyPercent: 1.5,       // % of total ex VAT — warranty & aftercare allowance (optional)
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
      sandFaceHrsPerM2:  0.08,  // hrs per m² — random orbital on flat faces
      sandEdgeHrsPerM:   0.05,  // hrs per linear metre — careful sanding of 4 edges
      sandQuirkHrsPerM:  0.08,  // hrs per linear metre — into shaker groove (hardest access)

      // Prep — caulking (shaker & framed-inset only, applied ONCE before priming)
      // Fills the quirk groove for a gap-free surface. Includes: apply, dry, sand flat.
      // Validated: 0.25 hrs/m × 2.06m quirk on std base door ≈ 31 mins ✓
      caulkHrsPerM:    0.25,   // hrs per linear metre of quirk groove
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
        topCoatSprayHrsPerM2:   0.12,
        topCoatEdgeHrsPerM:     0.04,
        topCoatQuirkHrsPerM:    0.03,
        topCoatCostPerLitre:    14,    // £/litre — e.g. Teknos, Tikkurila water-based
        topCoatCoverageM2PerL:  10,
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
    "MAT_DF_PLY_18":        { name: "Douglas Fir Plywood 18mm",            costPerM2: 62.15, thicknessMm: 18, wasteFactor: 1.15 },
    "MAT_BIRCH_UNF_18":     { name: "Birch Plywood Unfinished 18mm",       costPerM2: 33.59, thicknessMm: 18, wasteFactor: 1.15 },
    "MAT_BIRCH_PREF_18":    { name: "Birch Plywood Prefinished 18mm",      costPerM2: 40.31, thicknessMm: 18, wasteFactor: 1.15 },
    "MAT_OAK_MDF_UNF_19":   { name: "Oak Veneered MDF Unfinished 19mm",   costPerM2: 26.87, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_OAK_MDF_PREF_19":  { name: "Oak Veneered MDF Prefinished 19mm",  costPerM2: 33.59, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_WAL_MDF_UNF_19":   { name: "Walnut Veneered MDF Unfinished 19mm",costPerM2: 40.31, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_WAL_MDF_PREF_19":  { name: "Walnut Veneered MDF Prefinished 19mm",costPerM2: 47.03, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_MAPLE_MDF_UNF_19": { name: "Maple Veneered MDF Unfinished 19mm", costPerM2: 30.23, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_MDF_FH_18":        { name: "Finsa Hydrofuga MDF 18mm",            costPerM2: 16.80, thicknessMm: 18, wasteFactor: 1.12 },
    "MAT_MDF_FH_22":        { name: "Finsa Hydrofuga MDF 22mm",            costPerM2: 20.16, thicknessMm: 22, wasteFactor: 1.12 },
    "MAT_BACK_HDF_6":       { name: "HDF Back Panel 6mm",                  costPerM2:  8.50, thicknessMm:  6, wasteFactor: 1.10 },
    "MAT_MEL_EGGER_18":     { name: "Melamine - Egger 18mm",               costPerM2: 22.00, thicknessMm: 18, wasteFactor: 1.12 },
    "MAT_MEL_EGGER_25":     { name: "Melamine - Egger 25mm",               costPerM2: 28.00, thicknessMm: 25, wasteFactor: 1.12 },
    "MAT_SHINNOKI_19":      { name: "Shinnoki Board 19mm",                 costPerM2: 55.00, thicknessMm: 19, wasteFactor: 1.12 },
    "MAT_BACK_PLY_9":       { name: "Back Panel Ply 9mm",                  costPerM2: 12.00, thicknessMm:  9, wasteFactor: 1.10 },
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
    // ── BASE CABINETS (carcass H=720, D=560 unless noted) ─────────────────────
    "B_STD_1D":     { name:"Base – 1 Door",               w:400,  h:720,  d:560, doors:1, drawers:0, shelves:1, group:"Base" },
    "B_STD_2D":     { name:"Base – 2 Door",               w:600,  h:720,  d:560, doors:2, drawers:0, shelves:1, group:"Base" },
    "B_DRW_DOOR":   { name:"Base – Door & Drawer",        w:600,  h:720,  d:560, doors:2, drawers:1, shelves:0, group:"Base" },
    "B_DRAWER3":    { name:"3-Drawer Stack",              w:500,  h:720,  d:560, doors:0, drawers:3, shelves:0, group:"Base" },
    "B_DRAWER4":    { name:"4-Drawer Stack",              w:600,  h:720,  d:560, doors:0, drawers:4, shelves:0, group:"Base" },
    "B_SINK":       { name:"Sink Base",                   w:1000, h:720,  d:560, doors:2, drawers:0, shelves:0, group:"Base" },
    "B_CORNER_BL":  { name:"Corner Base – Blind",         w:900,  h:720,  d:560, doors:1, drawers:0, shelves:1, group:"Base" },
    "B_CORNER_CAR": { name:"Corner Base – Carousel",      w:900,  h:720,  d:560, doors:2, drawers:0, shelves:2, group:"Base" },
    "B_DW_HSG":     { name:"Dishwasher Housing",          w:600,  h:820,  d:560, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_DW_DOOR":    { name:"Dishwasher – Door Only",      w:600,  h:820,  d:560, doors:1, drawers:0, shelves:0, group:"Base" },
    "B_WM_HSG":     { name:"Washing Machine Housing",     w:600,  h:820,  d:600, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_BIN":        { name:"Bin Pull-Out Cabinet",        w:600,  h:720,  d:560, doors:2, drawers:0, shelves:0, group:"Base" },
    "B_PULLOUT":    { name:"Pull-Out Base Larder",        w:300,  h:720,  d:560, doors:1, drawers:0, shelves:5, group:"Base" },
    "B_WINE":       { name:"Wine Rack Base",              w:300,  h:720,  d:560, doors:0, drawers:0, shelves:0, group:"Base" },
    "B_OPEN":       { name:"Open Base Shelf Unit",        w:600,  h:720,  d:560, doors:0, drawers:0, shelves:2, group:"Base" },
    "B_WIDE":       { name:"Wide Base Cabinet",           w:900,  h:720,  d:560, doors:2, drawers:1, shelves:1, group:"Base" },
    // ── TALL CABINETS (carcass H=2100, D=560 unless noted) ────────────────────
    "T_LARDER":     { name:"Tall Larder Cabinet",         w:600,  h:2100, d:560, doors:2, drawers:0, shelves:5, group:"Tall" },
    "T_LARDER_PO":  { name:"Tall Pull-Out Larder",        w:300,  h:2100, d:560, doors:1, drawers:0, shelves:6, group:"Tall" },
    "T_OVEN_S":     { name:"Single Oven Housing",         w:600,  h:2100, d:560, doors:2, drawers:1, shelves:0, group:"Tall" },
    "T_OVEN_D":     { name:"Double Oven Housing",         w:600,  h:2100, d:560, doors:2, drawers:0, shelves:0, group:"Tall" },
    "T_OVEN_MW":    { name:"Oven & Microwave Tower",      w:600,  h:2100, d:560, doors:3, drawers:1, shelves:0, group:"Tall" },
    "T_FRIDGE":     { name:"Fridge Housing",              w:600,  h:2100, d:580, doors:1, drawers:0, shelves:0, group:"Tall" },
    "T_FF":         { name:"Fridge-Freezer Housing",      w:700,  h:2100, d:580, doors:2, drawers:0, shelves:0, group:"Tall" },
    "T_BROOM":      { name:"Broom / Utility Cupboard",   w:300,  h:2100, d:560, doors:1, drawers:0, shelves:2, group:"Tall" },
    "T_OPEN":       { name:"Open Tall Shelf Unit",        w:600,  h:2100, d:560, doors:0, drawers:0, shelves:5, group:"Tall" },
    "T_DRESSER":    { name:"Dresser Cabinet",             w:1200, h:2100, d:560, doors:4, drawers:3, shelves:4, group:"Tall" },
    "T_CORNER":     { name:"Tall Corner Cabinet",         w:600,  h:2100, d:560, doors:2, drawers:0, shelves:4, group:"Tall" },
    "T_STORE":      { name:"Tall Storage Cabinet",        w:600,  h:2100, d:560, doors:2, drawers:2, shelves:4, group:"Tall" },
    // ── WALL CABINETS (carcass H=720, D=300 unless noted) ─────────────────────
    "W_STD_1D":     { name:"Wall – 1 Door",               w:400,  h:720,  d:300, doors:1, drawers:0, shelves:1, group:"Wall" },
    "W_STD_2D":     { name:"Wall – 2 Door",               w:600,  h:720,  d:300, doors:2, drawers:0, shelves:1, group:"Wall" },
    "W_TALL_1D":    { name:"Wall – 1 Door (900h)",        w:400,  h:900,  d:300, doors:1, drawers:0, shelves:2, group:"Wall" },
    "W_TALL_2D":    { name:"Wall – 2 Door (900h)",        w:600,  h:900,  d:300, doors:2, drawers:0, shelves:2, group:"Wall" },
    "W_CORNER":     { name:"Corner Wall Cabinet",         w:600,  h:720,  d:600, doors:1, drawers:0, shelves:1, group:"Wall" },
    "W_GLASS":      { name:"Wall – Glass Door",           w:600,  h:720,  d:300, doors:2, drawers:0, shelves:1, group:"Wall" },
    "W_OPEN":       { name:"Open Shelf Wall Unit",        w:600,  h:720,  d:300, doors:0, drawers:0, shelves:3, group:"Wall" },
    "W_MW":         { name:"Microwave Housing",           w:600,  h:500,  d:350, doors:0, drawers:0, shelves:0, group:"Wall" },
    "W_ABOVE_FF":   { name:"Above-Fridge Wall Unit",      w:600,  h:400,  d:300, doors:1, drawers:0, shelves:0, group:"Wall" },
    "W_XTALL":      { name:"Wall – Extra Tall (1060h)",   w:600,  h:1060, d:300, doors:2, drawers:0, shelves:3, group:"Wall" },
    // ── ISLAND & FURNITURE ────────────────────────────────────────────────────
    "I_ISLAND":     { name:"Island Base Cabinet",         w:1200, h:900,  d:700, doors:4, drawers:2, shelves:1, group:"Island" },
    "I_PENINSULA":  { name:"Peninsula Cabinet",           w:1200, h:900,  d:600, doors:4, drawers:2, shelves:1, group:"Island" },
    "I_PLATE_RACK": { name:"Plate Rack Unit",             w:800,  h:1500, d:300, doors:2, drawers:0, shelves:2, group:"Island" },
  },
};

// ─── FACE FRAME MATERIALS ─────────────────────────────────────────────────────
const FRAME_MATERIALS = {
  "FRAME_NONE":       { name: "No Frame",                costPerM: 0,    labourHrsPerM: 0    },
  "FRAME_MDF_18":     { name: "MDF Frame 18mm",          costPerM: 1.80, labourHrsPerM: 0.15 },
  "FRAME_MDF_PAINT":  { name: "MDF Painted Frame 18mm",  costPerM: 1.80, labourHrsPerM: 0.18 },
  "FRAME_OAK_18":     { name: "Solid Oak Frame 18mm",    costPerM: 8.50, labourHrsPerM: 0.22 },
  "FRAME_ASH_18":     { name: "Solid Ash Frame 18mm",    costPerM: 7.00, labourHrsPerM: 0.22 },
  "FRAME_PINE_18":    { name: "Solid Pine Frame 18mm",   costPerM: 4.50, labourHrsPerM: 0.20 },
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

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const er = () => DB.settings.labourRate + DB.settings.overheadRate; // effective hourly rate £87/hr

function hingeCount(doorHeightMm) {
  if (doorHeightMm <= 900) return 2;
  if (doorHeightMm <= 1600) return 3;
  return 4;
}

// ─── PRICING ENGINE ───────────────────────────────────────────────────────────

// Spray finishing — full prep model: caulking + sanding between coats + spray per coat
// finishType: "paint" | "lacquer" | "stain_lacquer"
// surfaceType: "door" (2 faces + 4 edges) | "panel" (1 face)
function calcSprayFinishCost({ doorType, widthMm, heightMm, qty = 1, finishType = "paint", hasStain = false, surfaceType = "door" }) {
  const sf = DB.settings.sprayFinish;
  const dt = DB.doorTypes[doorType] || {};

  // Geometry
  const faceAreaM2  = (widthMm / 1000) * (heightMm / 1000);
  const faces       = surfaceType === "panel" ? 1 : 2;  // doors: front+back; panels: 1 face
  const sprayAreaM2 = faceAreaM2 * faces;
  const perimM      = 2 * (widthMm + heightMm) / 1000;  // 4-edge perimeter in metres

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

  // Helper: hours to sand between coats
  const sandHrs = () =>
    sprayAreaM2 * sf.sandFaceHrsPerM2 + perimM * sf.sandEdgeHrsPerM + quirkM * sf.sandQuirkHrsPerM;

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
    // Top coats: spray all, sand between all except after the final coat
    const topHrs = tHrsPerCoat * p.topCoats + sandHrs() * (p.topCoats - 1);
    const topMat = tMatPerCoat * p.topCoats;

    totalHrs += primerHrs + topHrs;
    matCost  += primerMat + topMat;
    bd.primerHrs = +primerHrs.toFixed(3);
    bd.topCoatHrs = +topHrs.toFixed(3);
    bd.primerMat = +primerMat.toFixed(2);
    bd.topCoatMat = +topMat.toFixed(2);
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

function calcDoorCost({ doorType, widthMm, heightMm, qty = 1, hingeCost = 0, handleCost = 0, sprayFinish = true, hasStain = false }) {
  const dt = DB.doorTypes[doorType];
  if (!dt) return null;
  const area = (widthMm / 1000) * (heightMm / 1000);
  const materialCost = area * (dt.baseCostPerM2 + dt.finishCostPerM2);
  const labourHours = (area * dt.extraLabourPerM2) + (dt.baseLabourHrs || 0.75);
  const labourCost = labourHours * er();
  // Area-based spray finish: faces + edges + quirks (shaker profile), primer + topcoats separately
  const finishType       = DB.doorTypes[doorType]?.finishType || "paint";
  const sprayResult      = sprayFinish ? calcSprayFinishCost({ doorType, widthMm, heightMm, qty: 1, finishType, hasStain }) : null;
  const sprayFinishCost  = sprayResult ? sprayResult.costPerDoor : 0;
  const totalCostPerDoor = materialCost + labourCost + hingeCost + handleCost + sprayFinishCost;
  const sellExVAT = totalCostPerDoor * DB.settings.margin;
  return {
    costPerUnit: totalCostPerDoor,
    sellPerUnit: sellExVAT,
    totalCost: totalCostPerDoor * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: {
      materialCost, labourCost, hingeCost, handleCost, area, labourHours,
      sprayFinish: sprayFinishCost,
      sprayDetail: sprayResult ? sprayResult.breakdown : null,
    },
  };
}

function calcDrawerCost({ drawerType, widthMm = 500, heightMm = 200, depthMm = 500, qty = 1, runnerCostOverride = null, carcassMaterialKey = null }) {
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
  const sellExVAT = totalCostPerDrawer * DB.settings.margin;
  return {
    costPerUnit: totalCostPerDrawer,
    sellPerUnit: sellExVAT,
    totalCost: totalCostPerDrawer * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { materialCost, labourCost, runnerCost },
  };
}

function calcCabinetCost({
  widthMm, heightMm, depthMm,
  carcassMaterialKey = "MAT_BIRCH_UNF_18",
  backMaterialKey = "MAT_BACK_HDF_6",
  doorCount = 2, doorType = "SLAB_PNT",
  drawerCount = 0, drawerType = "DRW_BIRCH_PLY",
  runnerKey = "HW_RUN_BLUM_SM",
  hingeKey = "HW_HINGE_SM",
  handleKey = "HW_HDL_BAR128",
  shelfCount = 1,
  frameKey = "FRAME_NONE",
  edgebandKey = "EDGE_OAK_05",
  hasStain = false,
  qty = 1,
}) {
  const mat = DB.materials[carcassMaterialKey];
  const backMat = DB.materials[backMaterialKey] || { costPerM2: 8.50, wasteFactor: 1.10 };
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
  if (doorCount > 0 && doorType && DB.doorTypes[doorType]) {
    const doorW = Math.floor(widthMm / doorCount) - 2;
    const doorH = heightMm - 6;
    const hinge = DB.hardware.hinges[hingeKey] || DB.hardware.hinges["HW_HINGE_SM"];
    const handle = DB.hardware.handles[handleKey] || DB.hardware.handles["HW_HDL_BAR128"];
    const hingeCostPerDoor = hingeCount(doorH) * hinge.costEach;
    const dp = calcDoorCost({ doorType, widthMm: doorW, heightMm: doorH, qty: doorCount, hingeCost: hingeCostPerDoor, handleCost: handle.costEach, hasStain });
    doorsCost = dp ? dp.totalCost : 0;
  }

  // Drawers (cost only)
  let drawersCost = 0;
  if (drawerCount > 0 && drawerType && DB.drawerTypes[drawerType]) {
    const runner = DB.hardware.runners[runnerKey] || DB.hardware.runners["HW_RUN_BLUM_SM"];
    const dp = calcDrawerCost({ drawerType, widthMm: widthMm - 26, heightMm: 180, depthMm: depthMm - 50, qty: drawerCount, runnerCostOverride: runner.costPair, carcassMaterialKey });
    drawersCost = dp ? dp.totalCost : 0;
  }

  // ── Drawer fronts (priced like doors when drawers have a painted/finished door type) ──
  let drawerFrontsCost = 0;
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
      const dfp = calcDoorCost({ doorType, widthMm: frontW > 0 ? frontW : widthMm - 4, heightMm: fh, qty: 1, hingeCost: 0, handleCost: 0, sprayFinish: true, hasStain });
      if (dfp) drawerFrontsCost += dfp.totalCost;
    }
  }

  // ── Face frame ──────────────────────────────────────────────────────────
  const frameResult = calcCabinetFaceFrameCost({
    frameKey: frameKey || "FRAME_NONE",
    widthMm: widthMm, heightMm: heightMm, qty: 1
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
  }) : { costPerUnit: 0, total: 0, totalM: 0 };

  const totalCostPerUnit = carcassMaterialCost + carcassLabourCost + carcassHardware + doorsCost + drawersCost + drawerFrontsCost + frameResult.total + edgebandResult.total;
  const totalCost = totalCostPerUnit * qty;
  const sellExVAT = totalCost * DB.settings.margin;

  return {
    costPerUnit: totalCostPerUnit,
    sellPerUnit: totalCostPerUnit * DB.settings.margin,
    totalCost,
    totalSellExVAT: sellExVAT,
    totalSellIncVAT: sellExVAT * (1 + DB.settings.vat),
    breakdown: { carcassMaterial: carcassMaterialCost, carcassLabour: carcassLabourCost, carcassHardware, doors: doorsCost, drawers: drawersCost, drawerFronts: drawerFrontsCost, frame: frameResult.total, edgeband: edgebandResult.total, assemblyHrs },
  };
}

// ─── FACE FRAME COST (CABINET) ─────────────────────────────────────────────────
// Frame runs around the cabinet opening perimeter (2×W + 2×H), 30mm wide.
// Corner joints (pocket screw): add 0.1 hrs per corner (4 corners).
// Changes hinge from Blum cup to butt hinge — handled in priceItem hinge override.
function calcCabinetFaceFrameCost({ frameKey, widthMm, heightMm, qty = 1 }) {
  const fm = FRAME_MATERIALS[frameKey];
  if (!fm || fm.costPerM === 0) return { costPerUnit: 0, total: 0, perimM: 0 };
  const perimM = 2 * (widthMm + heightMm) / 1000;
  const cornerHrs = 4 * 0.10; // 4 corner joints
  const labourHrs = perimM * fm.labourHrsPerM + cornerHrs;
  const matCost   = perimM * fm.costPerM;
  const labourCost = labourHrs * er();
  const costPerUnit = matCost + labourCost;
  return { costPerUnit: +costPerUnit.toFixed(2), total: +(costPerUnit * qty).toFixed(2), perimM: +perimM.toFixed(3), labourHrs: +labourHrs.toFixed(3) };
}

// ─── EDGEBAND COST (CABINET) ───────────────────────────────────────────────────
// Applied to front edges of carcass panels when no face frame and material needs it.
// Edges: 2×height (sides) + 2×width (top+bottom) + width per shelf + width per drawer box.
function calcCabinetEdgebandCost({ edgebandKey, widthMm, heightMm, shelfCount = 0, drawerCount = 0, qty = 1 }) {
  const eb = EDGEBAND_TYPES[edgebandKey];
  if (!eb || eb.costPerM === 0) return { costPerUnit: 0, total: 0, totalM: 0 };
  // Carcass front perimeter + shelves + drawer box front edges
  const carcassM = 2 * (widthMm + heightMm) / 1000;
  const shelvesM = shelfCount * (widthMm / 1000);
  const drawersM = drawerCount * (widthMm / 1000);
  const totalM   = carcassM + shelvesM + drawersM;
  const labourHrs  = totalM * eb.labourHrsPerM;
  const matCost    = totalM * eb.costPerM;
  const labourCost = labourHrs * er();
  const costPerUnit = matCost + labourCost;
  return { costPerUnit: +costPerUnit.toFixed(2), total: +(costPerUnit * qty).toFixed(2), totalM: +totalM.toFixed(3) };
}

module.exports = { calcCabinetCost, DB, FRAME_MATERIALS, EDGEBAND_TYPES };
