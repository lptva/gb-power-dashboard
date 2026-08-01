#!/usr/bin/env python3
"""Stdlib A1 formula evaluator for the BESS calculator's Excel export
(plan/09, D38/D39), used only by tests/test_bess_calculator.py's
WorkbookExport class. Not imported by the app or the ETL.

Two jobs, kept separate:

  load_workbook(data)  parses a .xlsx (zipfile + ElementTree, no
                       third-party library) into a plain cell-map model
                       plus the workbook's defined names and sheet
                       order, so a test can also run its OWN structural
                       assertions (part list, ascending rows, no macro)
                       straight off the same zip.

  Grid(model, names)   evaluates formulas over that model with a small
                       A1 evaluator over a CLOSED grammar: numbers,
                       quoted strings, `Sheet!$A$1`/`A1` references,
                       `A1:B9` ranges, `+ - * / ^`, `= <> < > <= >=`,
                       and exactly SUM, SUMPRODUCT, IF, IFERROR, AND,
                       OR, MIN, MAX, ROUND, POWER, DATE, YEAR, IRR, NPV,
                       MIRR. Anything outside that raises ValueError, which is
                       a feature: a future formula using a function this
                       evaluator does not know fails the suite loudly
                       rather than being silently waved through.

Three things a naive rewrite gets wrong, each hit while building this:

  1. IF and IFERROR must be LAZY: parse the argument list into token
     ranges without evaluating, then evaluate only the branch taken. An
     eager IF divides by zero in the payback formula's false branch on
     a cash flow that never repays.
  2. Cell evaluation recurses into the SAME parser instance (a formula
     cell can reference another formula cell), so the parser's own
     position must be saved and restored around every cell lookup.
  3. That restore must happen in a `finally`: IFERROR catching an
     exception from a half-consumed argument would otherwise leave the
     parser mid-expression.

IRR raises ValueError on no sign change (Excel's own #NUM!), which the
workbook's own IFERROR(...) wrapper turns into "no IRR": exactly like
the rest of this evaluator, errors are how Excel semantics are
reproduced, not swallowed early.
"""

import io
import math
import re
import zipfile
from datetime import date, timedelta
from xml.etree import ElementTree as ET

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


# --------------------------------------------------------- A1 helpers -----

def col_num(letters):
    n = 0
    for ch in letters:
        n = n * 26 + (ord(ch) - 64)
    return n


def col_name(n):
    s = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        s = chr(65 + rem) + s
    return s


# ---------------------------------------------------------- workbook -----

def load_workbook(data):
    """Parse a minimal .xlsx (as app/js/xlsx.js writes it) into
    (model, defined_names, sheet_order, part_names).

    `data` may be a path, a file-like object, or raw bytes. `model` is
    {sheet_name: {row_int: {col_int: {"t": "n"/"s"/"f", "v": ...}}}}.
    `defined_names` is {NAME: "Sheet!$A$1"}. `part_names` is the raw
    zip member list, for the structural tests (part count, no macro/
    external-link/calcChain parts) to check directly."""
    src = io.BytesIO(data) if isinstance(data, (bytes, bytearray)) else data
    with zipfile.ZipFile(src) as zf:
        part_names = zf.namelist()
        wb_xml = ET.fromstring(zf.read("xl/workbook.xml"))
        sheet_names = [el.get("name") for el in wb_xml.find("m:sheets", NS)]

        defined_names = {}
        dn_el = wb_xml.find("m:definedNames", NS)
        if dn_el is not None:
            for el in dn_el:
                defined_names[el.get("name")] = el.text

        model = {}
        for i, name in enumerate(sheet_names, start=1):
            ws_xml = ET.fromstring(zf.read("xl/worksheets/sheet%d.xml" % i))
            sheet_model = {}
            sheet_data = ws_xml.find("m:sheetData", NS)
            for row_el in (sheet_data if sheet_data is not None else []):
                r = int(row_el.get("r"))
                row_model = {}
                for c_el in row_el:
                    ref = c_el.get("r")
                    m = re.match(r"([A-Z]+)([0-9]+)", ref)
                    col = col_num(m.group(1))
                    f_el = c_el.find("m:f", NS)
                    if f_el is not None:
                        row_model[col] = {"t": "f", "v": f_el.text or ""}
                        continue
                    if c_el.get("t") == "inlineStr":
                        is_el = c_el.find("m:is", NS)
                        t_el = is_el.find("m:t", NS) if is_el is not None else None
                        row_model[col] = {"t": "s", "v": (t_el.text if t_el is not None
                                                          and t_el.text is not None else "")}
                        continue
                    v_el = c_el.find("m:v", NS)
                    row_model[col] = {"t": "n",
                                     "v": float(v_el.text) if v_el is not None else 0.0}
                sheet_model[r] = row_model
            model[name] = sheet_model
    return model, defined_names, sheet_names, part_names


# ------------------------------------------------------------ dates ------

EPOCH = date(1899, 12, 30)


def date_to_serial(y, m, d):
    return float((date(y, m, d) - EPOCH).days)


def serial_to_year(s):
    return (EPOCH + timedelta(days=int(s))).year


# -------------------------------------------------------------- IRR ------

def excel_irr(vals, lo=-0.9999, hi=10.0):
    def f(r):
        return sum(v / (1 + r) ** i for i, v in enumerate(vals))

    f_lo, f_hi = f(lo), f(hi)
    if (f_lo > 0) == (f_hi > 0):
        raise ValueError("#NUM!")  # no sign change: Excel's IRR() error
    for _ in range(200):
        mid = (lo + hi) / 2
        f_mid = f(mid)
        if abs(f_mid) < 1e-10:
            return mid
        if (f_mid > 0) == (f_lo > 0):
            lo, f_lo = mid, f_mid
        else:
            hi = mid
    return (lo + hi) / 2


def excel_mirr(vals, frate, rrate):
    """Excel MIRR() semantics over a year-0..year-T range: positives
    compound to the horizon at the reinvestment rate, negatives
    discount to t=0 at the finance rate, and
    MIRR = (FV_pos / -PV_neg)^(1/T) - 1 with T = len(vals) - 1.
    Raises (so IFERROR catches it, like Excel's #DIV/0!) when the
    series lacks a positive or a negative value."""
    n = len(vals) - 1
    if n < 1:
        raise ValueError("#DIV/0!")
    fv_pos = sum(v * (1 + rrate) ** (n - i)
                 for i, v in enumerate(vals) if v > 0)
    pv_neg = sum(v / (1 + frate) ** i
                 for i, v in enumerate(vals) if v < 0)
    if fv_pos <= 0 or pv_neg >= 0:
        raise ValueError("#DIV/0!")  # Excel: needs both signs present
    return (fv_pos / -pv_neg) ** (1.0 / n) - 1


# --------------------------------------------------------- tokeniser -----

TOK = re.compile(r"""
    (?P<ref>(?:[A-Za-z_][A-Za-z0-9_]*!)?\$?[A-Z]{1,3}\$?[0-9]{1,5})
  | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)
  | (?P<num>[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)
  | (?P<str>"[^"]*")
  | (?P<op><=|>=|<>|[-+*/^(),:<>=%])
""", re.X)


def tokenise(formula):
    out, i = [], 0
    while i < len(formula):
        if formula[i] in " \t":
            i += 1
            continue
        m = TOK.match(formula, i)
        if not m:
            raise ValueError("bad token at %r in %r" % (formula[i:], formula))
        out.append((m.lastgroup, m.group()))
        i = m.end()
    return out


# -------------------------------------------------------------- Grid -----

class Grid:
    """Evaluates the cell map `model` (see load_workbook's docstring for
    its shape). `names` resolves workbook-level defined names (e.g.
    {"WACC": "DCF!$D$6"}) used bare in formulas. One Grid caches every
    cell it has resolved, so re-evaluating the same model twice (e.g.
    after flipping the mid-year flag, D39's test 8) needs a fresh
    Grid, since cells are not designed to be mutated in place."""

    def __init__(self, model, names=None):
        self.m = model
        self.names = {k.upper(): v for k, v in (names or {}).items()}
        self.cache = {}
        self.toks = []
        self.pos = 0
        self.sheet = None

    def value(self, sheet, ref):
        ref = ref.replace("$", "")
        if "!" in ref:
            sheet, ref = ref.split("!")
        m = re.match(r"([A-Z]+)([0-9]+)", ref)
        ci, r = col_num(m.group(1)), int(m.group(2))
        key = (sheet, ci, r)
        if key in self.cache:
            v = self.cache[key]
            if v == "__CYCLE__":
                raise ValueError("circular reference at %s" % (key,))
            return v
        spec = self.m.get(sheet, {}).get(r, {}).get(ci)
        if spec is None:
            self.cache[key] = 0.0
            return 0.0
        self.cache[key] = "__CYCLE__"
        if spec["t"] == "n":
            v = float(spec["v"])
        elif spec["t"] == "s":
            v = spec["v"]
        else:
            saved = (self.toks, self.pos, self.sheet)
            try:
                v = self.evaluate(spec["v"], sheet)
            finally:
                self.toks, self.pos, self.sheet = saved
        self.cache[key] = v
        return v

    def rng(self, sheet, a, b):
        if "!" in a:
            sheet, a = a.split("!")
        b = b.split("!")[-1]
        a, b = a.replace("$", ""), b.replace("$", "")
        ma = re.match(r"([A-Z]+)([0-9]+)", a)
        mb = re.match(r"([A-Z]+)([0-9]+)", b)
        c1, r1 = col_num(ma.group(1)), int(ma.group(2))
        c2, r2 = col_num(mb.group(1)), int(mb.group(2))
        out = []
        for r in range(min(r1, r2), max(r1, r2) + 1):
            for c in range(min(c1, c2), max(c1, c2) + 1):
                out.append(self.value(sheet, "%s%d" % (col_name(c), r)))
        return out

    def evaluate(self, formula, sheet):
        self.toks = tokenise(formula)
        self.pos = 0
        self.sheet = sheet
        v = self.expr()
        if self.pos != len(self.toks):
            raise ValueError("trailing tokens in %r" % formula)
        return v

    def peek(self):
        return self.toks[self.pos] if self.pos < len(self.toks) else (None, None)

    def take(self):
        t = self.toks[self.pos]
        self.pos += 1
        return t

    # ------------------------------------------------ recursive descent --
    def expr(self):
        left = self.arith()
        k, v = self.peek()
        if k == "op" and v in ("=", "<", ">", "<=", ">=", "<>"):
            self.take()
            right = self.arith()
            if v == "=":
                return left == right
            if v == "<>":
                return left != right
            if v == "<":
                return left < right
            if v == ">":
                return left > right
            if v == "<=":
                return left <= right
            return left >= right
        return left

    def arith(self):
        v = self.term()
        while True:
            k, o = self.peek()
            if k == "op" and o in "+-":
                self.take()
                r = self.term()
                v = v + r if o == "+" else v - r
            else:
                return v

    def term(self):
        v = self.power()
        while True:
            k, o = self.peek()
            if k == "op" and o in "*/":
                self.take()
                r = self.power()
                v = v * r if o == "*" else v / r
            else:
                return v

    def power(self):
        v = self.unary()
        k, o = self.peek()
        if k == "op" and o == "^":
            self.take()
            return v ** self.power()
        return v

    def unary(self):
        k, o = self.peek()
        if k == "op" and o in "+-":
            self.take()
            v = self.unary()
            return -v if o == "-" else v
        return self.atom()

    def atom(self):
        k, v = self.take()
        if k == "num":
            return float(v)
        if k == "str":
            return v[1:-1]
        if k == "op" and v == "(":
            e = self.expr()
            if self.take()[1] != ")":
                raise ValueError("expected ) in expression")
            return e
        if k == "ref":
            if self.peek() == ("op", ":"):
                self.take()
                b = self.take()[1]
                return ("RANGE", v, b)
            return self.value(self.sheet, v)
        if k == "name":
            if self.peek() == ("op", "("):
                return self.call(v.upper())
            if v.upper() in self.names:
                return self.value(self.sheet, self.names[v.upper()])
            raise ValueError("unknown name %r" % v)
        raise ValueError("unexpected token %r" % (v,))

    def arg_ranges(self):
        """Split a call's argument list into (start, end) TOKEN ranges
        without evaluating any of them, so IF/IFERROR can be lazy."""
        if self.take()[1] != "(":
            raise ValueError("expected ( after function name")
        out, depth, start = [], 0, self.pos
        while True:
            _, v = self.toks[self.pos]
            if v == "(":
                depth += 1
            elif v == ")":
                if depth == 0:
                    if self.pos > start:
                        out.append((start, self.pos))
                    self.pos += 1
                    return out
                depth -= 1
            elif v == "," and depth == 0:
                out.append((start, self.pos))
                start = self.pos + 1
            self.pos += 1

    def eval_range(self, token_range):
        save = self.pos
        try:
            self.pos = token_range[0]
            v = self.expr()
            if self.pos != token_range[1]:
                raise ValueError("argument not fully consumed")
            return v
        finally:
            self.pos = save

    def args(self):
        return [self.eval_range(r) for r in self.arg_ranges()]

    def flat(self, a):
        if isinstance(a, tuple) and a and a[0] == "RANGE":
            return self.rng(self.sheet, a[1], a[2])
        return [a]

    def nums(self, a):
        return [x for x in self.flat(a)
                if isinstance(x, (int, float)) and not isinstance(x, bool)]

    def call(self, fn):
        if fn in ("IF", "IFERROR"):
            ranges = self.arg_ranges()
            if fn == "IFERROR":
                try:
                    return self.eval_range(ranges[0])
                except (ZeroDivisionError, ValueError, TypeError):
                    return self.eval_range(ranges[1]) if len(ranges) > 1 else "#ERR"
            cond = self.eval_range(ranges[0])
            if cond:
                return self.eval_range(ranges[1])
            return self.eval_range(ranges[2]) if len(ranges) > 2 else False

        a = self.args()
        if fn == "SUM":
            return sum(x for arg in a for x in self.nums(arg))
        if fn == "SUMPRODUCT":
            cols = [self.nums(x) for x in a]
            return sum(math.prod(vals) for vals in zip(*cols))
        if fn == "AND":
            return all(a)
        if fn == "OR":
            return any(a)
        if fn == "MIN":
            return min(x for arg in a for x in self.nums(arg))
        if fn == "MAX":
            return max(x for arg in a for x in self.nums(arg))
        if fn == "ROUND":
            return round(a[0], int(a[1]))
        if fn == "POWER":
            # Owner request, 2026-08-01: the OPEX escalation formula's
            # POWER(1+esc, year-1) — the grammar already evaluates `^`
            # (see the parser's power() rule below), so this is the same
            # operation under Excel's function name rather than new math.
            return a[0] ** a[1]
        if fn == "YEAR":
            return serial_to_year(a[0])
        if fn == "DATE":
            return date_to_serial(int(a[0]), int(a[1]), int(a[2]))
        if fn == "IRR":
            return excel_irr(self.nums(a[0]))
        if fn == "MIRR":
            return excel_mirr(self.nums(a[0]), a[1], a[2])
        if fn == "NPV":
            r = a[0]
            vals = self.nums(a[1])
            return sum(v / (1 + r) ** (i + 1) for i, v in enumerate(vals))
        raise ValueError("unsupported function %s: closed grammar, see module "
                         "docstring" % fn)
