#!/usr/bin/env python3
"""Python mirror of the mini-CFFM engine (plan/10 Phase 3, B2), for the
tests in tests/test_ldes_cffm.py.

MIRRORS app/js/metrics.js (cffmLevels -> cffm_levels,
cffmCorridor -> cffm_corridor). If those change, change this.
Also mirrored: cffmAnnuitiseEndOfLife -> cffm_annuitise_end_of_life
(D79) and cffmCsvRows -> cffm_csv_rows (D80/D81).

Ofgem's LDES cap-and-floor financial model (CFFM), reduced to its ex-tax
real-terms core (D73/D74): RAV build with interest during construction
(IDC, the A1.70 formula), transaction costs, straight-line depreciation,
an NPV-neutral return on RAV, and annuity flattening (A1.151) — computed
separately at the floor rate and the cap rate. Deliberately OUT of
scope: the corporation-tax loop (levels are ex-tax), Repex, the ACOD
floor, and the partial-indexation switch. Everything is flat real terms.

Return base: r x opening RAV — under this block's end-of-year
discounting ((1+r)^-n from the start of operations) the opening RAV is
the UNIQUE base for which PV(depreciation + return) telescopes exactly
to RAV - residual x (1+r)^-opYears, the identity AnnuityIdentityTest
pins. The full CFFM's averaged base (A1.143) is neutral only under its
own intra-year receipt timing — see the JS docstring for the reasoning.

This module has no I/O of its own: every function takes plain dicts and
returns plain numbers/dicts, exactly like its JS counterpart. Stdlib
only, like the rest of ops/ and etl/.
"""


def _finite(value):
    """JS Number.isFinite: a real number, not None/bool/NaN/inf."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def cffm_levels(inputs):
    """Floor and cap levels (£m/yr, flat real, ex-tax). Mirrors
    Metrics.cffmLevels exactly — see the JS docstring for the input
    schema, the A1.x formula references, and the stated simplifications
    (whole construction years, one-shot transaction costs with no IDC of
    their own, depreciation down TO residualValue). None on any
    missing/non-finite required input or constructionYears/opYears < 1.
    """
    if not inputs:
        return None
    op_years = inputs.get("opYears")
    op_years = 25 if op_years is None else op_years
    residual = inputs.get("residualValue")
    residual = 0 if residual is None else residual
    required_keys = ("constructionYears", "devex", "capex", "idcRate",
                     "gearing", "txDebtRate", "txEquityRate", "opexFixed",
                     "decom", "floorRate", "capRate")
    values = {k: inputs.get(k) for k in required_keys}
    if not all(_finite(v) for v in values.values()):
        return None
    if not _finite(op_years) or not _finite(residual):
        return None
    construction_years = values["constructionYears"]
    if construction_years < 1 or op_years < 1:
        return None

    # Pre-op RAV walk: additions earn a half year of IDC, discounted
    # from mid-year at the simple half-year rate — A1.70 verbatim.
    idc_rate = values["idcRate"]
    pre_op_rav = 0.0
    idc_total = 0.0
    capex_per_year = values["capex"] / construction_years
    for y in range(1, int(construction_years) + 1):
        additions = capex_per_year + (values["devex"] if y == 1 else 0.0)
        idc = idc_rate * (pre_op_rav + additions / (2 + idc_rate))
        pre_op_rav += additions + idc
        idc_total += idc

    # One-shot transaction costs at transfer, split by pre-op notional
    # gearing (no IDC on them — stated mini-model simplification).
    gearing = values["gearing"]
    tx_total = pre_op_rav * (gearing * values["txDebtRate"]
                             + (1 - gearing) * values["txEquityRate"])
    rav = pre_op_rav + tx_total

    depreciation = (rav - residual) / op_years
    opex_plus_decom = values["opexFixed"] + values["decom"]

    def side(r):
        opening = rav
        npv_return = npv_dep = npv_opex = 0.0
        for n in range(1, int(op_years) + 1):
            disc = (1 + r) ** -n
            npv_return += r * opening * disc
            npv_dep += depreciation * disc
            npv_opex += opex_plus_decom * disc
            opening -= depreciation
        if r == 0:
            annuity_factor = 1 / op_years
        else:
            annuity_factor = r / (1 - (1 + r) ** -op_years)
        return_annuity = npv_return * annuity_factor
        depreciation_annuity = npv_dep * annuity_factor
        opex_block = npv_opex * annuity_factor
        return {"level": return_annuity + depreciation_annuity + opex_block,
                "returnAnnuity": return_annuity,
                "depreciationAnnuity": depreciation_annuity,
                "opexBlock": opex_block}

    return {"rav": rav, "idcTotal": idc_total, "txTotal": tx_total,
            "floor": side(values["floorRate"]),
            "cap": side(values["capRate"])}


def cffm_corridor(levels, inputs):
    """Corridor arithmetic (D77). Mirrors Metrics.cffmCorridor exactly:
    per gross-margin scenario, topUp = max(0, floor - gm), aboveCap =
    max(0, gm - cap), clawback = 0.7 x aboveCap, retained = gm -
    clawback; lifetime figures = annual x opYears, flat and deliberately
    UNDISCOUNTED (a flat real annuity against flat real scenarios — a
    consumer-flow discount rate would be false precision). faScore =
    gmCentral / floorLevel (Ofgem's financial-adequacy metric; the 0.60
    demotion threshold is a UI concern), None for a non-positive floor.
    None on any missing/non-finite input or opYears < 1."""
    if not levels or not inputs:
        return None
    floor_level = levels.get("floorLevel")
    cap_level = levels.get("capLevel")
    gms = [inputs.get(k) for k in ("gmLow", "gmCentral", "gmHigh")]
    op_years = inputs.get("opYears")
    op_years = 25 if op_years is None else op_years
    if not all(_finite(v) for v in [floor_level, cap_level, op_years] + gms):
        return None
    if op_years < 1:
        return None

    def scenario(gm):
        top_up = max(0.0, floor_level - gm)
        above_cap = max(0.0, gm - cap_level)
        clawback = 0.7 * above_cap
        retained = gm - clawback
        return {"gm": gm, "topUp": top_up, "aboveCap": above_cap,
                "clawback": clawback, "retained": retained,
                "lifetimeTopUp": top_up * op_years,
                "lifetimeClawback": clawback * op_years,
                "lifetimeRetained": retained * op_years}

    gm_low, gm_central, gm_high = gms
    return {"low": scenario(gm_low), "central": scenario(gm_central),
            "high": scenario(gm_high),
            "faScore": (gm_central / floor_level
                        if floor_level > 0 else None)}


def cffm_annuitise_end_of_life(amount, rate, op_years):
    """One-off end-of-regime cost -> flat annual equivalent (D79).
    Mirrors Metrics.cffmAnnuitiseEndOfLife exactly: a single payment X
    at the end of year op_years is NPV-equivalent to
    X x (1+r)^-op_years x AF(r, op_years) per year — discount the lump
    to the start of operations, then flatten with the A1.151 annuity
    factor. rate = 0 degenerates to X / op_years. None on any
    missing/non-finite input or op_years < 1."""
    if not all(_finite(v) for v in (amount, rate, op_years)):
        return None
    if op_years < 1:
        return None
    if rate == 0:
        return amount / op_years
    af = rate / (1 - (1 + rate) ** -op_years)
    return amount * (1 + rate) ** -op_years * af


def cffm_csv_rows(levels, corridor, inputs):
    """The mini-CFFM CSV export's parameter table (D81, superseding
    D80's flat year table). Mirrors Metrics.cffmCsvRows exactly: the
    full row list for a section,parameter,value CSV — the header row,
    one `input` row per card field (the raw typed value, "not_set"
    when blank), the `derived` level/corridor summary ("not_set" for
    any gross-margin scenario not typed), and the standing caveat as
    the one `note` row; every derived number rounded to 4 dp, every
    string ASCII. `inputs` is the card's raw typed state (percents as
    typed). None on missing levels or inputs. NOTE the guard is
    `inputs is None`, not falsiness: an empty inputs dict is truthy in
    JS and must yield all-not_set input rows in both languages."""
    if not levels or inputs is None:
        return None
    rows = [["section", "parameter", "value"]]
    input_keys = (
        ("construction_years", "constructionYears"),
        ("capex_gbpm", "capex"),
        ("devex_gbpm", "devex"),
        ("idc_rate_pct", "idcRate"),
        ("gearing_pct", "gearing"),
        ("tx_debt_pct", "txDebtRate"),
        ("tx_equity_pct", "txEquityRate"),
        ("opex_gbpm_yr", "opexFixed"),
        ("decom_gbpm_yr", "decom"),
        ("op_years", "opYears"),
        ("residual_value_gbpm", "residualValue"),
        ("floor_return_pct", "floorRate"),
        ("cap_return_pct", "capRate"),
        ("mw", "mw"),
        ("gm_low_gbpm_yr", "gmLow"),
        ("gm_central_gbpm_yr", "gmCentral"),
        ("gm_high_gbpm_yr", "gmHigh"),
    )
    for key, prop in input_keys:
        v = inputs.get(prop)
        rows.append(["input", key, v if _finite(v) else "not_set"])

    def derived(key, v):
        rows.append(["derived", key,
                     round(v, 4) if _finite(v) else "not_set"])

    derived("rav_gbpm", levels["rav"])
    derived("idc_total_gbpm", levels["idcTotal"])
    derived("tx_total_gbpm", levels["txTotal"])
    derived("floor_level_gbpm_yr", levels["floor"]["level"])
    derived("cap_level_gbpm_yr", levels["cap"]["level"])
    derived("floor_return_annuity_gbpm", levels["floor"]["returnAnnuity"])
    derived("floor_depreciation_annuity_gbpm",
            levels["floor"]["depreciationAnnuity"])
    derived("floor_opex_block_gbpm", levels["floor"]["opexBlock"])
    derived("cap_return_annuity_gbpm", levels["cap"]["returnAnnuity"])
    derived("cap_depreciation_annuity_gbpm",
            levels["cap"]["depreciationAnnuity"])
    derived("cap_opex_block_gbpm", levels["cap"]["opexBlock"])
    derived("fa_score", corridor.get("faScore") if corridor else None)
    for name, prop in (("low", "gmLow"), ("central", "gmCentral"),
                       ("high", "gmHigh")):
        sc = (corridor[name]
              if corridor and _finite(inputs.get(prop)) else None)
        derived(f"lifetime_topup_{name}_gbpm",
                sc["lifetimeTopUp"] if sc else None)
        derived(f"lifetime_clawback_{name}_gbpm",
                sc["lifetimeClawback"] if sc else None)
        derived(f"lifetime_retained_{name}_gbpm",
                sc["lifetimeRetained"] if sc else None)
    rows.append(["note", "caveat",
                 "ex-tax, flat real, "
                 "indicative - not the CFFM, not a valuation"])
    return rows
