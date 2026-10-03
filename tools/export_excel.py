"""Export the EpiSoft MariaDB schemas to Excel (one .xlsx per schema, one sheet per table).

Read-only: only SELECT statements are sent to the existing production database.
Connection settings come from the production EpiSoft.config (read only, see --config),
using the same rules as TPreferences.LoadConnectionParams. Output goes to EpiSoft-Web\\exports.
Usage: py export_excel.py [--local | --remote] [--config FILE] [--out DIR] [--schemas epicafe,epidatas,epicompta]
"""
import argparse
import datetime as dt
import decimal
import os
import re
import sys

import pymysql
from openpyxl import Workbook
from openpyxl.cell import WriteOnlyCell
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE
from openpyxl.styles import Font

MAX_ROWS = 1048575  # Excel limit minus the header row
HERE = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(HERE)  # EpiSoft-Web
DEFAULT_CONFIG = r"C:\Datas\Dev\Episoft\EpiSoft.config"
DEFAULT_SCHEMAS = ["epicafe", "epidatas", "epicompta"]
BOLD = Font(bold=True)


def read_config(path):
    for enc in ("utf-8", "cp1252"):
        try:
            with open(path, encoding=enc) as f:
                lines = f.read().splitlines()
            break
        except UnicodeDecodeError:
            continue
    cfg = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith(("/*", "#")) or "=" not in line:
            continue
        k, v = line.split("=", 1)
        cfg[k.strip()] = v.strip()
    return cfg


def as_bool(v):
    return str(v).strip().lower() in ("1", "true", "yes", "oui", "vrai")


def convert(v):
    if v is None:
        return None
    if isinstance(v, decimal.Decimal):
        return float(v)
    if isinstance(v, (bytes, bytearray)):
        return "<binaire %d octets>" % len(v)
    if isinstance(v, str):
        return ILLEGAL_CHARACTERS_RE.sub("", v)
    if isinstance(v, dt.timedelta):
        return str(v)
    if isinstance(v, (dt.datetime, dt.date)):
        try:
            if v.year < 1900:
                return None
        except Exception:
            return None
        return v
    return v


def bold_cell(ws, value):
    c = WriteOnlyCell(ws, value)
    c.font = BOLD
    return c


def sheet_name(name, used):
    base = re.sub(r"[\\/*?:\[\]]", "_", name)[:31]
    n, i = base, 1
    while n.lower() in used:
        i += 1
        suf = "_%d" % i
        n = base[:31 - len(suf)] + suf
    used.add(n.lower())
    return n


def export_schema(conn, schema, outdir):
    cur = conn.cursor()
    cur.execute(
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES "
        "WHERE TABLE_SCHEMA=%s ORDER BY TABLE_TYPE='VIEW', TABLE_NAME", (schema,))
    objs = cur.fetchall()
    cur.close()
    if not objs:
        print("%s: aucune table (schema absent ?)" % schema)
        return

    wb = Workbook(write_only=True)
    summary = wb.create_sheet("_Sommaire")
    summary.append([bold_cell(summary, h) for h in ("Table", "Type", "Lignes", "Feuille")])
    used = {"_sommaire"}
    summary_rows = []

    for tname, ttype in objs:
        is_view = ttype == "VIEW"
        label = sheet_name(tname + (" (v)" if is_view else ""), used)
        total, part = 0, 1
        ws = None
        try:
            cur = conn.cursor(pymysql.cursors.SSCursor)
            cur.execute("SELECT * FROM `%s`.`%s`" % (schema, tname))
            cols = [d[0] for d in cur.description]

            def new_sheet(title):
                s = wb.create_sheet(title)
                s.freeze_panes = "A2"
                s.append([bold_cell(s, c) for c in cols])
                return s

            ws = new_sheet(label)
            in_sheet = 0
            for row in cur:
                if in_sheet >= MAX_ROWS:
                    part += 1
                    ws = new_sheet(sheet_name("%s_%d" % (label, part), used))
                    in_sheet = 0
                ws.append([convert(v) for v in row])
                in_sheet += 1
                total += 1
            cur.close()
            print("%s.%s ... %s lignes" % (schema, tname, format(total, ",").replace(",", " ")))
        except Exception as e:
            print("%s.%s ERREUR: %s" % (schema, tname, e))
            summary_rows.append([tname, ttype, "ERREUR: %s" % e, label])
            continue
        summary_rows.append([tname, ttype, total, label])

    for r in summary_rows:
        summary.append(r)
    path = os.path.join(outdir, schema + ".xlsx")
    wb.save(path)
    print("-> %s" % path)


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--local", action="store_true")
    g.add_argument("--remote", action="store_true")
    ap.add_argument("--config", default=DEFAULT_CONFIG)
    ap.add_argument("--out", default=None)
    ap.add_argument("--schemas", default=",".join(DEFAULT_SCHEMAS))
    a = ap.parse_args()

    cfg = read_config(a.config)
    use_local = True if a.local else False if a.remote else as_bool(cfg.get("UseLocal", ""))
    host = cfg.get("LHostName" if use_local else "DHostName", "")
    port = int(cfg.get("LPort" if use_local else "DPort", "3306") or 3306)
    user, pwd = cfg.get("UserName", ""), cfg.get("Password", "")
    if not host or not user:
        sys.exit("Parametres de connexion introuvables dans EpiSoft.config")

    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H%M")
    outdir = a.out or os.path.join(BASE, "exports", stamp)
    os.makedirs(outdir, exist_ok=True)
    print("Connexion %s: %s:%d (user %s)" % ("locale" if use_local else "distante", host, port, user))

    conn = pymysql.connect(host=host, port=port, user=user, password=pwd,
                           charset="utf8mb4", connect_timeout=15)
    try:
        for schema in [s.strip() for s in a.schemas.split(",") if s.strip()]:
            export_schema(conn, schema, outdir)
    finally:
        conn.close()
    print("Termine: %s" % outdir)


if __name__ == "__main__":
    main()
