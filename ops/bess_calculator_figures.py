#!/usr/bin/env python3
"""Python mirror of the BESS profitability calculator engine (plan/09,
issue #49), for the parity test in tests/test_bess_calculator.py.

MIRRORS app/js/metrics.js (yearFractionRemaining, tnuosCharge,
arbitrageCeiling, observedArbitrageSpread, discountExponent,
annuityPayment -> annuity_payment, dscrStats -> dscr_stats,
bessCashflow, npv, irr, mirr, simplePayback, discountedPayback,
pviAtCommissioning, lcos, reanchorNpv). If those change, change this.
Same convention as
ops/merit_panel_figures.py: js_round reproduces Number.prototype.toFixed's
binary rounding exactly (ops/merit_panel_figures.py:39-49), and the test
suite pins JS output captured in a real browser as the oracle, not
synthetic expectations.

Discounting convention (owner request, 2026-07): bess_cashflow() defaults
to "mid" (mid-year, (1+r)^(n-0.5), with year 1's pro-rated commissioning
stub discounted at its own midpoint); "end" reproduces the original
end-of-period (1+r)^n behaviour unconditionally. IRR and simple payback
are both defined on undiscounted flows and are unaffected by this choice
either way; see discount_exponent()'s docstring.

This module has no I/O of its own: every function takes plain numbers/
dicts and returns plain numbers/dicts, exactly like its JS counterpart.
Stdlib only, like the rest of ops/ and etl/.
"""

import math
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP


def js_round(value, dp):
    """Exact JS Number.prototype.toFixed semantics — see
    ops/merit_panel_figures.py's identical helper for the reasoning
    (ties go away from zero on the BINARY value of the double)."""
    sign = -1 if value < 0 else 1
    quantum = Decimal(1).scaleb(-dp)
    return sign * float(Decimal(abs(value)).quantize(quantum,
                                                     rounding=ROUND_HALF_UP))


def year_fraction_remaining(iso_date):
    """Fraction of a calendar year remaining on/after `iso_date`
    (inclusive). No date -> a full year (fraction 1), mirroring
    metrics.js's default for hypothetical-mode inputs with no
    commissioning date set."""
    if not iso_date:
        return 1.0
    try:
        d = date.fromisoformat(iso_date[:10])
    except ValueError:
        return 1.0
    year = d.year
    start = date(year, 1, 1)
    end = date(year + 1, 1, 1)
    total_days = (end - start).days
    days_elapsed = (d - start).days
    return max(0.0, min(1.0, (total_days - days_elapsed) / total_days))


def tnuos_charge(conn_type, zone, load_factor):
    """z_total(f) = SystemPeak + f x (SharedYearRound + NotSharedYearRound)
    + Residual, £/kW. None (not zero) for a distribution-connected unit
    or a missing zone/load factor — "not applicable" must stay
    distinguishable from an actual zero-value zone."""
    if conn_type != "T":
        return None
    if not zone or load_factor is None:
        return None
    return (zone["peak"] + load_factor * (zone["yr_shared"] + zone["yr_notshared"])
            + zone["residual"])


def arbitrage_ceiling(s_hi, s_lo, eta):
    """(s_hi - s_lo / eta), NOT (s_hi - s_lo) x eta — the two diverge as
    efficiency falls and as the charging-leg price rises (test plan item
    4). None if either price or eta is absent/zero."""
    if s_hi is None or s_lo is None or not eta:
        return None
    return s_hi - s_lo / eta


def observed_arbitrage_spread(ts, price, duration_hours):
    """Mirrors Metrics.observedArbitrageSpread exactly (v1.5, D26 pulled
    forward from v2): mean top-n / bottom-n half-hourly price per
    COMPLETE day (>= 46 populated periods), averaged across every
    complete day in the supplied series, where
    n = round(2 x duration_hours). `ts` is epoch seconds; days are
    grouped by UTC calendar day (ts // 86400), matching the JS side's
    Math.floor(ts / 86400). None (not zero) when there is no series, no
    positive duration, or no complete day."""
    if not ts or not duration_hours or duration_hours <= 0:
        return None
    # JS Math.round rounds half AWAY FROM zero (up, for a positive
    # value); Python's round() rounds half to even, which would
    # silently disagree at exact .5 boundaries (e.g. 2*1.25=2.5 ->
    # JS gives 3, bare Python round() gives 2) — floor(x+0.5) matches
    # Math.round exactly for x >= 0, which duration_hours always is.
    n = max(1, int(math.floor(2 * duration_hours + 0.5)))
    days = {}
    for t, p in zip(ts, price):
        if p is None:
            continue
        day = t // 86400
        days.setdefault(day, []).append(p)
    sum_hi = sum_lo = 0.0
    complete = 0
    for arr in days.values():
        if len(arr) < 46:
            continue
        sorted_arr = sorted(arr)
        k = min(n, len(sorted_arr))
        lo = sorted_arr[:k]
        hi = sorted_arr[len(sorted_arr) - k:]
        sum_lo += sum(lo) / k
        sum_hi += sum(hi) / k
        complete += 1
    if not complete:
        return None
    return {"sHi": sum_hi / complete, "sLo": sum_lo / complete,
           "days": complete}


def discount_exponent(n, frac1, discounting):
    """Discounting-convention exponent (owner request, 2026-07). Mirrors
    metrics.js's discountExponent exactly:
      mid-year (default, discounting != "end"): year n discounts at
        (1+r)^(n-0.5); year 1's pro-rated commissioning stub (frac1, the
        remaining-year fraction) discounts at the stub's own midpoint,
        (1-frac1) + frac1/2, which is exactly n-0.5 when frac1=1 (no
        stub).
      end-of-period ("end"): year n discounts at (1+r)^n unconditionally,
        the original behaviour, with no stub adjustment either.
    """
    if discounting == "end":
        return n
    return (1 - frac1) + frac1 / 2 if n == 1 else n - 0.5


def annuity_payment(principal, rate, years):
    """Mirrors Metrics.annuityPayment exactly (plan/10 D55/D61): the
    level annual payment retiring `principal` over `years` at `rate` (a
    real fraction) — principal x rate / (1 - (1+rate)^-years), with
    rate = 0 taken as an explicit straight-line principal/years branch
    rather than a 0/0. Returns 0 (an inert layer) on missing/nonsense
    inputs rather than None: callers sum it into signed columns."""
    def _finite(v):
        return (isinstance(v, (int, float)) and not isinstance(v, bool)
                and math.isfinite(v))
    if (not (_finite(principal) and _finite(rate) and _finite(years))
            or principal <= 0 or years < 1):
        return 0
    if rate == 0:
        return principal / years
    return principal * rate / (1 - (1 + rate) ** -years)


def dscr_stats(rows, toll_tenor):
    """Mirrors Metrics.dscrStats exactly (plan/10 D60/D65): DSCR_n =
    net_cashflow_gbp_n / debt service_n over the years service is
    actually due, where service is -(debt_interest_gbp +
    debt_principal_gbp) — those columns are signed negative (outflows),
    like opex_gbp/tnuos_gbp. CFADS is deliberately the project net cash
    flow itself, augmentation capex included in its year (the honest
    in-model reading; lenders typically carve funded capex out, which
    the methodology states rather than silently adopting). None when no
    year carries debt service. `toll_tenor` splits the toll-period and
    post-toll aggregates; 0 leaves the toll side None and everything in
    the post/merchant bucket."""
    if not rows:
        return None
    all_d, toll_yrs, post_yrs = [], [], []
    min_d, min_year = None, None
    for row in rows:
        if row["year"] < 1:
            continue
        service = -(row["debt_interest_gbp"] + row["debt_principal_gbp"])
        if service <= 0:
            continue
        d = row["net_cashflow_gbp"] / service
        all_d.append(d)
        if toll_tenor >= 1 and row["year"] <= toll_tenor:
            toll_yrs.append(d)
        else:
            post_yrs.append(d)
        if min_d is None or d < min_d:
            min_d, min_year = d, row["year"]
    if not all_d:
        return None

    def mean(arr):
        return sum(arr) / len(arr) if arr else None

    def min_of(arr):
        return min(arr) if arr else None

    return {"min": min_d, "avg": mean(all_d), "minYear": min_year,
            "minToll": min_of(toll_yrs), "avgToll": mean(toll_yrs),
            "minPost": min_of(post_yrs), "avgPost": mean(post_yrs)}


def bess_cashflow(inputs):
    """Mirrors Metrics.bessCashflow exactly, including its rounding.
    `inputs` is a plain dict with the same keys as the JS side: P, E,
    y0 (optional), T, C, O, r, c, delta (optional, default 0), eta, a,
    sHi/sLo/k (optional, arbitrage; v2, null/0 by default), gamma
    (optional, default 0), zTotal (optional, default 0), discounting
    (optional, "mid" default or "end"), augYear/augMwh/augCostPerMwh/
    augDelta (optional, one augmentation event as a second cell tranche:
    augMwh of new cells join at the start of year augYear - partial
    top-up, full restore or expansion, uncapped - costed at
    augCostPerMwh pounds-k/MWh in that year; the original tranche keeps
    degrading on its own clock, the new one degrades at augDelta, which
    defaults to delta when None; year, size and cost must all be set or
    the event is a no-op), rho (optional availability derate,
    fraction/yr, compounding on the CAPACITY-WEIGHTED cell age across
    the tranches, so a fresh tranche partially rejuvenates capability;
    gamma stays on the calendar clock) and opexEsc (optional OPEX
    escalation, fraction/yr, default 0 — D23: no market default ships).
    Applied to the operating-cost line ONLY: O x 1000 x P x frac x
    (1+opexEsc)^(n-1), so year 1 is the unescalated base; TNUoS is a
    published tariff and is not escalated, and the augmentation
    tranche's cost is a one-off typed figure with nothing to escalate.

    tollShare/tollPrice/tollTenor (optional, plan/10 D58/D59): one
    tolling agreement — for years 1..tollTenor a share tollShare (a
    fraction) earns a fixed toll of tollPrice GBPk/MW/yr (numerically
    identical to pounds/kW/yr; the market quotes GBPk/MW/yr), flat real,
    pro-rated by year 1's commissioning stub but never degraded,
    cannibalised or derated (availability guarantees sit with the
    operator); the merchant availability+arbitrage pair is scaled by
    (1-tollShare) instead, and after the tenor the asset is fully
    merchant again. All three set or the agreement is a no-op.
    gearing/costOfDebt/debtTenor (optional, plan/10 D59/D61): one debt
    layer — D0 = gearing x C0 draws down at year 0, repaying as a level
    annuity at costOfDebt over debtTenor years, contractual-annual,
    never stub-pro-rated; a tenor past T leaves principal outstanding,
    no synthetic balloon. All three set or the layer is a no-op. The
    layer sits BELOW the project line: net_cashflow_gbp and every
    metric built on it stay ungeared; the new signed columns carry the
    layer and equity_cashflow_gbp is their plain sum with net.

    Returns None if a required input is missing/non-finite, matching
    metrics.js's null-safety; otherwise {"c0": ..., "d0": ...,
    "rows": [...]}.
    """
    p = inputs.get("P")
    e = inputs.get("E")
    y0 = inputs.get("y0")
    t = inputs.get("T")
    c_capex = inputs.get("C")
    o_opex = inputs.get("O")
    r = inputs.get("r")
    c_cycles = inputs.get("c")
    delta = inputs.get("delta", 0) or 0
    eta = inputs.get("eta")
    a = inputs.get("a")
    s_hi = inputs.get("sHi")
    s_lo = inputs.get("sLo")
    k = inputs.get("k", 0) or 0
    gamma = inputs.get("gamma", 0) or 0
    z_total = inputs.get("zTotal", 0) or 0
    discounting = inputs.get("discounting") or "mid"
    aug_year = inputs.get("augYear")
    aug_mwh = inputs.get("augMwh", 0) or 0
    aug_cost_mwh = inputs.get("augCostPerMwh", 0) or 0
    aug_delta = inputs.get("augDelta")
    rho = inputs.get("rho", 0) or 0
    opex_esc = inputs.get("opexEsc", 0) or 0
    toll_share = inputs.get("tollShare", 0) or 0
    toll_price = inputs.get("tollPrice", 0) or 0
    toll_tenor = inputs.get("tollTenor", 0) or 0
    gearing = inputs.get("gearing", 0) or 0
    cost_of_debt = inputs.get("costOfDebt")
    debt_tenor = inputs.get("debtTenor", 0) or 0

    def finite(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool)

    required = [p, e, t, c_capex, o_opex, r, c_cycles, eta, a]
    if not all(finite(v) for v in required) or t <= 0 or p <= 0:
        return None

    aug_active = (isinstance(aug_year, (int, float))
                  and not isinstance(aug_year, bool)
                  and aug_year >= 1 and aug_mwh > 0 and aug_cost_mwh > 0)
    d2 = delta if aug_delta is None else aug_delta
    toll_active = toll_share > 0 and toll_price > 0 and toll_tenor >= 1
    debt_active = gearing > 0 and finite(cost_of_debt) and debt_tenor >= 1
    c0 = c_capex * 1000 * p
    d0 = gearing * c0 if debt_active else 0
    pay = (annuity_payment(d0, cost_of_debt, debt_tenor)
           if debt_active else 0)
    bal = d0
    frac1 = year_fraction_remaining(y0)
    rows = [{
        "year": 0, "capex_gbp": js_round(-c0, 2), "availability_gbp": 0,
        "arbitrage_gbp": 0, "opex_gbp": 0, "tnuos_gbp": 0,
        "net_cashflow_gbp": js_round(-c0, 2),
        "discounted_cashflow_gbp": js_round(-c0, 2),
        "cumulative_discounted_gbp": js_round(-c0, 2),
        "discharged_mwh": 0, "usable_mwh": 0,
        "toll_gbp": 0, "debt_drawdown_gbp": js_round(d0, 2),
        "debt_interest_gbp": 0, "debt_principal_gbp": 0,
        "equity_cashflow_gbp": js_round(-c0 + d0, 2),
    }]
    cum_disc = -c0
    ceiling = arbitrage_ceiling(s_hi, s_lo, eta)
    for n in range(1, int(t) + 1):
        g = (1 - gamma) ** (n - 1)
        frac = frac1 if n == 1 else 1
        t1 = e * (1 - delta) ** (n - 1)
        t2 = (aug_mwh * (1 - d2) ** (n - aug_year)
              if (aug_active and n >= aug_year) else 0)
        cap = t1 + t2
        age = ((t1 * (n - 1) + t2 * (n - aug_year if aug_active else 0)) / cap
               if cap > 0 else n - 1)
        usable_mwh = cap * frac
        discharged_mwh = 365 * c_cycles * cap * frac
        availability = a * 1000 * p * g * frac * (1 - rho) ** age
        arbitrage = (discharged_mwh * ceiling * k * g
                    if (ceiling is not None and k) else 0)
        # Toll pounds deliberately OUTSIDE the g/rho scaling the two
        # lines above carry (D58), mirroring Metrics.bessCashflow: flat
        # real over the tenor, pro-rated only by year 1's commissioning
        # stub — degradation, cannibalisation and the derate stay on
        # the merchant share alone.
        toll_on = toll_active and n <= toll_tenor
        s_eff = toll_share if toll_on else 0
        toll = toll_price * 1000 * p * toll_share * frac if toll_on else 0
        availability_net = availability * (1 - s_eff)
        arbitrage_net = arbitrage * (1 - s_eff)
        # Escalated on OPEX alone (owner request, 2026-08-01), mirroring
        # Metrics.bessCashflow exactly: TNUoS and the augmentation capex
        # line below are both untouched by opex_esc.
        opex = o_opex * 1000 * p * frac * (1 + opex_esc) ** (n - 1)
        tnuos = (z_total or 0) * 1000 * p * frac
        capex_n = (-(aug_cost_mwh * 1000 * aug_mwh)
                   if (aug_active and n == aug_year) else 0)
        net = toll + availability_net + arbitrage_net - opex - tnuos + capex_n
        exponent = discount_exponent(n, frac1, discounting)
        discounted = net / (1 + r) ** exponent
        cum_disc += discounted
        # Debt walk (D61), mirroring Metrics.bessCashflow exactly:
        # contractual-annual, never stub-pro-rated; a tenor past T just
        # stops here with principal outstanding.
        service_due = debt_active and n <= debt_tenor
        interest = bal * cost_of_debt if service_due else 0
        principal = pay - interest if service_due else 0
        if service_due:
            bal -= principal
        equity = net - interest - principal
        rows.append({
            "year": n, "capex_gbp": js_round(capex_n, 2),
            "availability_gbp": js_round(availability_net, 2),
            "arbitrage_gbp": js_round(arbitrage_net, 2),
            "opex_gbp": js_round(-opex, 2),
            "tnuos_gbp": js_round(-tnuos, 2),
            "net_cashflow_gbp": js_round(net, 2),
            "discounted_cashflow_gbp": js_round(discounted, 2),
            "cumulative_discounted_gbp": js_round(cum_disc, 2),
            "discharged_mwh": js_round(discharged_mwh, 3),
            "usable_mwh": js_round(usable_mwh, 3),
            "toll_gbp": js_round(toll, 2),
            "debt_drawdown_gbp": 0,
            "debt_interest_gbp": js_round(-interest, 2),
            "debt_principal_gbp": js_round(-principal, 2),
            "equity_cashflow_gbp": js_round(equity, 2),
        })
    return {"c0": c0, "d0": d0, "rows": rows}


def npv(c0, cashflows, r, discounting="end", frac1=1.0):
    """NPV of a capex outflow C0 (time zero) plus undiscounted year-1..N
    cash flows. `discounting`/`frac1` default to "end"/1.0 (unconditional
    (1+r)^n), so irr() below — which calls this with just three
    positional arguments — is completely unaffected by the discounting-
    convention feature: IRR stays defined on undiscounted flows in the
    usual annual-compounding sense, regardless of which convention the
    card reports NPV under (see discount_exponent's docstring). The
    card's headline NPV (compute(), below) passes its own discounting/
    frac1 so it matches bess_cashflow's own discounted columns exactly."""
    total = -c0
    for i, cf in enumerate(cashflows):
        total += cf / (1 + r) ** discount_exponent(i + 1, frac1, discounting)
    return total


def irr(c0, cashflows):
    """Bisection on r in [-0.99, 1.50], 100 iterations, tolerance 1e-9.
    None — never 0 — when NPV does not change sign across the bracket."""
    def f(r):
        return npv(c0, cashflows, r)

    lo, hi = -0.99, 1.50
    f_lo, f_hi = f(lo), f(hi)
    if f_lo == 0:
        return lo
    if f_hi == 0:
        return hi
    if (f_lo > 0) == (f_hi > 0):
        return None
    for _ in range(100):
        mid = (lo + hi) / 2
        f_mid = f(mid)
        if abs(f_mid) < 1e-9:
            return mid
        if (f_mid > 0) == (f_lo > 0):
            lo, f_lo = mid, f_mid
        else:
            hi, f_hi = mid, f_mid
    return (lo + hi) / 2


def mirr(c0, cashflows, r):
    """Modified IRR, mirroring Metrics.mirr exactly: negatives
    (including the year-0 capex) discount to t=0 and positives compound
    to the horizon T, both at `r` (the WACC), and
    MIRR = (FV_pos / -PV_neg)^(1/T) - 1. Exists beside irr(), not
    instead of it: an augmentation-year outflow gives the series a
    second sign change and plain IRR then has multiple valid roots;
    MIRR is single-valued by construction. None when there is no
    positive or no negative flow at all."""
    t = len(cashflows)
    if not t:
        return None
    fv_pos = 0.0
    pv_neg = -c0
    for i, cf in enumerate(cashflows):
        n = i + 1
        if cf > 0:
            fv_pos += cf * (1 + r) ** (t - n)
        else:
            pv_neg += cf / (1 + r) ** n
    if fv_pos <= 0 or pv_neg >= 0:
        return None
    return (fv_pos / -pv_neg) ** (1.0 / t) - 1


def simple_payback(c0, cashflows):
    """Undiscounted, linearly interpolated inside the year repayment
    falls in. None when C0 is never recovered."""
    cum = 0
    for i, cf in enumerate(cashflows):
        prev_cum = cum
        cum += cf
        if cum >= c0:
            remainder = c0 - prev_cum
            frac = remainder / cf if cf else 0
            return i + frac
    return None


def discounted_payback(rows):
    """Mirrors Metrics.discountedPayback exactly: linear interpolation on
    DISCOUNTED cash flows (rows' discounted_cashflow_gbp /
    cumulative_discounted_gbp), never the undiscounted net_cashflow_gbp
    column. Walks the running cumulative from the year-0 row's own
    discounted value (-c0); the first year n where it crosses from
    negative to >= 0 gives
        DPP = n - 1 + (dcf_n - cum_n) / dcf_n
    (dcf_n that year's discounted flow, cum_n the cumulative INCLUDING
    it). None when the cumulative never crosses.

    Anchor-invariant (re-anchoring scales every discounted figure by
    one factor, which cancels in both the crossing test and the
    fraction) and convention-aware (the discounted column already
    carries the mid-year/end toggle and the year-1 stub) — see the JS
    docstring for the full reasoning."""
    if not rows:
        return None
    cum = rows[0]["discounted_cashflow_gbp"]
    for row in rows[1:]:
        prev_cum = cum
        cum += row["discounted_cashflow_gbp"]
        if prev_cum < 0 and cum >= 0:
            dcf_n = row["discounted_cashflow_gbp"]
            return (row["year"] - 1) + (dcf_n - cum) / dcf_n if dcf_n else row["year"] - 1
    return None


def pvi_at_commissioning(c0, rows, r, discounting="end", frac1=1.0):
    """Mirrors Metrics.pviAtCommissioning exactly: c0 (the positive
    year-0 capex) plus the discounted value of every later capital
    outflow (rows' capex_gbp, negative in an augmentation year, zero
    otherwise), sign-flipped positive so PVI is itself a positive
    magnitude. Same signature/default shape as npv() above, for the
    same reason. The card re-anchors this the same way NPV is
    re-anchored (reanchor_npv, same factor), so DPI's ratio of the two
    is anchor-invariant."""
    total = c0
    for row in rows:
        if row["year"] < 1:
            continue
        total += (-row["capex_gbp"]) / (1 + r) ** discount_exponent(
            row["year"], frac1, discounting)
    return total


def lcos(c0, rows, r, eta, s_lo=None):
    """Indicative LCOS (£/MWh). `rows` is bess_cashflow()'s row list
    (the year-0 capex row is skipped here; C0 enters once, undiscounted).
    A null s_lo simply drops the charging-cost term (v1 has no wholesale
    price feed wired into the card) rather than refusing to compute."""
    cost_num = c0
    energy_denom = 0
    for row in rows:
        n = row["year"]
        if n < 1:
            continue
        x = -row["opex_gbp"]
        g = -row["tnuos_gbp"]
        # Augmentation capex (signed negative in its year) is a cost of
        # storage: into the numerator, same end-of-period discounting.
        aug = -row["capex_gbp"]
        q = row["discharged_mwh"]
        charging = (q / eta) * s_lo if (s_lo is not None and eta) else 0
        cost_num += (x + g + charging + aug) / (1 + r) ** n
        energy_denom += q / (1 + r) ** n
    return cost_num / energy_denom if energy_denom > 0 else None


def reanchor_npv(npv_at_commissioning, r, y0, valuation_date):
    """Mirrors Metrics.reanchorNpv exactly (owner request, 2026-07): one
    exact compounding factor moves the headline NPV from t=0 (the
    commissioning date) to any other valuation date, in either
    direction:

        reanchor_npv(npv_at_commissioning, r, y0, valuation_date) =
            npv_at_commissioning * (1 + r) ** (years from y0 to
                                                 valuation_date)

    Years use a 365.25-day year. A valuation date after commissioning
    compounds the NPV forward (positive exponent); a valuation date
    before commissioning (a pre-decision appraisal) discounts it back
    (negative exponent) — the same formula covers both, deliberately.

    Null-safe: a missing/unparseable y0 or valuation_date returns
    npv_at_commissioning unchanged (factor 1), matching the JS side's
    "no reference date to measure a span against" reasoning. IRR,
    simple payback and LCOS are anchor-invariant / self-cancelling and
    must never be passed through this function — see the JS
    docstring for why."""
    if npv_at_commissioning is None or r is None:
        return npv_at_commissioning
    if not y0 or not valuation_date:
        return npv_at_commissioning
    try:
        d0 = date.fromisoformat(y0[:10])
        d1 = date.fromisoformat(valuation_date[:10])
    except ValueError:
        return npv_at_commissioning
    years = (d1 - d0).days / 365.25
    return npv_at_commissioning * (1 + r) ** years


def compute(inputs):
    """Convenience wrapper mirroring the four headline figures the card
    shows (NPV, IRR, simple payback, indicative LCOS), for the parity
    fixtures. `inputs` carries the engine inputs plus `sLo` (optional,
    for the LCOS charging term) and `valuationDate` (optional, owner
    request 2026-07: an ISO date to re-anchor the headline NPV to,
    defaulting to `y0`/commissioning when absent) — see
    bess_cashflow()'s docstring. The headline "npv" is computed under
    the SAME discounting convention as bess_cashflow's own discounted
    columns (inputs["discounting"], "mid" default), so
    "npv_at_commissioning" matches cf["rows"][-1]["cumulative_discounted_gbp"]
    exactly, and "npv" is that same figure re-anchored to
    inputs["valuationDate"] via reanchor_npv() — identical (factor 1)
    when valuationDate is absent, so every existing fixture (none of
    which sets it) is unaffected. "irr" stays convention-independent
    (npv()'s own "end"/1.0 defaults), per discount_exponent's
    docstring, and is never re-anchored (see reanchor_npv's docstring
    for why neither IRR, payback nor LCOS should be). "discounted_payback"
    is anchor-invariant by construction (see discounted_payback's own
    docstring) so it is never re-anchored either. "pvi" is
    pvi_at_commissioning re-anchored by the SAME factor as "npv" (one
    call to reanchor_npv each, sharing r/y0/valuation_date), so "dpi"
    (1 + npv/pvi) can use the two re-anchored figures directly: the
    shared factor cancels in the ratio, so dpi is anchor-invariant too,
    without needing to say so at the call site. dpi is None rather than
    a divide-by-zero/negative-flip when pvi is not positive.

    Toll/debt pass (plan/10 D54/D55): "d0" is the debt drawdown
    (0 when the layer is inactive); "equity_irr" is irr() over the
    equity_cashflow_gbp column with c0 - d0 as the time-zero outflow,
    and is None when d0 == 0 — an ungeared "equity IRR" would just
    duplicate the project IRR (equity flows ARE the project flows),
    so the card shows no tile rather than a repeated figure.
    "dscr_min"/"dscr_avg"/"dscr_min_toll"/"dscr_min_post" come from
    dscr_stats() over the same rows (all None when no year carries
    debt service)."""
    cf = bess_cashflow(inputs)
    if cf is None:
        return {"error": "missing input"}
    c0 = cf["c0"]
    cashflows = [row["net_cashflow_gbp"] for row in cf["rows"] if row["year"] >= 1]
    r = inputs["r"]
    discounting = inputs.get("discounting") or "mid"
    y0 = inputs.get("y0")
    frac1 = year_fraction_remaining(y0)
    npv_at_commissioning = npv(c0, cashflows, r, discounting, frac1)
    valuation_date = inputs.get("valuationDate")
    npv_value = reanchor_npv(npv_at_commissioning, r, y0, valuation_date)
    pvi_at_commissioning_value = pvi_at_commissioning(
        c0, cf["rows"], r, discounting, frac1)
    pvi_value = reanchor_npv(pvi_at_commissioning_value, r, y0, valuation_date)
    dpi_value = 1 + npv_value / pvi_value if (pvi_value is not None
                                               and pvi_value > 0) else None
    d0 = cf["d0"]
    equity_flows = [row["equity_cashflow_gbp"] for row in cf["rows"]
                    if row["year"] >= 1]
    # None, not a number, when ungeared: with d0 == 0 the equity flows
    # are the project flows and an "equity IRR" would silently duplicate
    # the project IRR — the card shows no tile instead.
    equity_irr = irr(c0 - d0, equity_flows) if d0 > 0 else None
    toll_tenor_int = int(inputs.get("tollTenor", 0) or 0)
    stats = dscr_stats(cf["rows"], toll_tenor_int)
    return {
        "c0": c0,
        "d0": d0,
        "rows": cf["rows"],
        "equity_irr": equity_irr,
        "dscr_min": stats["min"] if stats else None,
        "dscr_avg": stats["avg"] if stats else None,
        "dscr_min_toll": stats["minToll"] if stats else None,
        "dscr_min_post": stats["minPost"] if stats else None,
        "npv": npv_value,
        "npv_at_commissioning": npv_at_commissioning,
        "irr": irr(c0, cashflows),
        "mirr": mirr(c0, cashflows, r),
        "simple_payback": simple_payback(c0, cashflows),
        "discounted_payback": discounted_payback(cf["rows"]),
        "pvi": pvi_value,
        "dpi": dpi_value,
        "lcos": lcos(c0, cf["rows"], r, inputs.get("eta"), inputs.get("sLo")),
    }
