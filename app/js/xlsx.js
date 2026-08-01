/* xlsx.js, a dependency-free, store-only XLSX writer (plan/09, D35-D38).
   No build step, no new dependency, nothing written to browser storage:
   the whole app has one vendored dependency (ECharts) already and this
   export is not a reason to acquire a second. An .xlsx is a ZIP of XML;
   this file hand-rolls both, because the workbook shape here is fixed
   (one layout, no charts, no images, no shared formulas, no pivot
   tables, a few hundred cells), which is exactly the case that makes a
   general-purpose writer unnecessary weight.

   Public surface, deliberately tiny:
     Xlsx.build(workbook) -> Uint8Array
     Xlsx.dateSerial(iso)  -> Excel serial day number (1899-12-30 epoch)

   `workbook` shape (plain object, no XML in the caller):
     {
       definedNames: [{ name: "WACC", ref: "DCF!$D$6" }],
       sheets: [
         { name: "Cover", cols: [[3,3,44],[5,5,18]], freeze: 0, cells: {...} },
         ...
       ]
     }
   `cells` is a sparse map keyed by A1 ref, e.g.
     { "C3": {t:"s", v:"...", s:3}, "E45": {t:"f", v:"SUM(F34:U34)", s:8} }
   `t` is "s" (inline string), "n" (number) or "f" (formula, no cached
   value: every workbook this writer produces sets
   <calcPr fullCalcOnLoad="1"/> so the reader recalculates on open).
   `s` is an index into the vendored style table in STYLES_XML below
   (the owner's own named cell styles); 0 (the default) is omitted
   from the emitted cell. `cols` entries are [min, max, width] or
   [min, max, width, styleIndex]; `zoom` sets the sheet's zoom.

   Deliberately NOT supported, because nothing here needs it: shared
   strings (inlineStr is used throughout: a few repeated label bytes
   cost less than a shared-string table), DEFLATE (store-only; a
   15-year model is tens of kB uncompressed, not worth a compressor),
   calcChain.xml (optional, and a wrong one is worse than none),
   macros, external links, charts, images, pivot tables. A theme part
   IS shipped, unlike every earlier revision of this file: the owner's
   vendored named cell styles resolve several colours through it. */

const Xlsx = (() => {

  /* ---------------------------------------------------------- CRC32 --- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* --------------------------------------------------------- XML esc -- */
  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ------------------------------------------------------- A1 helpers - */
  function colName(i) {
    let s = "";
    while (i > 0) {
      const rem = (i - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function colIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n;
  }

  /* Excel serial day from the 1899-12-30 epoch, e.g. "2027-03-01" -> a
     whole number. workbookPr is left bare in every workbook this writer
     emits, so the 1904 date system never applies. */
  function dateSerial(iso) {
    const d = new Date(iso + "T00:00:00Z");
    return Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
  }

  /* ------------------------------------------------------ store ZIP --- */
  function u16le(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32le(n) {
    return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
  }
  function asciiBytes(s) {
    const out = new Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xFF;
    return out;
  }
  function appendAll(dst, src) {
    for (let i = 0; i < src.length; i++) dst.push(src[i]);
  }
  function dosDateTime() {
    const d = new Date();
    return {
      dostime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
      dosdate: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    };
  }

  /* parts: [[name, Uint8Array], ...]. Everything little-endian, method 0
     (store), no data descriptors, no zip64: every size is known before
     any header is written because each part is built as a string and
     encoded first. */
  function storeZip(parts) {
    const out = [];
    const central = [];
    const { dostime, dosdate } = dosDateTime();
    let offset = 0;
    parts.forEach(([name, data]) => {
      const nameBytes = asciiBytes(name);
      const crc = crc32(data);
      const size = data.length;
      const local = [].concat(
        [0x50, 0x4B, 0x03, 0x04], u16le(20), u16le(0), u16le(0),
        u16le(dostime), u16le(dosdate), u32le(crc), u32le(size), u32le(size),
        u16le(nameBytes.length), u16le(0), nameBytes);
      appendAll(out, local);
      appendAll(out, Array.from(data));
      const centralEntry = [].concat(
        [0x50, 0x4B, 0x01, 0x02], u16le(20), u16le(20), u16le(0), u16le(0),
        u16le(dostime), u16le(dosdate), u32le(crc), u32le(size), u32le(size),
        u16le(nameBytes.length), u16le(0), u16le(0), u16le(0), u16le(0), u32le(0),
        u32le(offset), nameBytes);
      appendAll(central, centralEntry);
      offset += local.length + data.length;
    });
    const cdOffset = offset;
    const cdSize = central.length;
    const eocd = [].concat(
      [0x50, 0x4B, 0x05, 0x06], u16le(0), u16le(0),
      u16le(parts.length), u16le(parts.length),
      u32le(cdSize), u32le(cdOffset), u16le(0));
    const all = out.concat(central).concat(eocd);
    return new Uint8Array(all);
  }

  /* ---------------------------------------------------- static parts -- */
  const ROOT_RELS =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/' +
    'relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  /* The style tables are VENDORED VERBATIM from the owner's own
     formatted workbook (2026-07-31, "gb_bess_calculator_mirr_check_
     format.xlsx"), not rebuilt here: that file defines thirteen NAMED
     cell styles (![M]Input, ![M]Link, ![M]Formula, ![M]Percent,
     ![M]Date, ![M]ChangeF, ![M]HardNumber, ![M]KPI, ![M]KeyOutput,
     ![M]Special, ![M]Check, ![M]Comment, ![M]Unused) whose whole
     point is that they appear in Excel's cell-style gallery, so a
     reader can restyle a cell by picking the same named style the
     model already uses. Rebuilding them by hand would reproduce the
     appearance and lose the gallery entries, which is the part the
     owner actually asked for. Every cell this writer emits therefore
     carries an `s` index INTO THIS TABLE (see BESS_XF in charts.js for
     the role-to-index map), and `xl/theme/theme1.xml` ships alongside
     because several of these fonts and fills resolve their colours
     through the theme.

     Four cellXfs are appended to the vendored table, past what the
     source file itself carries (indices 0-56): index 56 is ![M]Link
     with the one-decimal percent format, for the Cover's IRR and MIRR
     links (the source file's own Link+percent variant, index 46,
     carries a format that renders a fraction like 0.13 as "0 %", which
     would misreport both figures on the Cover). Indices 57-59 are the
     owner's picture-frame revision (2026-08-01), each a same-role
     variant with only the number format changed: 57 is ![M]Input with
     numFmtId 1 (plain integer, no thousands separator) for the
     Augmentation year cell, which is a year number, not a magnitude;
     58 is ![M]HardNumber and 59 is ![M]Formula, both with numFmtId 175
     (four decimal places, dash-zero), for the family day-rate cells
     and their derived totals on the Assumptions sheet, whose GBP/kW/day
     values are too small for one decimal place to show anything (see
     BESS_XF in charts.js for the role-to-index map). */
  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    "<styleSheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" mc:Ignorable=\"x14ac x16r2 xr\" xmlns:x14ac=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac\" xmlns:x16r2=\"http://schemas.microsoft.com/office/spreadsheetml/2015/02/main\" xmlns:xr=\"http://schemas.microsoft.com/office/spreadsheetml/2014/revision\"><numFmts count=\"13\"><numFmt numFmtId=\"164\" formatCode=\"#,##0.0;\\(#,##0.0\\);&quot;-&quot;\"/><numFmt numFmtId=\"165\" formatCode=\"0.0%\"/><numFmt numFmtId=\"166\" formatCode=\"&quot;\u00a3&quot;#,##0;\\(&quot;\u00a3&quot;#,##0\\);&quot;-&quot;\"/><numFmt numFmtId=\"167\" formatCode=\"#,##0.00;\\(#,##0.00\\);&quot;-&quot;\"/><numFmt numFmtId=\"168\" formatCode=\"_(#,##0_);\\(#,##0\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"169\" formatCode=\"_(###0.0%_);\\(###0.0%\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"170\" formatCode=\"#,##0;\\(#,##0\\);\\-;@\"/><numFmt numFmtId=\"171\" formatCode=\"#,##0\\ ;\\(#,##0\\);\\-&quot; &quot;\"/><numFmt numFmtId=\"172\" formatCode=\"_(#,##0_%\\);\\(#,##0%\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"173\" formatCode=\"_(#,##0.0%_);\\(#,##0.0%\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"174\" formatCode=\"_(#,##0.0_);\\(#,##0.0\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"176\" formatCode=\"_(#,##0.0\\x_);\\(#,##0.0\\x\\);&quot;-&quot;_);_(@_)\"/><numFmt numFmtId=\"175\" formatCode=\"#,##0.0000;\\(#,##0.0000\\);&quot;-&quot;\"/></numFmts><fonts count=\"18\" x14ac:knownFonts=\"1\"><font><sz val=\"10\"/><color rgb=\"FF000000\"/><name val=\"Arial\"/></font><font><b/><sz val=\"10\"/><color rgb=\"FF000000\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><b/><sz val=\"11\"/><color rgb=\"FFFFFFFF\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><i/><sz val=\"9\"/><color rgb=\"FF666666\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><sz val=\"10\"/><color rgb=\"FF000000\"/><name val=\"Arial\"/><family val=\"2\"/></font><font><sz val=\"18\"/><color theme=\"3\"/><name val=\"Aptos Display\"/><family val=\"2\"/><scheme val=\"major\"/></font><font><sz val=\"10\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"10\"/><color rgb=\"FF00B050\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"10\"/><color rgb=\"FF0432FF\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><b/><sz val=\"10\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"10\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><i/><sz val=\"10\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"8\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"10\"/><color rgb=\"FF05B050\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><i/><sz val=\"10\"/><color rgb=\"FF0332FF\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><sz val=\"10\"/><color rgb=\"FF0332FF\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><i/><sz val=\"10\"/><color theme=\"1\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font><font><i/><sz val=\"10\"/><color theme=\"1\" tint=\"0.499984740745262\"/><name val=\"Arial\"/><family val=\"2\"/><charset val=\"204\"/></font></fonts><fills count=\"12\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF085393\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFFFF2CC\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFE7E6E6\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor theme=\"0\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor theme=\"0\" tint=\"-4.9989318521683403E-2\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"gray125\"><fgColor theme=\"1\" tint=\"0.499984740745262\"/><bgColor auto=\"1\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFFFF3CC\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF90D5FF\"/><bgColor indexed=\"64\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FF90D5FF\"/></patternFill></fill><fill><patternFill patternType=\"solid\"><fgColor rgb=\"FFE8E6E6\"/><bgColor indexed=\"64\"/></patternFill></fill></fills><borders count=\"6\"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style=\"medium\"><color auto=\"1\"/></bottom><diagonal/></border><border><left style=\"hair\"><color theme=\"0\" tint=\"-0.24994659260841701\"/></left><right style=\"hair\"><color theme=\"0\" tint=\"-0.24994659260841701\"/></right><top style=\"hair\"><color theme=\"0\" tint=\"-0.24994659260841701\"/></top><bottom style=\"hair\"><color theme=\"0\" tint=\"-0.24994659260841701\"/></bottom><diagonal/></border><border><left style=\"hair\"><color theme=\"0\" tint=\"-0.34998626667073579\"/></left><right style=\"hair\"><color theme=\"0\" tint=\"-0.34998626667073579\"/></right><top style=\"hair\"><color theme=\"0\" tint=\"-0.34998626667073579\"/></top><bottom style=\"hair\"><color theme=\"0\" tint=\"-0.34998626667073579\"/></bottom><diagonal/></border><border><left style=\"hair\"><color theme=\"0\" tint=\"-0.14993743705557422\"/></left><right style=\"hair\"><color theme=\"0\" tint=\"-0.14993743705557422\"/></right><top style=\"hair\"><color theme=\"0\" tint=\"-0.14993743705557422\"/></top><bottom style=\"hair\"><color theme=\"0\" tint=\"-0.14993743705557422\"/></bottom><diagonal/></border><border><left/><right/><top style=\"thin\"><color theme=\"1\"/></top><bottom style=\"thin\"><color theme=\"1\"/></bottom><diagonal/></border></borders><cellStyleXfs count=\"16\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/><xf numFmtId=\"9\" fontId=\"4\" fillId=\"0\" borderId=\"0\" applyFont=\"0\" applyFill=\"0\" applyBorder=\"0\" applyAlignment=\"0\" applyProtection=\"0\"/><xf numFmtId=\"0\" fontId=\"5\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"0\" applyFill=\"0\" applyBorder=\"0\" applyAlignment=\"0\" applyProtection=\"0\"/><xf numFmtId=\"174\" fontId=\"15\" fillId=\"8\" borderId=\"2\" applyBorder=\"0\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"13\" fillId=\"5\" borderId=\"2\" applyBorder=\"0\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"170\" fontId=\"10\" fillId=\"0\" borderId=\"3\" applyNumberFormat=\"0\" applyBorder=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"173\" fontId=\"11\" fillId=\"0\" borderId=\"3\" applyBorder=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"14\" fontId=\"10\" fillId=\"0\" borderId=\"3\" applyBorder=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"171\" fontId=\"10\" fillId=\"6\" borderId=\"3\" applyNumberFormat=\"0\" applyAlignment=\"0\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"12\" fillId=\"7\" borderId=\"0\" applyNumberFormat=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"14\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"0\" applyFill=\"0\" applyBorder=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"9\" fillId=\"6\" borderId=\"5\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"10\" fillId=\"10\" borderId=\"4\" applyBorder=\"0\" applyAlignment=\"0\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"17\" fillId=\"0\" borderId=\"0\" applyNumberFormat=\"0\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"16\" fillId=\"0\" borderId=\"0\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"15\" fillId=\"0\" borderId=\"3\" applyBorder=\"0\"><alignment vertical=\"center\"/></xf></cellStyleXfs><cellXfs count=\"65\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/><xf numFmtId=\"0\" fontId=\"2\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"6\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"4\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"8\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"7\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"6\" fillId=\"3\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"4\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFill=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"9\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\"/><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"0\" fillId=\"2\" borderId=\"0\" xfId=\"0\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"9\" fillId=\"6\" borderId=\"5\" xfId=\"11\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"6\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"4\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"6\" fillId=\"9\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"0\" fontId=\"17\" fillId=\"0\" borderId=\"0\" xfId=\"13\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"0\" borderId=\"1\" xfId=\"0\" applyFont=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"1\" fillId=\"4\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyFill=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"17\" fillId=\"0\" borderId=\"0\" xfId=\"13\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"16\" fillId=\"0\" borderId=\"0\" xfId=\"14\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"9\" fillId=\"6\" borderId=\"5\" xfId=\"11\" applyAlignment=\"1\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"173\" fontId=\"9\" fillId=\"6\" borderId=\"5\" xfId=\"11\" applyNumberFormat=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"166\" fontId=\"17\" fillId=\"0\" borderId=\"0\" xfId=\"13\" applyNumberFormat=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"165\" fontId=\"17\" fillId=\"0\" borderId=\"0\" xfId=\"13\" applyNumberFormat=\"1\"><alignment horizontal=\"left\" vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"15\" fillId=\"8\" borderId=\"0\" xfId=\"3\" applyBorder=\"1\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"15\" fillId=\"8\" borderId=\"0\" xfId=\"3\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"169\" fontId=\"15\" fillId=\"8\" borderId=\"0\" xfId=\"3\" applyNumberFormat=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"15\" fillId=\"0\" borderId=\"0\" xfId=\"15\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"5\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"173\" fontId=\"11\" fillId=\"0\" borderId=\"0\" xfId=\"6\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"14\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"7\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"10\" fillId=\"6\" borderId=\"0\" xfId=\"8\" applyNumberFormat=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"12\" fillId=\"7\" borderId=\"0\" xfId=\"9\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"169\" fontId=\"14\" fillId=\"0\" borderId=\"0\" xfId=\"10\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"172\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyNumberFormat=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyBorder=\"1\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"10\" fillId=\"10\" borderId=\"0\" xfId=\"12\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"0\" fontId=\"3\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyFont=\"1\" applyAlignment=\"1\"><alignment horizontal=\"left\" vertical=\"center\" indent=\"1\"/></xf><xf numFmtId=\"164\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"5\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"14\" fontId=\"15\" fillId=\"8\" borderId=\"0\" xfId=\"3\" applyNumberFormat=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"167\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"5\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"14\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"9\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"1\" applyFont=\"1\" applyFill=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment horizontal=\"right\" vertical=\"center\"/></xf><xf numFmtId=\"173\" fontId=\"13\" fillId=\"5\" borderId=\"0\" xfId=\"4\" applyNumberFormat=\"1\" applyBorder=\"1\"/><xf numFmtId=\"1\" fontId=\"15\" fillId=\"8\" borderId=\"0\" xfId=\"3\" applyNumberFormat=\"1\" applyBorder=\"1\" applyAlignment=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"175\" fontId=\"15\" fillId=\"0\" borderId=\"0\" xfId=\"15\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"175\" fontId=\"10\" fillId=\"0\" borderId=\"0\" xfId=\"5\" applyNumberFormat=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"9\" fillId=\"11\" borderId=\"0\" xfId=\"11\" applyFill=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"173\" fontId=\"9\" fillId=\"11\" borderId=\"0\" xfId=\"11\" applyNumberFormat=\"1\" applyFill=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"174\" fontId=\"9\" fillId=\"11\" borderId=\"0\" xfId=\"11\" applyNumberFormat=\"1\" applyFill=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"176\" fontId=\"9\" fillId=\"11\" borderId=\"0\" xfId=\"11\" applyNumberFormat=\"1\" applyFill=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf><xf numFmtId=\"168\" fontId=\"9\" fillId=\"0\" borderId=\"0\" xfId=\"11\" applyFill=\"1\" applyBorder=\"1\"><alignment vertical=\"center\"/></xf></cellXfs><cellStyles count=\"16\"><cellStyle name=\"![M]ChangeF\" xfId=\"8\" xr:uid=\"{5FFECF36-0652-7447-BD24-DE02E5145FA3}\"/><cellStyle name=\"![M]Check\" xfId=\"13\" xr:uid=\"{5583B40D-58F6-C746-9C4F-C27174D98BD5}\"/><cellStyle name=\"![M]Comment\" xfId=\"14\" xr:uid=\"{78148E43-8C37-3C48-B1B4-D98D56D6AB2D}\"/><cellStyle name=\"![M]Date\" xfId=\"7\" xr:uid=\"{7D4DB1F9-54B3-FD43-9DCD-A319DDFC556A}\"/><cellStyle name=\"![M]Formula\" xfId=\"5\" xr:uid=\"{6B0AA6DD-2365-964D-90B2-628C7E7F385D}\"/><cellStyle name=\"![M]HardNumber\" xfId=\"15\" xr:uid=\"{4B258E26-6836-C449-BF66-A893BA958960}\"/><cellStyle name=\"![M]Input\" xfId=\"3\" xr:uid=\"{8BC31F41-9BA0-8A4D-9684-D2D89A0C981A}\"/><cellStyle name=\"![M]KeyOutput\" xfId=\"11\" xr:uid=\"{0235A3D5-9A75-5B41-AC22-CA0EF06DC3E3}\"/><cellStyle name=\"![M]KPI\" xfId=\"10\" xr:uid=\"{FF60F6A0-C412-584B-AA32-574641C9FD61}\"/><cellStyle name=\"![M]Link\" xfId=\"4\" xr:uid=\"{B051F57D-B2DB-4247-B940-397E90101B6B}\"/><cellStyle name=\"![M]Percent\" xfId=\"6\" xr:uid=\"{59E1857B-B51D-0F4A-8157-195D6C8C8135}\"/><cellStyle name=\"![M]Special\" xfId=\"12\" xr:uid=\"{2CC5412D-FE78-1B45-A575-4E7861D9AAED}\"/><cellStyle name=\"![M]Unused\" xfId=\"9\" xr:uid=\"{79C15A4D-C1D2-7940-9A05-D0286305BAE8}\"/><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/><cellStyle name=\"Per cent\" xfId=\"1\" builtinId=\"5\"/><cellStyle name=\"Title\" xfId=\"2\" builtinId=\"15\" hidden=\"1\"/></cellStyles><dxfs count=\"0\"/><tableStyles count=\"0\" defaultTableStyle=\"TableStyleMedium2\" defaultPivotStyle=\"PivotStyleLight16\"/><colors><mruColors><color rgb=\"FF0332FF\"/><color rgb=\"FF90D5FF\"/><color rgb=\"FFFFF3CC\"/><color rgb=\"FF05B050\"/><color rgb=\"FF085393\"/></mruColors></colors><extLst><ext uri=\"{EB79DEF2-80B8-43e5-95BD-54CBDDF9020C}\" xmlns:x14=\"http://schemas.microsoft.com/office/spreadsheetml/2009/9/main\"><x14:slicerStyles defaultSlicerStyle=\"SlicerStyleLight1\"/></ext><ext uri=\"{9260A510-F301-46a8-8635-F512D64BE5F5}\" xmlns:x15=\"http://schemas.microsoft.com/office/spreadsheetml/2010/11/main\"><x15:timelineStyles defaultTimelineStyle=\"TimeSlicerStyleLight1\"/></ext></extLst></styleSheet>";

  const THEME_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    "<a:theme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Office Theme\"><a:themeElements><a:clrScheme name=\"Office\"><a:dk1><a:sysClr val=\"windowText\" lastClr=\"000000\"/></a:dk1><a:lt1><a:sysClr val=\"window\" lastClr=\"FFFFFF\"/></a:lt1><a:dk2><a:srgbClr val=\"0E2841\"/></a:dk2><a:lt2><a:srgbClr val=\"E8E8E8\"/></a:lt2><a:accent1><a:srgbClr val=\"156082\"/></a:accent1><a:accent2><a:srgbClr val=\"E97132\"/></a:accent2><a:accent3><a:srgbClr val=\"196B24\"/></a:accent3><a:accent4><a:srgbClr val=\"0F9ED5\"/></a:accent4><a:accent5><a:srgbClr val=\"A02B93\"/></a:accent5><a:accent6><a:srgbClr val=\"4EA72E\"/></a:accent6><a:hlink><a:srgbClr val=\"467886\"/></a:hlink><a:folHlink><a:srgbClr val=\"96607D\"/></a:folHlink></a:clrScheme><a:fontScheme name=\"Office\"><a:majorFont><a:latin typeface=\"Aptos Display\" panose=\"02110004020202020204\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/><a:font script=\"Jpan\" typeface=\"\u6e38\u30b4\u30b7\u30c3\u30af Light\"/><a:font script=\"Hang\" typeface=\"\ub9d1\uc740 \uace0\ub515\"/><a:font script=\"Hans\" typeface=\"\u7b49\u7ebf Light\"/><a:font script=\"Hant\" typeface=\"\u65b0\u7d30\u660e\u9ad4\"/><a:font script=\"Arab\" typeface=\"Times New Roman\"/><a:font script=\"Hebr\" typeface=\"Times New Roman\"/><a:font script=\"Thai\" typeface=\"Tahoma\"/><a:font script=\"Ethi\" typeface=\"Nyala\"/><a:font script=\"Beng\" typeface=\"Vrinda\"/><a:font script=\"Gujr\" typeface=\"Shruti\"/><a:font script=\"Khmr\" typeface=\"MoolBoran\"/><a:font script=\"Knda\" typeface=\"Tunga\"/><a:font script=\"Guru\" typeface=\"Raavi\"/><a:font script=\"Cans\" typeface=\"Euphemia\"/><a:font script=\"Cher\" typeface=\"Plantagenet Cherokee\"/><a:font script=\"Yiii\" typeface=\"Microsoft Yi Baiti\"/><a:font script=\"Tibt\" typeface=\"Microsoft Himalaya\"/><a:font script=\"Thaa\" typeface=\"MV Boli\"/><a:font script=\"Deva\" typeface=\"Mangal\"/><a:font script=\"Telu\" typeface=\"Gautami\"/><a:font script=\"Taml\" typeface=\"Latha\"/><a:font script=\"Syrc\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Orya\" typeface=\"Kalinga\"/><a:font script=\"Mlym\" typeface=\"Kartika\"/><a:font script=\"Laoo\" typeface=\"DokChampa\"/><a:font script=\"Sinh\" typeface=\"Iskoola Pota\"/><a:font script=\"Mong\" typeface=\"Mongolian Baiti\"/><a:font script=\"Viet\" typeface=\"Times New Roman\"/><a:font script=\"Uigh\" typeface=\"Microsoft Uighur\"/><a:font script=\"Geor\" typeface=\"Sylfaen\"/><a:font script=\"Armn\" typeface=\"Arial\"/><a:font script=\"Bugi\" typeface=\"Leelawadee UI\"/><a:font script=\"Bopo\" typeface=\"Microsoft JhengHei\"/><a:font script=\"Java\" typeface=\"Javanese Text\"/><a:font script=\"Lisu\" typeface=\"Segoe UI\"/><a:font script=\"Mymr\" typeface=\"Myanmar Text\"/><a:font script=\"Nkoo\" typeface=\"Ebrima\"/><a:font script=\"Olck\" typeface=\"Nirmala UI\"/><a:font script=\"Osma\" typeface=\"Ebrima\"/><a:font script=\"Phag\" typeface=\"Phagspa\"/><a:font script=\"Syrn\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Syrj\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Syre\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Sora\" typeface=\"Nirmala UI\"/><a:font script=\"Tale\" typeface=\"Microsoft Tai Le\"/><a:font script=\"Talu\" typeface=\"Microsoft New Tai Lue\"/><a:font script=\"Tfng\" typeface=\"Ebrima\"/></a:majorFont><a:minorFont><a:latin typeface=\"Aptos Narrow\" panose=\"02110004020202020204\"/><a:ea typeface=\"\"/><a:cs typeface=\"\"/><a:font script=\"Jpan\" typeface=\"\u6e38\u30b4\u30b7\u30c3\u30af\"/><a:font script=\"Hang\" typeface=\"\ub9d1\uc740 \uace0\ub515\"/><a:font script=\"Hans\" typeface=\"\u7b49\u7ebf\"/><a:font script=\"Hant\" typeface=\"\u65b0\u7d30\u660e\u9ad4\"/><a:font script=\"Arab\" typeface=\"Arial\"/><a:font script=\"Hebr\" typeface=\"Arial\"/><a:font script=\"Thai\" typeface=\"Tahoma\"/><a:font script=\"Ethi\" typeface=\"Nyala\"/><a:font script=\"Beng\" typeface=\"Vrinda\"/><a:font script=\"Gujr\" typeface=\"Shruti\"/><a:font script=\"Khmr\" typeface=\"DaunPenh\"/><a:font script=\"Knda\" typeface=\"Tunga\"/><a:font script=\"Guru\" typeface=\"Raavi\"/><a:font script=\"Cans\" typeface=\"Euphemia\"/><a:font script=\"Cher\" typeface=\"Plantagenet Cherokee\"/><a:font script=\"Yiii\" typeface=\"Microsoft Yi Baiti\"/><a:font script=\"Tibt\" typeface=\"Microsoft Himalaya\"/><a:font script=\"Thaa\" typeface=\"MV Boli\"/><a:font script=\"Deva\" typeface=\"Mangal\"/><a:font script=\"Telu\" typeface=\"Gautami\"/><a:font script=\"Taml\" typeface=\"Latha\"/><a:font script=\"Syrc\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Orya\" typeface=\"Kalinga\"/><a:font script=\"Mlym\" typeface=\"Kartika\"/><a:font script=\"Laoo\" typeface=\"DokChampa\"/><a:font script=\"Sinh\" typeface=\"Iskoola Pota\"/><a:font script=\"Mong\" typeface=\"Mongolian Baiti\"/><a:font script=\"Viet\" typeface=\"Arial\"/><a:font script=\"Uigh\" typeface=\"Microsoft Uighur\"/><a:font script=\"Geor\" typeface=\"Sylfaen\"/><a:font script=\"Armn\" typeface=\"Arial\"/><a:font script=\"Bugi\" typeface=\"Leelawadee UI\"/><a:font script=\"Bopo\" typeface=\"Microsoft JhengHei\"/><a:font script=\"Java\" typeface=\"Javanese Text\"/><a:font script=\"Lisu\" typeface=\"Segoe UI\"/><a:font script=\"Mymr\" typeface=\"Myanmar Text\"/><a:font script=\"Nkoo\" typeface=\"Ebrima\"/><a:font script=\"Olck\" typeface=\"Nirmala UI\"/><a:font script=\"Osma\" typeface=\"Ebrima\"/><a:font script=\"Phag\" typeface=\"Phagspa\"/><a:font script=\"Syrn\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Syrj\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Syre\" typeface=\"Estrangelo Edessa\"/><a:font script=\"Sora\" typeface=\"Nirmala UI\"/><a:font script=\"Tale\" typeface=\"Microsoft Tai Le\"/><a:font script=\"Talu\" typeface=\"Microsoft New Tai Lue\"/><a:font script=\"Tfng\" typeface=\"Ebrima\"/></a:minorFont></a:fontScheme><a:fmtScheme name=\"Office\"><a:fillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:lumMod val=\"110000\"/><a:satMod val=\"105000\"/><a:tint val=\"67000\"/></a:schemeClr></a:gs><a:gs pos=\"50000\"><a:schemeClr val=\"phClr\"><a:lumMod val=\"105000\"/><a:satMod val=\"103000\"/><a:tint val=\"73000\"/></a:schemeClr></a:gs><a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:lumMod val=\"105000\"/><a:satMod val=\"109000\"/><a:tint val=\"81000\"/></a:schemeClr></a:gs></a:gsLst><a:lin ang=\"5400000\" scaled=\"0\"/></a:gradFill><a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:satMod val=\"103000\"/><a:lumMod val=\"102000\"/><a:tint val=\"94000\"/></a:schemeClr></a:gs><a:gs pos=\"50000\"><a:schemeClr val=\"phClr\"><a:satMod val=\"110000\"/><a:lumMod val=\"100000\"/><a:shade val=\"100000\"/></a:schemeClr></a:gs><a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:lumMod val=\"99000\"/><a:satMod val=\"120000\"/><a:shade val=\"78000\"/></a:schemeClr></a:gs></a:gsLst><a:lin ang=\"5400000\" scaled=\"0\"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w=\"12700\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln><a:ln w=\"19050\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln><a:ln w=\"25400\" cap=\"flat\" cmpd=\"sng\" algn=\"ctr\"><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:prstDash val=\"solid\"/><a:miter lim=\"800000\"/></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad=\"57150\" dist=\"19050\" dir=\"5400000\" algn=\"ctr\" rotWithShape=\"0\"><a:srgbClr val=\"000000\"><a:alpha val=\"63000\"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val=\"phClr\"/></a:solidFill><a:solidFill><a:schemeClr val=\"phClr\"><a:tint val=\"95000\"/><a:satMod val=\"170000\"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape=\"1\"><a:gsLst><a:gs pos=\"0\"><a:schemeClr val=\"phClr\"><a:tint val=\"93000\"/><a:satMod val=\"150000\"/><a:shade val=\"98000\"/><a:lumMod val=\"102000\"/></a:schemeClr></a:gs><a:gs pos=\"50000\"><a:schemeClr val=\"phClr\"><a:tint val=\"98000\"/><a:satMod val=\"130000\"/><a:shade val=\"90000\"/><a:lumMod val=\"103000\"/></a:schemeClr></a:gs><a:gs pos=\"100000\"><a:schemeClr val=\"phClr\"><a:shade val=\"63000\"/><a:satMod val=\"120000\"/></a:schemeClr></a:gs></a:gsLst><a:lin ang=\"5400000\" scaled=\"0\"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults><a:lnDef><a:spPr/><a:bodyPr/><a:lstStyle/><a:style><a:lnRef idx=\"2\"><a:schemeClr val=\"accent1\"/></a:lnRef><a:fillRef idx=\"0\"><a:schemeClr val=\"accent1\"/></a:fillRef><a:effectRef idx=\"1\"><a:schemeClr val=\"accent1\"/></a:effectRef><a:fontRef idx=\"minor\"><a:schemeClr val=\"tx1\"/></a:fontRef></a:style></a:lnDef></a:objectDefaults><a:extraClrSchemeLst/><a:extLst><a:ext uri=\"{05A4C25C-085E-4340-85A3-A5531E510DB2}\"><thm15:themeFamily xmlns:thm15=\"http://schemas.microsoft.com/office/thememl/2012/main\" name=\"Office Theme\" id=\"{2E142A2C-CD16-42D6-873A-C26D2A0506FA}\" vid=\"{1BDDFF52-6CD6-40A5-AB3C-68EB2F1E4D0A}\"/></a:ext></a:extLst></a:theme>";

  function contentTypesXml(sheetCount) {
    const overrides = [
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.' +
      'openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    ];
    for (let i = 1; i <= sheetCount; i++) {
      overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ` +
        'ContentType="application/vnd.openxmlformats-officedocument.' +
        'spreadsheetml.worksheet+xml"/>');
    }
    overrides.push('<Override PartName="/xl/styles.xml" ContentType="application/vnd.' +
      'openxmlformats-officedocument.spreadsheetml.styles+xml"/>');
    overrides.push('<Override PartName="/xl/theme/theme1.xml" ContentType="application/' +
      'vnd.openxmlformats-officedocument.theme+xml"/>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.' +
      'relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      overrides.join("") + '</Types>';
  }

  function workbookXml(workbook) {
    const sheetsXml = workbook.sheets.map((s, i) =>
      `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("");
    let namesXml = "";
    if (workbook.definedNames && workbook.definedNames.length) {
      namesXml = "<definedNames>" + workbook.definedNames.map((n) =>
        `<definedName name="${esc(n.name)}">${esc(n.ref)}</definedName>`).join("") +
        "</definedNames>";
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<workbookPr/><sheets>' + sheetsXml + '</sheets>' + namesXml +
      '<calcPr calcId="0" fullCalcOnLoad="1"/></workbook>';
  }

  function workbookRelsXml(sheetCount) {
    const rels = [];
    for (let i = 1; i <= sheetCount; i++) {
      rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/` +
        `officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i}.xml"/>`);
    }
    rels.push(`<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.` +
      'openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
    rels.push(`<Relationship Id="rId${sheetCount + 2}" Type="http://schemas.` +
      'openxmlformats.org/officeDocument/2006/relationships/theme" ' +
      'Target="theme/theme1.xml"/>');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join("") + '</Relationships>';
  }

  function cellXml(ref, spec) {
    const st = spec.s ? ` s="${spec.s}"` : "";
    if (spec.t === "s") {
      return `<c r="${ref}"${st} t="inlineStr"><is><t>${esc(spec.v)}</t></is></c>`;
    }
    if (spec.t === "f") {
      return `<c r="${ref}"${st}><f>${esc(spec.v)}</f></c>`;
    }
    return `<c r="${ref}"${st}><v>${spec.v}</v></c>`;
  }

  /* Worksheet XML. Child order is fixed: dimension, sheetViews, cols,
     sheetData. Rows are emitted ascending by r, cells within a row
     ascending by column, sorted on the way out rather than trusted from
     insertion order, because the model builder fills a sparse map. */
  function sheetXml(sheet) {
    const byRow = {};
    let minRow = Infinity, maxRow = -Infinity, minCol = Infinity, maxCol = -Infinity;
    Object.keys(sheet.cells).forEach((ref) => {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      const col = colIndex(m[1]), row = parseInt(m[2], 10);
      if (!byRow[row]) byRow[row] = {};
      byRow[row][col] = sheet.cells[ref];
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
    });
    const dim = (minRow === Infinity)
      ? "A1:A1"
      : `${colName(minCol)}${minRow}:${colName(maxCol)}${maxRow}`;

    const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
      `<dimension ref="${dim}"/>`];

    /* showGridLines="0" on every sheet (owner's reference template
       convention): banners and section colouring are the only visual
       structure a reader should see, not Excel's default grid. */
    const zoom = sheet.zoom ? ` zoomScale="${sheet.zoom}"` : "";
    if (sheet.freeze) {
      parts.push(`<sheetViews><sheetView showGridLines="0"${zoom} workbookViewId="0">` +
        `<pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" ` +
        'activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    } else {
      parts.push(`<sheetViews><sheetView showGridLines="0"${zoom} ` +
        'workbookViewId="0"/></sheetViews>');
    }

    if (sheet.cols && sheet.cols.length) {
      parts.push("<cols>");
      sheet.cols.forEach(([lo, hi, w, s]) => {
        const st = (s == null) ? "" : ` style="${s}"`;
        parts.push(`<col min="${lo}" max="${hi}" width="${w}"${st} customWidth="1"/>`);
      });
      parts.push("</cols>");
    }

    parts.push("<sheetData>");
    Object.keys(byRow).map(Number).sort((a, b) => a - b).forEach((r) => {
      parts.push(`<row r="${r}">`);
      const rowCells = byRow[r];
      Object.keys(rowCells).map(Number).sort((a, b) => a - b).forEach((c) => {
        parts.push(cellXml(colName(c) + r, rowCells[c]));
      });
      parts.push("</row>");
    });
    parts.push("</sheetData></worksheet>");
    return parts.join("");
  }

  function build(workbook) {
    const enc = new TextEncoder();
    const n = workbook.sheets.length;
    const parts = [
      ["[Content_Types].xml", enc.encode(contentTypesXml(n))],
      ["_rels/.rels", enc.encode(ROOT_RELS)],
      ["xl/workbook.xml", enc.encode(workbookXml(workbook))],
      ["xl/_rels/workbook.xml.rels", enc.encode(workbookRelsXml(n))],
      ["xl/styles.xml", enc.encode(STYLES_XML)],
      ["xl/theme/theme1.xml", enc.encode(THEME_XML)],
    ];
    workbook.sheets.forEach((s, i) => {
      parts.push([`xl/worksheets/sheet${i + 1}.xml`, enc.encode(sheetXml(s))]);
    });
    return storeZip(parts);
  }

  return { build, dateSerial };
})();
