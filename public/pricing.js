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
    // ── Handleless channel rail (cabinet param channelRails) — DECISION figures, Steve to confirm ──
    channelRailMinsPerM: 15,    // bench mins per metre of rail: cut, assemble and fix the profile
    channelRailSetupMins: 10,   // one setup per cabinet that has any rail (not per strip)
    // ── In-frame (cabinet param inframeFront) ─────────────────────────────────
    buttHingeHangMins: 30,      // bench mins to hang one in-frame door on butt hinges (Steve, 12 Nov 2026)
    // ── Cutlist (Steve, 12 Nov 2026). All sheet cutting is outsourced: Cutlist delivers every part cut, edged, drilled
    //    and jointed, ready to assemble, and charges about the sheet price again for it (sheet × 2 in total). So every
    //    board Cutlist supplies carries a cut = its sheet cost (board + waste: they charge whole sheets) × cutlistCut,
    //    on its own line (breakdown.cnc), never inside the material: carcass board, drawer box board, internal drawer
    //    fronts, end panels, fillers, sheet shelves, channel-rail board. NOT doors or external drawer fronts (made
    //    in-house), nor solid timber, face frames, veneer premiums, finishing or labour. Edging is inside the cut: no
    //    edging tape or labour is charged anywhere (EDGEBAND_TYPES). ──
    cutlistCut: 1,              // × the sheet cost. 1 = the sheet again; 0 = no cut
    // Bench time on a part that arrives cut and edged: sand, fit and finish prep only (each was cut + sand + edge band).
    endPanelBenchHrs: 0.25,     // per end panel (was 0.5 h)
    endPanelEdgeHrsPerM: 0,     // edge banding an end panel's exposed edges in-house, h per metre (was 0.04): 0, Cutlist edges it
    shelfBenchHrs: 0.25,        // per floating shelf (was 0.5 h); a box shelf's assembly and solid-timber prep are on top, as before
    fillerBenchHrs: 0.10,       // per filler (was 0.20 h)
    // ── Project-level cost defaults (all adjustable) ──────────────────────────
    surveyFee: 250,             // £ flat — site survey visit (per project)
    installDayRate: 350,        // £/day — billed PER FITTER per day on site
    fittingHoursPerPersonPerDay: 7.5,  // effective fitting hours per fitter per day (8h - 0.5h clean-down)
    deliveryFee: 200,           // £ flat — delivery & transport (per project)
    pmPercent: 6,               // % of mfg sell ex VAT — project management
    consumablesPerItem: 60,     // £ per line item — fixings, glue, abrasives
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
    "DRW_BIRCH_PLY": { name: "Birch Ply Box",    materialCostPer: 25, labourHrs: 0.5, sheetMaterial: true },   // (sheetMaterial: board Cutlist supplies, so it carries the Cutlist cut)
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
      // Push to open: one Blum Tip-On per front in place of a handle, plus its bench fitting (fitMins per front).
      // DECISION (Steve to confirm): a tall door (over ~1200 mm) gets one device, like any other front.
      "HW_HDL_PUSH":   { name: "Push to open (Blum Tip-On)", costEach: 10.00, fitMins: 10 },
    },
    // Bin pull-out frame, one per cabinet (cabinet param binFrameKey). fitMins: DECISION (Steve to confirm) —
    // 30, as the engine's drawer-runner prep (carcassDrawerPrepHrs 0.5 h).
    binFrames: {
      "HW_BIN_ECOTOP": { name: "Bin pull-out frame (Blum / LDL Ecotop)", costEach: 200.00, fitMins: 30 },
    },
    // Freestanding legs, 150 mm high, 45 mm square tapering to 28 mm, finished, with mounting plate (cabinet params
    // legKey + legCount). costEach and fitMins: DECISION (Steve to confirm).
    legs: {
      "HW_LEG_OAK_150": { name: "Tapered oak leg 150 mm",    costEach: 18.00, fitMins: 10 },
      "HW_LEG_WAL_150": { name: "Tapered walnut leg 150 mm", costEach: 24.00, fitMins: 10 },
    },
    // Soffit LED channel (item type soffit_led, one line per design) — every figure a DECISION, Steve to confirm.
    soffitLed: {
      extrusionLengthMm: 2000, extrusionCost: 18.00,  // recessed aluminium profile + opal diffuser, end caps, clips; bought in 2 m
      reelLengthM: 5,          reelCost: 35.00,       // 24 V COB tape, 5 m reel
      tapeWattsPerM: 10,
      driverHeadroom: 1.2,                            // driver sized for the tape's watts + 20%
      routeMinsPerM: 10,                              // rout the 18 × 8 groove, with set-out and clean-up
      drivers: {
        "DRV_24V_30W":  { name: "24 V LED driver 30 W",  watts: 30,  costEach: 18.00 },
        "DRV_24V_60W":  { name: "24 V LED driver 60 W",  watts: 60,  costEach: 24.00 },
        "DRV_24V_100W": { name: "24 V LED driver 100 W", watts: 100, costEach: 32.00 },
        "DRV_24V_150W": { name: "24 V LED driver 150 W", watts: 150, costEach: 45.00 },
      },
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

// ─── HANDLELESS CHANNEL PROFILES ──────────────────────────────────────────────
// The configurator's channel as built (its sabChannelMm, Steve's handleless sections): every piece is cut from the
// door board, T thick. Board girth of a rail = fixedMm + tCount × T. Floor and flange are 20 + T deep; the upright
// is 50 tall (70 on a tall split's C, which reaches 20 under and 20 over the 30 gap).
const CHANNEL_PROFILES = {
  "L":      { name: "Top channel rail (L)",  fixedMm: 70,  tCount: 1 },  // floor + upright 50
  "C":      { name: "Mid-rail C-channel",    fixedMm: 90,  tCount: 2 },  // floor + upright 50 + flange
  "TALL_C": { name: "Tall split C-channel",  fixedMm: 110, tCount: 2 },  // floor + upright 70 + flange
};

// ─── IN-FRAME (cabinet param inframeFront) ────────────────────────────────────
// inframeFront: { timber, thicknessMm, frameMm, hinges } — an in-frame cabinet as SAB builds it, priced from the
// rates already here: the face frame in the timber at frameMm (FRAME_TIM_*; timber "mdf": the MDF frame,
// FRAME_MDF_<frameMm>); a shaker door as the solid-timber shaker in that timber at thicknessMm; butt hinges unless
// hinges is "blum", each door hung at DB.settings.buttHingeHangMins; the fronts sized to the frame's opening; the
// frame finished as the doors are. No centre mullion on a pair of doors (Steve, 12 Nov 2026).
// Absent, a cabinet prices exactly as before. timber → its DB.solidTimber key:
const INFRAME_SPECIES = { tulipwood: "TIM_TUL", oak: "TIM_OAK", walnut: "TIM_WAL", maple: "TIM_MAPLE" };
// What an in-frame build is made of, by door profile and timber (Steve, 13 Nov 2026) — the calculator's defaults when
// In-frame is switched on; the configurator sends the same.
function inframeDefaults(slab, timber) {
  if (timber === "mdf") return { timber, thicknessMm: 22, frameMm: 22, hinges: "blum" };   // painted slab: 22 MDF, one piece, Blum
  return slab ? { timber, thicknessMm: 19, frameMm: 20, hinges: "butt" }                    // veneered slab in a 20 frame
              : { timber, thicknessMm: 28, frameMm: 28, hinges: "butt" };                   // solid shaker, 28 in 28
}

// ─── EDGEBAND TYPES ───────────────────────────────────────────────────────────
// Edging is Cutlist's (Steve, 12 Nov 2026): every part arrives edged, inside the Cutlist cut, so NOTHING is charged
// here — no tape, no labour. The tape is a specification only: the edge Cutlist is asked to apply, with its run in the
// materials list. (Before: oak veneer 0.85/m + 0.04 h/m, 2 mm oak 2.20 + 0.08, ABS 0.45 + 0.03, melamine 0.35 + 0.03,
// iron-on oak 0.75 + 0.03.)
const EDGEBAND_TYPES = {
  "EDGE_NONE":        { name: "None",                    costPerM: 0, labourHrsPerM: 0 },
  "EDGE_OAK_05":      { name: "0.5mm Oak Veneer",        costPerM: 0, labourHrsPerM: 0 },
  "EDGE_OAK_2MM":     { name: "2mm Solid Oak",           costPerM: 0, labourHrsPerM: 0 },
  "EDGE_ABS_PAINT":   { name: "Paintable ABS 0.4mm",     costPerM: 0, labourHrsPerM: 0 },
  "EDGE_MELAMINE":    { name: "Melamine Matching",       costPerM: 0, labourHrsPerM: 0 },
  "EDGE_IRON_OAK":    { name: "Iron-on Oak 0.5mm",       costPerM: 0, labourHrsPerM: 0 },
};

// Materials that DON'T need edgebanding (natural ply edge is fine / pre-edged)
const NO_EDGE_MATERIALS = new Set(["MAT_BIRCH_UNF_18","MAT_BIRCH_UNF_12","MAT_BIRCH_UNF_25"]);

// Settings are stored as the DIFF from these engine defaults (what the user changed),
// so a later engine default change still applies wherever the user hasn't overridden it.
const DB_DEFAULTS = JSON.parse(JSON.stringify(DB));

// Reset DB to the engine defaults, then deep-merge saved settings over them. Used by the
// browser (localStorage cache) and the server (shared settings row, /api/settings).
// Accepts a diff, or a legacy full-DB object from older localStorage.
function applySettings(saved) {
  for (const k of Object.keys(DB_DEFAULTS)) DB[k] = JSON.parse(JSON.stringify(DB_DEFAULTS[k]));
  (function deepMerge(target, source) {
    for (const key of Object.keys(source || {})) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
        deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  })(DB, saved);
}

// What the user changed: values in DB that differ from the defaults (known keys only).
function settingsDiff(cur = DB, def = DB_DEFAULTS) {
  const out = {};
  for (const k of Object.keys(def)) {
    const a = cur[k], b = def[k];
    if (b && typeof b === 'object') {
      const d = a && typeof a === 'object' ? settingsDiff(a, b) : {};
      if (Object.keys(d).length) out[k] = d;
    } else if (a !== undefined && a !== b) out[k] = a;
  }
  return out;
}

// Errors for a settings diff: only known keys, same type as the default, finite numbers.
function validateSettings(diff, def = DB_DEFAULTS, path = '') {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return [`${path || 'settings'} must be an object`];
  const errs = [];
  for (const [k, v] of Object.entries(diff)) {
    const p = path ? `${path}.${k}` : k;
    if (!Object.prototype.hasOwnProperty.call(def, k)) { errs.push(`unknown setting ${p}`); continue; }
    const d = def[k];
    if (d && typeof d === 'object') errs.push(...validateSettings(v, d, p));
    else if (typeof v !== typeof d || (typeof v === 'number' && !Number.isFinite(v))) errs.push(`${p} must be a ${typeof d === 'number' ? 'finite number' : typeof d}`);
  }
  return errs;
}

// Restore saved settings from localStorage (deep merge over defaults)
try {
  const saved = JSON.parse(localStorage.getItem('sab_db_settings'));
  if (saved) applySettings(saved);
} catch {}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = n => `£${(n || 0).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const er = () => DB.settings.labourRate + DB.settings.overheadRate; // effective hourly rate £87/hr
// The Cutlist cut of a board Cutlist supplies, from its sheet cost with waste (DB.settings.cutlistCut; 0 or unset = no cut).
const cncCut = sheetCost => sheetCost * Math.max(0, DB.settings.cutlistCut ?? 0);

function hingeCount(doorHeightMm) {
  if (doorHeightMm <= 900) return 2;
  if (doorHeightMm <= 1600) return 3;
  return 4;
}

// Effective design labour for a room, resolving blank inputs against the DB.settings
// defaults — the same numbers the UI shows. Returns the labour hours plus the
// effective tech-drawing days (resolved if blank). Single source for both the fee
// (below) and the read-only designHrs exposed by the API.
function calcDesignHrsPerRoom(roomData, s = DB.settings) {
  const rounds = roomData?.designRounds ?? s.designRoundsPerRoom;
  const hrsPerRound = roomData?.designHrsPerRound ?? s.designHoursPerRound;
  const techDays = roomData?.techDays ?? s.technicalDrawingDays;
  const designHrs = rounds * hrsPerRound + techDays * s.workingHoursPerDay;
  return { designHrs, techDays, rounds, hrsPerRound };
}

function calcDesignTimePerRoom(roomData, s = DB.settings) {
  const { designHrs } = calcDesignHrsPerRoom(roomData, s);
  const rate = roomData?.designRate ?? s.designHourlyRate;
  return designHrs * rate;
}

// ─── PROJECT COST DEFAULTS ────────────────────────────────────────────────────
// (Moved here from index.html so the SAME totals code runs in both the browser
// and on the server — see quoteTotals below.)
function getDefaultProjectCosts(s = DB.settings) {
  return {
    surveyFee:           s.surveyFee,           // £ flat
    installDaysByRoom:   {},                     // { [roomName]: days } — per-room fitting
    installDayRate:      s.installDayRate,       // £/day
    deliveryFee:         s.deliveryFee,          // £ flat
    pmPercent:           s.pmPercent,            // % of mfg sell ex VAT
    consumablesPerItem:  s.consumablesPerItem,   // £ per item
    contingencyPercent:  s.contingencyPercent,   // % of subtotal
    warrantyPercent:     s.warrantyPercent,      // % of subtotal
    // toggles
    includeSurvey:       true,
    includeInstall:      false,   // user enables once scope is known
    includeDelivery:     true,
    includePM:           true,
    includeConsumables:  true,
    includeContingency:  false,   // user enables for complex/risky jobs
    includeWarranty:     false,   // user enables as appropriate
  };
}

// Sum install days from per-room map. Falls back to legacy single `installDays`
// for quotes that haven't been migrated yet (read-side compatibility).
function totalInstallDays(pc) {
  if (pc && pc.installDaysByRoom && typeof pc.installDaysByRoom === "object") {
    return Object.values(pc.installDaysByRoom).reduce((s, n) => s + (Number(n) || 0), 0);
  }
  return Number(pc?.installDays) || 0;
}

// ─── PRICE LOCK ──────────────────────────────────────────────────────────────
// A locked quote (quote.pricingLock) never changes price because the engine or the
// Settings changed: its stored item pricing is final and its totals use the settings
// captured at lock time. Engine/Settings changes reach only new quotes, edited items
// and a deliberate "Reprice to current pricing…". Hours stay live (withPricingStatus).
// Bump ENGINE_VERSION with any pricing.js change that can move a price.
const ENGINE_VERSION = "2026-11-14";

// Short fingerprint (djb2) of the pricing tables + settings an item is priced with.
function settingsFingerprint() {
  const str = JSON.stringify(DB);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
// Items saved before the lock carry no stamp — they all count as one "saved" pricing.
const pricingId = pw => pw ? `${pw.engine}/${pw.settings}` : "saved";

const isPricingLock = l => !!(l && typeof l === "object" && l.settings && typeof l.settings === "object");

// ─── WEBSITE ORDERS (locked: true) ───────────────────────────────────────────
// A quote the configurator creates from a PAID website order: status "sold", source
// "configurator", locked: true, and the paid figures in `paid` { exVat, vat, gross,
// deposit, balance }. It is never priced, repriced or re-totalled — its totals ARE the
// paid figures. See docs/configurator-quotes.md.
const isLocked = q => !!(q && q.locked === true);
// All a write may still change on one: its folder (the status, the Deleted folder), the
// timestamps the app keeps, and the grand-total stamp — re-derived from `paid` on every
// write, so a retry of the configurator's create (sent without it) is the same quote.
// The server refuses anything else; the UI never sends it.
const LOCKED_EDITABLE = new Set(["status", "deleted", "deletedAt", "updated_at", "_serverUpdatedAt", "totalSellExVAT", "totalSellIncVAT"]);
// Workshop hours in an engine breakdown: every *Hrs / *Hours figure and the spray split.
const isHourKey = k => /(Hrs|Hours)$/.test(k) || k === "sprayDetail";
// Fields QC sets itself, once, when the order is created (onOrderCreate), by the key of the
// object holding them ("" = the quote itself): never compared, never taken from a write (lockedMerge).
const QC_OWNED = { "": k => k === "materialsBom", breakdown: isHourKey, projectCosts: k => k === "installDaysByRoom" };
// The first field `next` would change on website order `stored` that may not change, else
// null. Key order is ignored (Postgres JSONB re-orders keys), and so are QC_OWNED fields.
function lockedChange(stored, next) {
  const canon = v => JSON.stringify(v, (k, x) => {
    if (!x || typeof x !== "object" || Array.isArray(x)) return x;
    const owned = QC_OWNED[k];
    const keys = Object.keys(x).filter(key => !(owned && owned(key))).sort();
    return owned && !keys.length && Object.keys(x).length ? undefined : keys.reduce((o, key) => (o[key] = x[key], o), {}); // only QC's own = none
  });
  for (const k of new Set([...Object.keys(stored), ...Object.keys(next)]))
    if (!LOCKED_EDITABLE.has(k) && canon({ [k]: stored[k] }) !== canon({ [k]: next[k] })) return k;
  return null;
}
// An accepted write to a stored website order: the stored order, with only the editable
// fields taken from `next` — so everything else, its hours included, stays as stored.
function lockedMerge(stored, next) {
  const out = { ...stored };
  for (const k of LOCKED_EDITABLE) if (k in next) out[k] = next[k]; else delete out[k];
  return out;
}
// Once, when a website order is created: each item's workshop hours from the engine — the
// same breakdown figures a normal quote's items carry, and what the Orchestrator schedules
// from — written into item.pricing.breakdown. Prices are untouched; items with no hours
// (custom lines, fillers) are left exactly as sent.
function withWorkshopHours(quote) {
  const rooms = {};
  for (const [name, room] of Object.entries(quote.rooms || {})) {
    rooms[name] = { ...room, items: (room.items || []).map(item => {
      let bd = null;
      try { bd = (priceItemUnstamped(item) || {}).breakdown; } catch {}
      const hours = Object.fromEntries(Object.entries(bd || {}).filter(([k]) => isHourKey(k)));
      if (!Object.keys(hours).length || !item.pricing) return item;
      return { ...item, pricing: { ...item.pricing, breakdown: { ...(item.pricing.breakdown || {}), ...hours } } };
    }) };
  }
  return { ...quote, rooms };
}
// Everything QC derives for a website order, once, when it is created: the workshop hours;
// supply only — 0 install days for every room (what the Orchestrator's supply-only check
// reads; QC itself never stores an explicit 0 for an ordinary quote's room — note that check
// consults the Business API's fitting estimate first, which is never 0 days); and the
// materials list, the same quoteMaterialsBom GET adds to an ordinary quote (none → no field).
function onOrderCreate(quote) {
  const q = withWorkshopHours(quote);
  const installDaysByRoom = Object.fromEntries(Object.keys(q.rooms || {}).map(r => [r, 0]));
  return { ...q, projectCosts: { ...(q.projectCosts || {}), installDaysByRoom }, materialsBom: quoteMaterialsBom(quote) || undefined };
}

function lockQuote(quote) {
  return { ...quote, pricingLock: { engineVersion: ENGINE_VERSION, lockedAt: new Date().toISOString(), settings: JSON.parse(JSON.stringify(DB.settings)) } };
}

// Settings a quote's money is computed with: its lock snapshot, else the live settings.
function quoteSettings(quote) {
  return quote && isPricingLock(quote.pricingLock) ? { ...DB.settings, ...quote.pricingLock.settings } : DB.settings;
}

// Locked quote, new margin: rescale the frozen costs (sell = cost × margin) instead of
// re-running the engine. WRP (own markup) and fixed-price items are unaffected.
function rescaleMargin(quote, marginOverride) {
  const s = quoteSettings(quote);
  const m = marginOverride ?? s.margin;
  const rooms = {};
  for (const [name, room] of Object.entries(quote.rooms || {})) {
    rooms[name] = { ...room, items: (room.items || []).map(it => {
      const p = it.pricing;
      if (!p || it.fixedPrice || it.type === "wrp_moulding") return it;
      return { ...it, pricing: { ...p, sellPerUnit: p.costPerUnit * m, totalSellExVAT: p.totalCost * m, totalSellIncVAT: p.totalCost * m * (1 + s.vat) } };
    }) };
  }
  return { ...quote, marginOverride, rooms };
}

// ─── QUOTE TOTALS ─────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for a quote's grand total — the exact figure the
// calculator shows at the bottom of a quote (and per-quote in the list view).
// Browser calls it as a window global; the server requires it to persist the
// total onto the quote record (see quoteGrandTotal). Keep DOM/React free.
function quoteTotals(quote) {
  // Website order: the paid figures, exactly — never derived from the items.
  if (isLocked(quote)) {
    const p = quote.paid || {};
    let mfgCost = 0;
    Object.values(quote.rooms || {}).forEach(room => (room.items || []).forEach(item => { mfgCost += item.pricing?.totalCost || 0; }));
    return {
      mfgCost, mfgSellExVAT: p.exVat, designFee: 0,
      survey: 0, install: 0, delivery: 0, pm: 0, consumables: 0, contingency: 0, warranty: 0,
      totalExVAT: p.exVat, vat: p.vat, totalIncVAT: p.gross,
      margin: mfgCost > 0 ? p.exVat / mfgCost : 0,
    };
  }
  const s = quoteSettings(quote); // locked quotes: the settings captured at lock time
  let mfgCost = 0, mfgSellExVAT = 0, designFee = 0;
  // nonFixed* track items that participate in margin/overhead allocation
  // (i.e. exclude fixed-price pass-through items). PM% is applied against the
  // non-fixed manufacturing sell value so fixed items don't inflate the PM fee.
  let nonFixedSellExVAT = 0;
  Object.values(quote.rooms || {}).forEach(room => {
    room.items.forEach(item => {
      mfgCost += item.pricing?.totalCost || 0;
      mfgSellExVAT += item.pricing?.totalSellExVAT || 0;
      if (!item.fixedPrice) nonFixedSellExVAT += item.pricing?.totalSellExVAT || 0;
    });
    if (room.includeDesignTime !== false) designFee += calcDesignTimePerRoom(room, s);
  });

  // Project-level costs
  const pc = quote.projectCosts || getDefaultProjectCosts(s);
  // Fixed-price items don't consume a consumables-per-item slot.
  const totalItems = Object.values(quote.rooms || {}).reduce((sum, r) => sum + r.items.filter(i => !i.fixedPrice).length, 0);

  const survey      = pc.includeSurvey       ? (pc.surveyFee          ?? s.surveyFee)          * s.margin : 0;
  const install     = pc.includeInstall      ? totalInstallDays(pc) * (pc.installDayRate ?? s.installDayRate) * s.margin : 0;
  const delivery    = pc.includeDelivery     ? (pc.deliveryFee        ?? s.deliveryFee)         * s.margin : 0;
  const pm          = pc.includePM           ? nonFixedSellExVAT * ((pc.pmPercent         ?? s.pmPercent)        / 100) : 0;
  const consumables = pc.includeConsumables  ? totalItems   * (pc.consumablesPerItem ?? s.consumablesPerItem) : 0;

  const subtotalBeforeContingency = mfgSellExVAT + designFee + survey + install + delivery + pm + consumables;
  const contingency = pc.includeContingency ? subtotalBeforeContingency * ((pc.contingencyPercent ?? s.contingencyPercent) / 100) : 0;
  const subtotalBeforeWarranty    = subtotalBeforeContingency + contingency;
  const warranty    = pc.includeWarranty    ? subtotalBeforeWarranty   * ((pc.warrantyPercent    ?? s.warrantyPercent)    / 100) : 0;

  const totalExVAT = subtotalBeforeWarranty + warranty;
  const vat        = totalExVAT * s.vat;
  return {
    mfgCost, mfgSellExVAT, designFee,
    survey, install, delivery, pm, consumables, contingency, warranty,
    totalExVAT, vat, totalIncVAT: totalExVAT + vat,
    margin: mfgCost > 0 ? mfgSellExVAT / mfgCost : 0,
  };
}

// Canonical grand-total for a whole quote, rounded to pennies exactly as the UI
// displays it (fmt() shows 2dp). This is the figure persisted onto the quote
// record and served by the API so downstream consumers (the client portal /
// orchestrator) don't have to re-derive project-level costs themselves.
function quoteGrandTotal(quote) {
  const round2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  const t = quoteTotals(quote);
  return {
    totalSellExVAT:  round2(t.totalExVAT),
    totalSellIncVAT: round2(t.totalIncVAT),
  };
}

// ─── MARGIN (internal, display only — the Margin page) ───────────────────────
// Every line of the quote's total ex VAT, with what it costs. Manufacturing: the engine's real cost. Every project line
// (design, survey, installation, delivery, PM, consumables, contingency, warranty) is ASSUMED to cost half of what is
// charged — a 50% margin, like the manufacturing lines (Steve, 13 Nov 2026) — until a real cost is recorded on the
// quote: quote.actualCosts[key], £ ex VAT, absent = none. A recorded cost replaces the assumption on that line only.
// Reads quoteTotals; never changes a price, a total or the quote.
const ADDON_ASSUMED_COST_SHARE = 0.5;
const MARGIN_LINES = [   // [key (actualCosts key), label, quoteTotals field]
  ["mfg", "Manufacturing (incl. spray finishing)", "mfgSellExVAT"], ["design", "Design & drawing", "designFee"],
  ["survey", "Site survey", "survey"], ["install", "Installation", "install"], ["delivery", "Delivery", "delivery"],
  ["pm", "Project management", "pm"], ["consumables", "Consumables", "consumables"],
  ["contingency", "Contingency", "contingency"], ["warranty", "Warranty & aftercare", "warranty"],
];
const isActualCost = v => typeof v === "number" && Number.isFinite(v) && v >= 0;
function quoteMargin(quote) {
  const t = quoteTotals(quote), recorded = (quote && quote.actualCosts) || {};
  const lines = MARGIN_LINES.map(([key, label, field]) => {
    const charged = t[field] || 0;
    const assumedCost = key === "mfg" ? t.mfgCost : charged * ADDON_ASSUMED_COST_SHARE;
    const actualCost = key !== "mfg" && isActualCost(recorded[key]) ? recorded[key] : null;
    const cost = actualCost ?? assumedCost;
    return { key, label, charged, assumedCost, actualCost, cost, margin: charged - cost,
      basis: key === "mfg" ? "engine" : actualCost !== null ? "actual" : "assumed" };
  });
  // (The lines' charged amounts add up to totalExVAT, so each figure is the sum of the lines' margins.)
  const figure = costOf => { const cost = lines.reduce((s, l) => s + costOf(l), 0), amount = t.totalExVAT - cost;
    return { cost, amount, pct: t.totalExVAT ? amount / t.totalExVAT : 0 }; };
  return {
    lines, totalExVAT: t.totalExVAT, vat: t.vat, totalIncVAT: t.totalIncVAT,
    grossMargin: figure(l => l.assumedCost),                                                  // every add-on at 50%
    withActual: lines.some(l => l.actualCost !== null) ? figure(l => l.cost) : null,          // recorded costs where there are any
    mfgProfit: t.mfgSellExVAT - t.mfgCost,                                                    // manufacturing sell − cost
  };
}

// ─── PRICING ENGINE ───────────────────────────────────────────────────────────

// Spray-finish hours split (sprayDetail). Named steps, in shop order; handlingHrs —
// setup (hanging, masking, repositioning) plus 3dp rounding — is the remainder, so the
// parts always add up exactly to the total. Read-only output: no price depends on it.
const SPRAY_STEP_KEYS = ["caulkHrs", "stainHrs", "primerHrs", "topCoatHrs", "lacquerHrs", "edgePolishHrs"];
const sprayHandlingHrs = (bd, totalHrs) => +(totalHrs - SPRAY_STEP_KEYS.reduce((s, k) => s + (bd[k] || 0), 0)).toFixed(3);
// Sum [sprayBreakdown, multiplier] pairs into one split that adds up to totalHrs.
function sprayHrsSplit(totalHrs, parts) {
  const out = {};
  for (const [bd, n] of parts) for (const k of SPRAY_STEP_KEYS) if (bd && bd[k]) out[k] = +((out[k] || 0) + bd[k] * n).toFixed(3);
  out.handlingHrs = sprayHandlingHrs(out, totalHrs);
  out.totalHrs = totalHrs;
  return out;
}

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
    return { costPerDoor: 0, total: 0, breakdown: { totalHrs: 0, labourCost: 0, boothCost: 0, matCost: 0, note: "no finish required", handlingHrs: 0 } };
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
      breakdown: { totalHrs: +totalHrs.toFixed(3), labourCost: +labourCost.toFixed(2), boothCost: 0, matCost: +matCost.toFixed(2), perimM: +perimM.toFixed(3), note: "edge polish only", edgePolishHrs: +totalHrs.toFixed(3), handlingHrs: 0 },
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
    breakdown: { ...bd, totalHrs: +totalHrs.toFixed(3), labourCost: +labourCost.toFixed(2), boothCost: +boothCost.toFixed(2), matCost: +matCost.toFixed(2),
      handlingHrs: sprayHandlingHrs(bd, +totalHrs.toFixed(3)) },
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
  // (No Cutlist cut on a door or an external drawer front: they are made in-house — Steve, 12 Nov 2026.)
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

// A drawer box's height inside a cabinet (the box only: an external front is sized from the cabinet; an internal
// drawer's plain front is this high unless its own height is sent).
const DRAWER_BOX_HEIGHT_MM = 180;

// drawerType unset: the sheet box in the carcass board (as the calculator's own forms default) — it was no price at all.
function calcDrawerCost({ drawerType, widthMm = 500, heightMm = 200, depthMm = 500, qty = 1, runnerCostOverride = null, carcassMaterialKey = null, margin = DB.settings.margin }) {
  const dt = DB.drawerTypes[drawerType || "DRW_SHEET"];
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
  // A box in board Cutlist supplies (the sheet box, the ply box) carries the Cutlist cut; a solid-timber box does not.
  const cncCost = (dt.usesCarcassMaterial || dt.sheetMaterial) ? cncCut(materialCost) : 0;
  const totalCostPerDrawer = materialCost + labourCost + runnerCost + cncCost;
  const sellExVAT = totalCostPerDrawer * margin;
  return {
    costPerUnit: totalCostPerDrawer,
    sellPerUnit: sellExVAT,
    totalCost: totalCostPerDrawer * qty,
    totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { materialCost, labourCost, runnerCost,
      ...(cncCost ? { cnc: cncCost } : {}),  // the Cutlist cut of the box's board, per drawer
      drawerHrs: dt.labourHrs,              // drawer-box-making labour, person-hours per unit
      totalHrs: +(+dt.labourHrs).toFixed(3) },
  };
}

function calcCabinetCost({
  widthMm, heightMm, depthMm,
  carcassMaterialKey = "MAT_BIRCH_UNF_18",
  carcassFinish = "none",
  carcassFinishOutside = false,   // also finish the shell's outer faces (sides, top, bottom) — an open painted unit
  backMaterialKey,  // defaults to carcassMaterialKey below — backs match the carcass material

  doorCount = 2, doorType = "SLAB_PNT",
  doorHeightsMm,          // actual height of each door leaf (doorCount leaves across, in rows); absent: carcass height − 6
  drawerCount = 0, drawerType,   // unset: DRW_SHEET, the sheet box in this cabinet's carcass board (it was the birch ply box)
  drawerPosition = "external",   // "internal": drawers behind doors — a plain front in the carcass board, not one in the door finish
  drawerBoxMaterialKey,          // the board of a sheet drawer box and of an internal front; absent: the carcass board
  drawerFrontHeightsMm,   // actual height of each drawer front, one per drawer; absent: an equal share
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
  channelRails,     // handleless channel rails per metre: { materialKey, finishType?, thicknessMm?, rails: [{ profile, lengthMm }] }
  binFrameKey,      // bin pull-out frame (DB.hardware.binFrames), one per cabinet
  legKey, legCount, // freestanding legs (DB.hardware.legs); count defaults to 4, 6 over 1200 wide
  inframeFront,     // in-frame build: { timber, thicknessMm, frameMm, hinges } — see INFRAME_SPECIES
  qty = 1,
  margin = DB.settings.margin,
}) {
  if (!drawerType) drawerType = "DRW_SHEET";
  // ── In-frame: the frame, hinge and door the build is made of, from the existing tables ──
  if (inframeFront) {
    const species = INFRAME_SPECIES[inframeFront.timber];   // undefined: an MDF frame
    frameKey = species ? `FRAME_${species}` : `FRAME_MDF_${inframeFront.frameMm}`;
    frameThicknessMm = inframeFront.frameMm;
    if (inframeFront.hinges !== "blum") hingeKey = "HW_HINGE_BUTT";
    if (species) {
      // A shaker door in-frame is solid timber: the solid-timber shaker of the same finish, in the frame's timber.
      const dt = DB.doorTypes[doorType];
      if (dt && dt.hasQuirk && !dt.pricingMode) doorType = dt.finishType === "paint" ? "SHAKER_TIM_PNT" : "SHAKER_TIM_LAC";
      timberSpeciesKey = species;
      doorFrameThicknessMm = inframeFront.thicknessMm;
    }
  }
  // In-frame, the fronts sit inside the frame's opening: a frame member less on each side (0 for lay-on).
  const frameInsetMm = inframeFront ? 2 * (frameMemberWidthMm ?? 30) : 0;

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
  // The Cutlist cut of every board of this cabinet that Cutlist supplies, gathered on its own line (breakdown.cnc):
  // the carcass, the drawer boxes, internal drawer fronts and channel-rail board — each of those lines is WITHOUT its
  // cut. Doors, external drawer fronts and face frames are made in-house: no cut.
  let cncCost = cncCut(carcassMaterialCost);
  // The board of a sheet drawer box and of an internal drawer's plain front: the carcass board unless one is named.
  const boxKey = drawerBoxMaterialKey && DB.materials[drawerBoxMaterialKey] ? drawerBoxMaterialKey : carcassMaterialKey;
  const boxMat = DB.materials[boxKey];

  // Assembly labour: scale from DB.settings.carcassBaseHrs for a reference 600×720×560 cabinet
  const refSurfMM2 = 2*(720*560) + 2*(600*560) + 600*720; // 1,910,400 mm²
  const cabSurfMM2 = 2*(heightMm*depthMm) + 2*(widthMm*depthMm) + widthMm*heightMm;
  const scale = Math.sqrt(cabSurfMM2 / refSurfMM2);
  const assemblyHrs = (DB.settings.carcassBaseHrs * scale) + (shelfCount * DB.settings.carcassShelfHrs) + (drawerCount > 0 ? DB.settings.carcassDrawerPrepHrs : 0);
  const carcassLabourCost = assemblyHrs * er();
  const carcassHardware = 8 + shelfCount * 1.50; // cam bolts, shelf pins, etc.

  // Handle used across doors AND drawer fronts (one handle per panel). Resolved at
  // cabinet scope so drawer-only cabinets are also charged for their handles.
  const handle = DB.hardware.handles[handleKey] || DB.hardware.handles["HW_HDL_BAR128"];
  // A handle that needs bench fitting (push to open's Tip-On) carries that labour on each front's handle cost.
  const handleFitHrs = (handle.fitMins || 0) / 60;
  const handleCostPerFront = handle.costEach + handleFitHrs * er();

  // Doors (cost only, margin applied to cabinet total)
  let doorsCost = 0;
  let doorHrs = 0;       // door-making labour, person-hours per cabinet (all doors)
  let doorFinishHrs = 0; // spray finishing labour on doors, person-hours per cabinet
  const doorSprays = []; // [per-door spray breakdown, leaves] per leaf height (sprayDetail split)
  // BOM quantities (per single cabinet — multiplied by qty at the return). These are
  // the SAME geometry the costing above uses, surfaced for the read-only materials BOM.
  let doorAreaM2 = 0;   // total door face area (m²)
  let hingeUnits = 0;   // hinges consumed (matches the hinges priced)
  let doorLeaves = 0;   // door leaves priced
  if (doorCount > 0 && doorType && DB.doorTypes[doorType]) {
    const doorW = Math.floor((widthMm - frameInsetMm) / doorCount) - 2;   // doorCount leaves across (in-frame: the opening)
    const hinge = DB.hardware.hinges[hingeKey] || DB.hardware.hinges["HW_HINGE_SM"];
    // Leaf heights: each leaf's actual height when given (doorHeightsMm — handleless fronts, a split tall's leaves
    // one over the other), else doorCount leaves at the carcass height less 6. Leaves of one height price together.
    const leavesByHeight = new Map();
    const actual = Array.isArray(doorHeightsMm) && doorHeightsMm.length > 0;
    if (actual) for (const h of doorHeightsMm) leavesByHeight.set(h, (leavesByHeight.get(h) || 0) + 1);
    else leavesByHeight.set(heightMm - frameInsetMm - 6, doorCount);
    doorLeaves = actual ? doorHeightsMm.length : doorCount;
    for (const [doorH, n] of leavesByHeight) {
      const dp = calcDoorCost({ doorType, widthMm: doorW, heightMm: doorH, qty: n, hingeCost: hingeCount(doorH) * hinge.costEach, handleCost: handleCostPerFront, hasStain, sprayFinishOverride,
        timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey,
        frameStileWidthMm, frameThicknessMm: doorFrameThicknessMm });
      if (!dp) continue;
      doorsCost += dp.totalCost;
      doorHrs += dp.breakdown.doorHrs * n;
      doorFinishHrs += dp.breakdown.finishHrs * n;
      doorSprays.push([dp.breakdown.sprayDetail, n]);
      doorAreaM2 += (doorW / 1000) * (doorH / 1000) * n;
      hingeUnits += hingeCount(doorH) * n;
    }
  }

  // Drawers (cost only)
  let drawersCost = 0;
  let drawerHrs = 0; // drawer-box-making labour, person-hours per cabinet (all drawers)
  if (drawerCount > 0 && drawerType && DB.drawerTypes[drawerType]) {
    const runner = DB.hardware.runners[runnerKey] || DB.hardware.runners["HW_RUN_BLUM_SM"];
    const dp = calcDrawerCost({ drawerType, widthMm: widthMm - 26, heightMm: DRAWER_BOX_HEIGHT_MM, depthMm: depthMm - 50, qty: drawerCount, runnerCostOverride: runner.costPair, carcassMaterialKey: boxKey });
    const boxCnc = dp ? (dp.breakdown.cnc || 0) * drawerCount : 0;
    drawersCost = dp ? dp.totalCost - boxCnc : 0;
    cncCost += boxCnc;
    drawerHrs = dp ? dp.breakdown.drawerHrs * drawerCount : 0;
  }

  // ── Drawer fronts — a cost of their own, apart from the boxes above (breakdown.drawers / .drawerFronts).
  //    External (the default): a front in the door finish, priced like a door.
  //    Internal (drawerPosition "internal" — drawers behind doors): a plain front in the box's board (the CARCASS
  //    board unless drawerBoxMaterialKey names one), its sheet and the Cutlist cut of it only: no door finish, no spray,
  //    no handle, no making labour (it goes on with the box, inside the box's assembly time). ──
  let drawerFrontsCost = 0;
  let drawerFrontHrs = 0;       // drawer-front-making labour (made like doors), per cabinet
  let drawerFrontFinishHrs = 0; // spray finishing labour on drawer fronts, per cabinet
  let drawerFrontAreaM2 = 0;    // total drawer-front face area (m²) — same doorType as the doors
  let internalFrontSheetM2 = 0; // plain internal fronts: carcass board to order, waste included (BOM: with the carcass)
  const frontSprays = [];       // [spray breakdown, 1] per drawer front (sprayDetail split)
  const drawerFrontHeights = [];  // external fronts only (each is a handle position and a door-finish panel)
  if (drawerCount > 0 && drawerPosition === "internal") {
    // Each front the opening wide (between the carcass sides, less the 4 an external front leaves) and its own
    // height when sent (drawerFrontHeightsMm), else the box's.
    const frontW = Math.max(0, widthMm - 2 * t - 4);
    const heights = Array.isArray(drawerFrontHeightsMm) && drawerFrontHeightsMm.length > 0 ? drawerFrontHeightsMm : Array(drawerCount).fill(DRAWER_BOX_HEIGHT_MM);
    for (const fh of heights) internalFrontSheetM2 += (frontW / 1000) * (fh / 1000) * (boxMat.wasteFactor || 1.15);
    drawerFrontsCost = internalFrontSheetM2 * boxMat.costPerM2;
    cncCost += cncCut(drawerFrontsCost);
  } else if (drawerCount > 0 && doorType && DB.doorTypes[doorType]) {
    // Each front's actual height when given (drawerFrontHeightsMm — handleless fronts), else an equal share.
    if (Array.isArray(drawerFrontHeightsMm) && drawerFrontHeightsMm.length > 0) drawerFrontHeights.push(...drawerFrontHeightsMm);
    else {
      const topRailMm = 32;
      const gapMm = 3;
      const usableHeight = heightMm - (inframeFront ? frameInsetMm : topRailMm);
      const totalGaps = gapMm * (drawerCount - 1);
      const availableHeight = usableHeight - totalGaps;
      const defaultFrontH = Math.round(availableHeight / drawerCount);
      for (let i = 0; i < drawerCount; i++) drawerFrontHeights.push(defaultFrontH);
    }
    const frontW = widthMm - frameInsetMm - 4; // drawer fronts span full cabinet width (in-frame: the opening)
    const effFrontW = frontW > 0 ? frontW : widthMm - 4;
    for (const fh of drawerFrontHeights) {
      // One handle per drawer front (no hinges — fronts run on the drawer runners).
      const dfp = calcDoorCost({ doorType, widthMm: effFrontW, heightMm: fh, qty: 1, hingeCost: 0, handleCost: handleCostPerFront, sprayFinish: true, hasStain, sprayFinishOverride,
        timberSpeciesKey, timberCustomSpeciesName, timberCustomPricePerM3, panelMaterialKey,
        frameStileWidthMm, frameThicknessMm: doorFrameThicknessMm });
      if (dfp) {
        drawerFrontsCost += dfp.totalCost;
        drawerFrontHrs += dfp.breakdown.doorHrs;
        drawerFrontFinishHrs += dfp.breakdown.finishHrs;
        frontSprays.push([dfp.breakdown.sprayDetail, 1]);
        drawerFrontAreaM2 += (effFrontW / 1000) * (fh / 1000);
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
  // In-frame, the frame is finished as the doors are — its face (run × member width) and the reveal the doors sit
  // in (run) — at the spray rates. A frame without inframeFront carries no finish, as before.
  let frameFinishCost = 0, frameFinishHrs = 0, frameSpray = null;
  if (inframeFront && frameResult.perimM > 0) {
    const fin = sprayFinishOverride || DB.doorTypes[doorType]?.finishType || "paint";
    const ff = calcSprayFinishCost({ doorType: null, widthMm, heightMm, qty: 1, finishType: fin === "oil" ? "lacquer" : fin, hasStain, surfaceType: "panel",
      sprayAreaM2Override: frameResult.perimM * (frameMemberWidthMm ?? 30) / 1000, perimMOverride: frameResult.perimM });
    frameFinishCost = ff.costPerDoor;
    frameFinishHrs  = ff.breakdown.totalHrs;
    frameSpray      = ff.breakdown;
  }

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
  let carcassSpray = null;
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
      // Inside and out (an open unit's "match doors" painted carcass): the outer faces of the sides, top and
      // bottom too. Not the back's outer face, which is against the wall.
      if (carcassFinishOutside) sprayAreaM2Override += sidesArea + topBotArea;
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
    carcassSpray      = cf ? cf.breakdown : null;
  }

  // (Filler items are now top-level items priced independently — see calcFillerCost.
  // Any legacy fillerCount on cabinet items is migrated to separate filler items at
  // quote-load time via migrateLegacyFillers.)

  // ── Handleless channel rails, per metre (its own line, channelRail) ──
  const rail = channelRails ? calcChannelRailCost(channelRails) : null;
  if (rail) cncCost += cncCut(rail.material);   // the rails' board is Cutlist's
  const channelRailCost = rail ? rail.cost : 0;
  const railFinishHrs   = rail ? rail.finishHrs : 0;

  // ── Bin pull-out frame: the frame + its bench fitting (its own line, binFrame) ──
  const binFrame = binFrameKey ? DB.hardware.binFrames[binFrameKey] : null;
  const binFrameFitHrs = binFrame ? binFrame.fitMins / 60 : 0;
  const binFrameCost = binFrame ? binFrame.costEach + binFrameFitHrs * er() : 0;

  // ── Freestanding legs: per leg + its bench fitting (its own line, legs). The engine charges no plinth. ──
  const leg = legKey ? DB.hardware.legs[legKey] : null;
  const legs = leg ? (legCount ?? (widthMm > 1200 ? 6 : 4)) : 0;
  const legFitHrs = leg ? legs * leg.fitMins / 60 : 0;
  const legsCost = leg ? legs * leg.costEach + legFitHrs * er() : 0;

  // ── In-frame doors on butt hinges: the bench time to hang each leaf (its own line, hanging) ──
  const hangHrs  = inframeFront && inframeFront.hinges !== "blum" ? doorLeaves * DB.settings.buttHingeHangMins / 60 : 0;
  const hangCost = hangHrs * er();

  const totalCostPerUnit = carcassMaterialCost + carcassLabourCost + carcassHardware + carcassFinishCost + doorsCost + drawersCost + drawerFrontsCost + frameResult.total + edgebandResult.total + channelRailCost + binFrameCost + legsCost + frameFinishCost + hangCost + cncCost;
  const totalCost = totalCostPerUnit * qty;
  const sellExVAT = totalCost * margin;

  // ── Labour hours roll-up, person-hours per cabinet (additive, for production scheduling) ──
  const frameHrs    = frameResult.labourHrs || 0;     // face-frame-making labour
  const edgebandHrs = edgebandResult.labourHrs || 0;  // edgebanding labour
  const finishHrs   = doorFinishHrs + drawerFrontFinishHrs + carcassFinishHrs + railFinishHrs + frameFinishHrs; // total spray finishing labour (doors + fronts + carcass shell + channel rails + an in-frame face frame)
  // Bench fitting of hardware: push-to-open devices (cost in the fronts' handle cost), the bin frame and legs.
  const frontCount  = doorLeaves + drawerFrontHeights.length;
  const hardwareFitHrs = frontCount * handleFitHrs + binFrameFitHrs + legFitHrs;
  const channelRailHrs = rail ? rail.benchHrs : 0;   // channel rail bench labour (its spray is in finishHrs)
  const totalHrs    = +(assemblyHrs + doorHrs + drawerHrs + drawerFrontHrs + frameHrs + edgebandHrs + finishHrs + hardwareFitHrs + channelRailHrs + hangHrs).toFixed(3);
  // finishHrs split by step, and by part (carcass / door / drawerFront / channelRail / frame) — parts present only when finished.
  const sprayParts = {};
  if (carcassFinishHrs > 0)     sprayParts.carcass     = sprayHrsSplit(carcassFinishHrs, [[carcassSpray, 1]]);
  if (doorFinishHrs > 0)        sprayParts.door        = sprayHrsSplit(doorFinishHrs, doorSprays);
  if (drawerFrontFinishHrs > 0) sprayParts.drawerFront = sprayHrsSplit(drawerFrontFinishHrs, frontSprays);
  if (railFinishHrs > 0)        sprayParts.channelRail = sprayHrsSplit(railFinishHrs, rail.sprays);
  if (frameFinishHrs > 0)       sprayParts.frame       = sprayHrsSplit(frameFinishHrs, [[frameSpray, 1]]);
  const sprayDetail = { ...sprayHrsSplit(finishHrs, Object.values(sprayParts).map(p => [p, 1])), parts: sprayParts };

  // ── Bill of materials (read-only, additive) ───────────────────────────────
  // The MATERIAL QUANTITIES already computed above, surfaced per cabinet so the
  // read API can aggregate exact order quantities that never disagree with the
  // price. All quantities are scaled by qty (the priced figures are per-unit).
  // Keys are the canonical MAT_*/HW_*/FRAME_*/EDGE_*/door-type codes.
  const r4 = n => +(n || 0).toFixed(4);
  const r3 = n => +(n || 0).toFixed(3);
  const carcassKey = carcassMaterialKey;
  const backKey    = backMaterialKey || carcassMaterialKey;
  // Merge main + back when they share a material key (backs default to the carcass).
  const bomCarcass = [];
  const addCarcass = (key, area) => {
    const e = bomCarcass.find(x => x.key === key);
    if (e) e.areaM2 = r4(e.areaM2 + area); else bomCarcass.push({ key, areaM2: r4(area) });
  };
  addCarcass(carcassKey, mainArea * qty);
  if (internalFrontSheetM2 > 0) addCarcass(boxKey, internalFrontSheetM2 * qty);
  if (backArea > 0) addCarcass(backKey, backArea * qty);
  // Doors + drawer fronts share the door type (both made & finished like doors).
  const bomDoors = [];
  const doorPanels = doorLeaves + drawerFrontHeights.length;
  const doorPanelArea = doorAreaM2 + drawerFrontAreaM2;
  if (doorType && DB.doorTypes[doorType] && doorPanels > 0) {
    bomDoors.push({ key: doorType, count: doorPanels * qty, areaM2: r4(doorPanelArea * qty) });
  }
  const bomDrawerBoxes = (drawerCount > 0 && drawerType && DB.drawerTypes[drawerType])
    ? [{ key: drawerType, count: drawerCount * qty }] : [];
  const bomFrames = (frameKey && frameKey !== "FRAME_NONE" && FRAME_MATERIALS[frameKey] && frameResult.perimM > 0)
    ? [{ key: frameKey, linealM: r3(frameResult.perimM * qty) }] : [];
  const bomEdgeband = (needsEdgeband && edgebandResult.totalM > 0)
    ? [{ key: edgebandKey || "EDGE_ABS_PAINT", linealM: r3(edgebandResult.totalM * qty) }] : [];
  const bomHardware = [];
  if (hingeUnits > 0 && hingeKey && hingeKey !== "HW_HINGE_NONE") bomHardware.push({ key: hingeKey, count: hingeUnits * qty });
  if (drawerCount > 0 && drawerType && DB.drawerTypes[drawerType] && runnerKey) bomHardware.push({ key: runnerKey, count: drawerCount * qty });
  if (binFrame) bomHardware.push({ key: binFrameKey, count: qty });
  if (leg && legs > 0) bomHardware.push({ key: legKey, count: legs * qty });
  // Handles — reported as door + drawer POSITIONS regardless of whether a handle is
  // priced (handleKey is often HW_HDL_NONE: bought separately / client's choice). Split
  // by target so a different handle type can be assigned to doors vs drawers downstream.
  // When a real handle IS selected it's also charged in the price (calcDoorCost calls
  // above) on the same positions — one source of truth for the priced case.
  const bomHandles = [];
  const doorHandlePositions   = doorLeaves;
  const drawerHandlePositions = drawerFrontHeights.length;
  if (doorHandlePositions > 0)   bomHandles.push({ key: handleKey, target: "door",   count: doorHandlePositions * qty });
  if (drawerHandlePositions > 0) bomHandles.push({ key: handleKey, target: "drawer", count: drawerHandlePositions * qty });

  return {
    costPerUnit: totalCostPerUnit,
    sellPerUnit: totalCostPerUnit * margin,
    totalCost,
    totalSellExVAT: sellExVAT,
    totalSellIncVAT: sellExVAT * (1 + DB.settings.vat),
    breakdown: { carcassMaterial: carcassMaterialCost, carcassLabour: carcassLabourCost, carcassHardware, doors: doorsCost, drawers: drawersCost, drawerFronts: drawerFrontsCost, frame: frameResult.total, edgeband: edgebandResult.total,
      ...(rail ? { channelRail: channelRailCost, channelRailHrs: +channelRailHrs.toFixed(3) } : {}),
      ...(binFrame ? { binFrame: binFrameCost } : {}),
      ...(leg ? { legs: legsCost } : {}),
      ...(inframeFront ? { frameFinish: frameFinishCost, frameFinishHrs, hanging: hangCost, hangHrs } : {}),
      ...(cncCost ? { cnc: cncCost } : {}),   // the Cutlist cut of every board of the cabinet Cutlist supplies — in no other line
      assemblyHrs, doorHrs, drawerHrs, drawerFrontHrs, frameHrs, edgebandHrs, carcassFinishHrs: +carcassFinishHrs.toFixed(3), finishHrs,
      ...(hardwareFitHrs > 0 ? { hardwareFitHrs: +hardwareFitHrs.toFixed(3) } : {}), totalHrs, sprayDetail,
      bom: { carcass: bomCarcass, doors: bomDoors, drawerBoxes: bomDrawerBoxes, frames: bomFrames, edgeband: bomEdgeband, hardware: bomHardware, handles: bomHandles } },
  };
}

function calcEndPanelCost({ materialKey, widthMm, heightMm, thicknessMm = 18, faces = 1, exposedEdgeCount = 2, finishType = "paint", hasStain = false, qty = 1, margin = DB.settings.margin }) {
  const mat = DB.materials[materialKey];
  if (!mat) return null;
  const areaM2  = (widthMm / 1000) * (heightMm / 1000);
  const matCost = areaM2 * mat.costPerM2 * (mat.wasteFactor || 1.12);
  // Labour: the panel arrives from Cutlist cut and edged — bench time is sand, fit and finish prep only
  // (DB.settings.endPanelBenchHrs). Its exposed edges cost nothing more: the edging is inside the Cutlist cut
  // (endPanelEdgeHrsPerM is 0).
  const perimM     = 2 * (widthMm + heightMm) / 1000;
  const labourHrs  = DB.settings.endPanelBenchHrs + (exposedEdgeCount * (perimM / 4) * DB.settings.endPanelEdgeHrsPerM);
  const labourCost = labourHrs * er();
  // Spray finish (treat as door — same faces/edges logic, no quirk)
  const spray = calcSprayFinishCost({ doorType: finishType === "lacquer" ? "SLAB_VEN" : "SLAB_PNT",
    widthMm, heightMm, qty: 1, finishType, hasStain, surfaceType: faces >= 2 ? "door" : "panel" });
  const sprayC = spray.costPerDoor;
  const finishHrs = spray.breakdown ? spray.breakdown.totalHrs : 0; // spray finishing labour, per panel
  const cncCost = cncCut(matCost);   // the panel's board is Cutlist's
  const totalCostPerUnit = matCost + labourCost + sprayC + cncCost;
  const sellExVAT = totalCostPerUnit * margin;
  return {
    costPerUnit: totalCostPerUnit, sellPerUnit: sellExVAT,
    totalCost: totalCostPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { material: matCost, labour: labourCost, spray: sprayC,
      ...(cncCost ? { cnc: cncCost } : {}),
      panelHrs: +labourHrs.toFixed(3),      // end-panel build labour, person-hours per unit
      finishHrs,                            // spray finishing labour
      totalHrs: +(labourHrs + finishHrs).toFixed(3),
      sprayDetail: spray.breakdown },
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
  // Labour. A sheet shelf arrives from Cutlist cut and edged: sand, fit and finish prep only
  // (DB.settings.shelfBenchHrs). A solid-timber shelf is cut in-house, as before (0.5 h + 0.3 h timber prep).
  // A box shelf's assembly (mitre) is on top either way.
  const labourHrs   = (isTimber ? 0.5 : DB.settings.shelfBenchHrs) + (isBoxShelf ? 0.75 : 0) + (isTimber ? 0.3 : 0);
  const labourCost  = labourHrs * er();
  // Spray finish: 1 or 2 faces — top face always, bottom face if box shelf
  const sprayFaces  = faces >= 2 || isBoxShelf ? "door" : "panel";
  const spray       = calcSprayFinishCost({ doorType: finishType === "paint" ? "SLAB_PNT" : "SLAB_VEN",
    widthMm: depthMm, heightMm: lengthMm, qty: 1, finishType, hasStain, surfaceType: sprayFaces });
  const sprayC = spray.costPerDoor;
  const finishHrs = spray.breakdown ? spray.breakdown.totalHrs : 0; // spray finishing labour, per shelf
  const cncCost = isTimber ? 0 : cncCut(matCost);   // a sheet shelf's board is Cutlist's; a solid-timber one is made in-house
  const totalCostPerUnit = matCost + labourCost + sprayC + cncCost;
  const sellExVAT = totalCostPerUnit * margin;
  return {
    costPerUnit: totalCostPerUnit, sellPerUnit: sellExVAT,
    totalCost: totalCostPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { material: matCost, labour: labourCost, spray: sprayC, isBoxShelf,
      ...(cncCost ? { cnc: cncCost } : {}),
      shelfHrs: +labourHrs.toFixed(3),      // floating-shelf build labour, person-hours per unit
      finishHrs,                            // spray finishing labour
      totalHrs: +(labourHrs + finishHrs).toFixed(3),
      sprayDetail: spray.breakdown },
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
      ...(paintBreakdown ? { spray: paintBreakdown, sprayDetail: sprayHrsSplit(finishHrs, [[paintBreakdown, metres]]) } : {}),
    },
  };
}

// ─── FACE FRAME COST (CABINET) ─────────────────────────────────────────────────
// Frame runs around the cabinet opening perimeter (2×W + 2×H).
// Linear-priced (MDF): cost = perimeter × costPerM.
// Volume-priced (solid timber): cost = perimeter × memberWidth × thickness × £/m³.
// Corner joints (pocket screw / cope-and-stick): 0.1 hrs per corner (4 corners).
// A frame alone changes no hinge and carries no finish; an in-frame build (inframeFront) sets both in calcCabinetCost.
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
  // (The run is kept even at no charge: it is what Cutlist edges, and goes in the materials list.)
  if (!eb || edgebandKey === "EDGE_NONE") return { costPerUnit: 0, total: 0, totalM: 0, labourHrs: 0 };
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

// ─── HANDLELESS CHANNEL RAIL (CABINET) ─────────────────────────────────────────
// Priced per metre run, in place of pricing each channel piece as an end panel. Per rail: the strip's board
// (girth × length × £/m² × waste) and its spray (girth × length, one face — the end-panel rule; finishType defaults
// to the board's naturalFinish), plus bench labour per metre and ONE setup per cabinet. thicknessMm (T) defaults
// to the board's own. Returns null when there is nothing to price.
function calcChannelRailCost({ materialKey, finishType, thicknessMm, rails } = {}) {
  const mat = DB.materials[materialKey];
  if (!mat || !Array.isArray(rails)) return null;
  const T = thicknessMm || mat.thicknessMm;
  const finish = finishType || mat.naturalFinish || "none";
  let material = 0, spray = 0, finishHrs = 0, metres = 0;
  const sprays = [];
  for (const r of rails) {
    const p = r && CHANNEL_PROFILES[r.profile];
    if (!p || !(r.lengthMm > 0)) continue;
    const girthMm = p.fixedMm + p.tCount * T;
    metres += r.lengthMm / 1000;
    material += (girthMm / 1000) * (r.lengthMm / 1000) * mat.costPerM2 * (mat.wasteFactor || 1.12);
    const sf = calcSprayFinishCost({ widthMm: girthMm, heightMm: r.lengthMm, qty: 1, finishType: finish, surfaceType: "panel" });
    spray += sf.costPerDoor;
    finishHrs += sf.breakdown.totalHrs;
    sprays.push([sf.breakdown, 1]);
  }
  if (!metres) return null;
  const benchHrs = (metres * DB.settings.channelRailMinsPerM + DB.settings.channelRailSetupMins) / 60;
  const labour = benchHrs * er();
  return { cost: material + spray + labour, material, spray, labour, metres, benchHrs, finishHrs, sprays };
}

// ── FILLER COST ────────────────────────────────────────────────────────────
// Scribed strip in matching door finish. Self-contained line item (not bundled
// inside a cabinet). Pricing scales with strip size — bench labour is flat per
// filler (DB.settings.fillerBenchHrs): the strip arrives from Cutlist cut and edged, so it is sand, fit and finish
// prep only. Its board carries the Cutlist cut.
function calcFillerCost({ doorType = "SHAKER_PNT", widthMm = 50, heightMm = 720, qty = 1, hasStain = false, sprayFinishOverride = "", margin = DB.settings.margin }) {
  const dt = DB.doorTypes[doorType];
  if (!dt) return null;
  const area = (widthMm / 1000) * (heightMm / 1000);
  const materialCost = area * dt.baseCostPerM2;
  const labourCost = DB.settings.fillerBenchHrs * er();
  const finishType = sprayFinishOverride || dt.finishType || "paint";
  const spray = calcSprayFinishCost({
    doorType, widthMm, heightMm, qty: 1, finishType, hasStain,
    surfaceType: "panel",         // 1 face — back is hidden in the wall gap
    disableTopcoatRework: true,   // flat strip = low re-spray risk
  });
  const sprayCost = spray ? spray.costPerDoor : 0;
  const cncCost = cncCut(materialCost);   // the filler's board is Cutlist's
  const costPerUnit = materialCost + labourCost + sprayCost + cncCost;
  const totalCost = costPerUnit * qty;
  const sellExVAT = totalCost * margin;
  return {
    costPerUnit,
    sellPerUnit: costPerUnit * margin,
    totalCost,
    totalSellExVAT: sellExVAT,
    totalSellIncVAT: sellExVAT * (1 + DB.settings.vat),
    breakdown: { material: +materialCost.toFixed(2), labour: +labourCost.toFixed(2), spray: +sprayCost.toFixed(2), ...(cncCost ? { cnc: +cncCost.toFixed(2) } : {}) },
  };
}

// ── SOFFIT LED CHANNEL ─────────────────────────────────────────────────────
// One line for a design's soffit LED runs ({ lengthMm, position: front|back } — position is recorded, not priced).
// Extrusion is bought in 2 m lengths, rounded up per run; tape in 5 m reels, rounded up for the whole design; one
// driver from the list, the smallest that covers the tape's watts + headroom (over the largest: several of it);
// routing labour per metre at the bench rate.
function calcSoffitLedCost({ runs, qty = 1, margin = DB.settings.margin }) {
  const led = DB.hardware.soffitLed;
  const ok = Array.isArray(runs) ? runs.filter(r => r && r.lengthMm > 0) : [];
  if (!ok.length) return null;
  const totalMm = ok.reduce((s, r) => s + r.lengthMm, 0);
  const metres = totalMm / 1000;
  const extrusions = ok.reduce((s, r) => s + Math.ceil(Math.round(r.lengthMm) / led.extrusionLengthMm), 0);
  const reels = Math.ceil(Math.round(totalMm) / (led.reelLengthM * 1000));
  const wattsNeeded = metres * led.tapeWattsPerM * led.driverHeadroom;
  const drivers = Object.entries(led.drivers).sort((a, b) => a[1].watts - b[1].watts);
  const fits = drivers.find(([, d]) => d.watts >= wattsNeeded);
  const [driverKey, driver] = fits || drivers[drivers.length - 1];
  const driverCount = fits ? 1 : Math.ceil(wattsNeeded / driver.watts);
  const extrusionCost = extrusions * led.extrusionCost;
  const tapeCost = reels * led.reelCost;
  const driverCost = driverCount * driver.costEach;
  const routeHrs = metres * led.routeMinsPerM / 60;
  const labourCost = routeHrs * er();
  const costPerUnit = extrusionCost + tapeCost + driverCost + labourCost;
  const sellExVAT = costPerUnit * margin;
  return {
    costPerUnit, sellPerUnit: sellExVAT,
    totalCost: costPerUnit * qty, totalSellExVAT: sellExVAT * qty,
    totalSellIncVAT: sellExVAT * qty * (1 + DB.settings.vat),
    breakdown: { extrusion: extrusionCost, tape: tapeCost, driver: driverCost, labour: labourCost,
      routeHrs: +routeHrs.toFixed(3), totalHrs: +routeHrs.toFixed(3),
      led: { metres: +metres.toFixed(3), extrusions, reels, wattsNeeded: +wattsNeeded.toFixed(1), driverKey, driverCount } },
  };
}

// Every computed price records the engine + settings it came from (pricing.pricedWith).
function priceItem(item, effectiveMargin) {
  const p = priceItemUnstamped(item, effectiveMargin);
  if (p) p.pricedWith = { engine: ENGINE_VERSION, settings: settingsFingerprint() };
  return p;
}

function priceItemUnstamped(item, effectiveMargin) {
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
  if (item.type === "soffit_led") return calcSoffitLedCost({ ...item.params, qty: item.qty, margin });
  if (item.type === "custom") {
    const cost = (item.params.unitCostExVAT || 0) * item.qty;
    const sell = cost * margin;
    return { costPerUnit: item.params.unitCostExVAT, sellPerUnit: item.params.unitCostExVAT * margin, totalCost: cost, totalSellExVAT: sell, totalSellIncVAT: sell * (1 + DB.settings.vat), breakdown: {} };
  }
  return null;
}

// Recompute every item's `pricing` from its stored params using the canonical
// engine — EXCEPT on a price-locked quote or a website order, which is returned
// untouched (its stored pricing is final). onlyUnpriced prices just the items with no
// valid stored price: used when a quote is being locked, never on read. Non-destructive: structure is preserved, and
// if an item throws/returns null its stored pricing is kept. Shared by the server
// (GET /api/quotes, new-quote locking), the browser load path and the scripts.
function recomputeQuotePricing(quote, { onlyUnpriced = false } = {}) {
  if (!quote || !quote.rooms) return quote;
  if (isPricingLock(quote.pricingLock) || isLocked(quote)) return quote;
  // Per-quote margin override (falls back to the engine default when unset).
  const effectiveMargin = quote.marginOverride;
  const rooms = {};
  for (const [roomName, room] of Object.entries(quote.rooms)) {
    rooms[roomName] = {
      ...room,
      items: (room.items || []).map(item => {
        if (onlyUnpriced && Number.isFinite(item.pricing && item.pricing.totalCost)) return item;
        try { const pricing = priceItem(item, effectiveMargin); return pricing ? { ...item, pricing } : item; }
        catch { return item; }
      }),
    };
  }
  return { ...quote, rooms };
}

// ─── PRICING STATUS (read-only, additive) ────────────────────────────────────
// Hours are NOT frozen: each item gets hours.current from the live engine next to
// hours.priced (what its stored price was built on). The quote gets hoursCheck
// (priced vs current work) and pricingMixed (items priced with different engines /
// settings). Never touches pricing.
function hoursOf(bd) {
  if (!bd || !Number.isFinite(bd.totalHrs)) return null;
  const h = {};
  for (const [k, v] of Object.entries(bd)) if (/Hrs$/.test(k) || k === "sprayDetail") h[k] = v;
  return h;
}

function withPricingStatus(quote) {
  if (!quote || !quote.rooms) return quote;
  const check = { pricedHrs: 0, currentHrs: 0, deltaHrs: 0, itemsChanged: 0, itemsWithoutPricedHrs: 0 };
  const ids = new Set();
  const rooms = {};
  for (const [roomName, room] of Object.entries(quote.rooms)) {
    rooms[roomName] = { ...room, items: (room.items || []).map(item => {
      if (!item || item.fixedPrice) return item;
      if (item.pricing) ids.add(pricingId(item.pricing.pricedWith));
      let current = null;
      try { const p = priceItemUnstamped(item, quote.marginOverride); current = p && hoursOf(p.breakdown); } catch {}
      const priced = hoursOf(item.pricing && item.pricing.breakdown);
      if (!current && !priced) return item;
      const qty = item.qty || 1;
      const changed = priced && current ? +priced.totalHrs.toFixed(3) !== +current.totalHrs.toFixed(3) : null;
      if (priced && current) { check.pricedHrs += priced.totalHrs * qty; check.currentHrs += current.totalHrs * qty; }
      else if (current) check.itemsWithoutPricedHrs++;
      if (changed) check.itemsChanged++;
      return { ...item, hours: { priced, current, changed } };
    }) };
  }
  check.pricedHrs = +check.pricedHrs.toFixed(2);
  check.currentHrs = +check.currentHrs.toFixed(2);
  check.deltaHrs = +(check.currentHrs - check.pricedHrs).toFixed(2);
  return { ...quote, rooms, hoursCheck: check, pricingMixed: ids.size > 1 };
}

// ─── MATERIALS BILL OF MATERIALS (read-only, additive) ───────────────────────
// Aggregate the per-cabinet material QUANTITIES (breakdown.bom, produced by
// calcCabinetCost) into one per-quote BOM. Quantities come straight from the same
// geometry that prices each item, so the BOM never disagrees with the price.
//
// Returns null when the quote yields no material lines (e.g. only fixed-price or
// custom items) so the caller can omit the field entirely. Standard sheet size for
// the sheet-count estimate is 2440×1220mm (2.9768 m²).
function quoteMaterialsBom(quote) {
  if (!quote || !quote.rooms) return null;
  const SHEET_M2 = 2.4384 * 1.2192; // 2440×1220mm = 2.9729 m²
  // Per-category accumulators keyed by material/hardware code.
  const carcass = new Map();      // key → areaM2
  const doors = new Map();        // key → { count, areaM2 }
  const drawerBoxes = new Map();  // key → count
  const frames = new Map();       // key → linealM
  const edgeband = new Map();     // key → linealM
  const hardware = new Map();     // key → count
  const handles = new Map();      // "key|target" → count (positions; may be HW_HDL_NONE)
  const addNum = (map, key, n) => { if (key) map.set(key, (map.get(key) || 0) + (Number(n) || 0)); };

  for (const room of Object.values(quote.rooms)) {
    for (const item of (room.items || [])) {
      if (!item || item.fixedPrice) continue;
      // Prefer the already-recomputed bom; fall back to pricing the item if absent
      // (keeps the aggregator order-independent of the read-path recompute).
      let bom = item.pricing && item.pricing.breakdown && item.pricing.breakdown.bom;
      if (!bom) {
        try { const p = priceItem(item); bom = p && p.breakdown && p.breakdown.bom; } catch { bom = null; }
      }
      if (!bom) continue;
      (bom.carcass || []).forEach(e => addNum(carcass, e.key, e.areaM2));
      (bom.doors || []).forEach(e => {
        const cur = doors.get(e.key) || { count: 0, areaM2: 0 };
        cur.count += Number(e.count) || 0;
        cur.areaM2 += Number(e.areaM2) || 0;
        doors.set(e.key, cur);
      });
      (bom.drawerBoxes || []).forEach(e => addNum(drawerBoxes, e.key, e.count));
      (bom.frames || []).forEach(e => addNum(frames, e.key, e.linealM));
      (bom.edgeband || []).forEach(e => addNum(edgeband, e.key, e.linealM));
      (bom.hardware || []).forEach(e => addNum(hardware, e.key, e.count));
      (bom.handles || []).forEach(e => addNum(handles, `${e.key}|${e.target}`, e.count));
    }
  }

  const r2 = n => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
  const out = {
    carcass: [...carcass].map(([key, areaM2]) => ({ key, areaM2: r2(areaM2), sheets: Math.ceil(areaM2 / SHEET_M2) })),
    doors: [...doors].map(([key, v]) => ({ key, count: v.count, areaM2: r2(v.areaM2) })),
    drawerBoxes: [...drawerBoxes].map(([key, count]) => ({ key, count })),
    frames: [...frames].map(([key, linealM]) => ({ key, linealM: r2(linealM) })),
    edgeband: [...edgeband].map(([key, linealM]) => ({ key, linealM: r2(linealM) })),
    hardware: [...hardware].map(([key, count]) => ({ key, count })),
    // Handle positions required (split by door/drawer; key may be HW_HDL_NONE when
    // handles aren't priced — the count is still the number you'd need to order).
    handles: [...handles].map(([k, count]) => { const [key, target] = k.split('|'); return { key, target, count }; }),
  };
  // Omit entirely when nothing was found (empty / fixed-price-only quotes).
  const empty = Object.values(out).every(arr => arr.length === 0);
  return empty ? null : out;
}

// ─── Exports / global exposure ──────────────────────────────────────────────
(function () {
  const api = { DB, FRAME_MATERIALS, INFRAME_SPECIES, inframeDefaults, EDGEBAND_TYPES, NO_EDGE_MATERIALS, CHANNEL_PROFILES, calcChannelRailCost, er, hingeCount, fmt,
    calcSprayFinishCost, calcDoorCost, calcFrameCost, calcDrawerCost, calcCabinetCost,
    calcEndPanelCost, calcFloatingShelfCost, calcMouldingCost, parseWRPDimensions,
    calcWRPFinishCostPerM, calcWRPMouldingCost, calcCabinetFaceFrameCost,
    calcCabinetEdgebandCost, calcFillerCost, calcSoffitLedCost, priceItem,
    calcDesignHrsPerRoom, calcDesignTimePerRoom,
    getDefaultProjectCosts, totalInstallDays, quoteTotals, quoteGrandTotal, quoteMargin,
    recomputeQuotePricing, quoteMaterialsBom,
    ENGINE_VERSION, applySettings, settingsDiff, validateSettings, settingsFingerprint, pricingId, isPricingLock, isLocked, lockedChange, lockedMerge, withWorkshopHours, onOrderCreate, lockQuote, quoteSettings, rescaleMargin, withPricingStatus };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") Object.assign(window, api);
})();
