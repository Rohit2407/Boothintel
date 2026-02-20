#!/usr/bin/env python3
"""
Electoral Roll Pipeline (Enhanced)
=================================
Keeps original functionality but adds:
  ✔ Tamil + English PDF support
  ✔ House Number Normalization
  ✔ Remove invalid house numbers
  ✔ Deduplicate voter entries
  ✔ Generate debug JSON
  ✔ Generate debug CSV (raw + clean)
  ✔ Generate debug Excel (.xlsx)
  ✔ OCR Dump (ocr_dump.txt)

Outputs generated in same folder:
  debug_raw.csv
  debug_clean.csv
  debug_clean.xlsx
  debug.json
  ocr_dump.txt
"""

import argparse
import csv
import json
import re
from pathlib import Path
import pandas as pd  # Excel debug

# =====================================================================
# HOUSE NUMBER NORMALIZATION
# =====================================================================

def normalize_house_no(h):
    if not h:
        return ""

    h = h.strip().replace(",", "")

    h = h.replace("-", "/")              # Allow 12-5 -> 12/5
    h = re.sub(r"/+", "/", h)            # Remove repeated slashes

    m = re.match(r"^([0-9/]+)([A-Za-z]?)$", h)
    if not m:
        return ""

    num, suf = m.groups()
    return num + suf.upper()


# =====================================================================
# PDF → JSON (Tamil + English)
# =====================================================================

def pdf_to_json(input_path: str, lang: str = "tam+eng", dpi: int = 200) -> dict:
    try:
        import pdfplumber
        with pdfplumber.open(input_path) as pdf:
            sample_text = "".join((page.extract_text() or "") for page in pdf.pages[:3])
        has_text = len(sample_text) > 100
    except Exception:
        has_text = False

    pages = []

    if has_text:
        print("[INFO] PDF has embedded text — using direct extraction.")
        import pdfplumber
        with pdfplumber.open(input_path) as pdf:
            meta = {k: str(v) for k, v in (pdf.metadata or {}).items()}
            for i, page in enumerate(pdf.pages):
                pages.append({"page": i + 1, "text": page.extract_text() or ""})

    else:
        print("[INFO] Scanned PDF detected — running OCR...")
        from pdf2image import convert_from_path
        import pytesseract

        images = convert_from_path(input_path, dpi=dpi)
        meta = {"source": str(input_path), "total_pages": len(images), "ocr_lang": lang}

        for i, img in enumerate(images):
            print(f"OCR page {i + 1}/{len(images)}...", end="\r")
            text = pytesseract.image_to_string(img, lang=lang)
            pages.append({"page": i + 1, "text": text.strip()})
        print()

    return {"metadata": meta, "total_pages": len(pages), "pages": pages}


# =====================================================================
# PARSING HELPERS
# =====================================================================

VOTER_ID_PAT = re.compile(r"([A-Z]{2,3}\d{7})")

BAD_NAMES = {
    "26-VELACHERY", "VELACHERY", "3-CHENNAI SOUTH",
    "CHENNAI SOUTH", "ELECTORAL ROLL", "ASSEMBLY CONSTITUENCY"
}

def clean(s: str) -> str:
    if not s:
        return ""
    s = re.sub(r"\s+", " ", s).strip().rstrip("-~").strip()
    s = re.sub(r"\s*(Name\s*[:+!].*)", "", s, flags=re.IGNORECASE).strip()
    return s


def parse_block(block: str) -> dict:
    # English patterns (work for Tamil PDFs too)
    name_m    = re.search(r"Name\s*[:+!]\s*([^\n]+)", block)
    father_m  = re.search(r"Father(?:'s)? Name\s*[:+!]\s*([^\n]+)", block)
    husband_m = re.search(r"Husband(?:'s)? Name\s*[:+!]\s*([^\n]+)", block)
    mother_m  = re.search(r"Mother(?:'s)? Name\s*[:+!]\s*([^\n]+)", block)
    house_m   = re.search(r"House\s*Number\s*[:+!]\s*([^\n ]+)", block)
    age_m     = re.search(r"Age\s*[:+!]\s*(\d+)", block)
    gender_m  = re.search(r"Gender\s*[:+!]\s*(Male|Female|ஆண்|பெண்)", block)

    # ---------------------------------------------------------
    # NAME
    # ---------------------------------------------------------
    name = clean(name_m.group(1)) if name_m else ""
    if "NAME" in name.upper() or "-" in name or "=" in name:
        name = ""
    if name.upper() in BAD_NAMES or re.match(r"^\d", name):
        name = ""

    # ---------------------------------------------------------
    # RELATION
    # ---------------------------------------------------------
    if father_m:
        rel_type, rel_name = "S/O", clean(father_m.group(1))
    elif husband_m:
        rel_type, rel_name = "W/O", clean(husband_m.group(1))
    elif mother_m:
        rel_type, rel_name = "C/O", clean(mother_m.group(1))
    else:
        rel_type, rel_name = "", ""

    # ---------------------------------------------------------
    # HOUSE NUMBER
    # ---------------------------------------------------------
    house = normalize_house_no(clean(house_m.group(1))) if house_m else ""

    # ---------------------------------------------------------
    # GENDER
    # ---------------------------------------------------------
    gender_raw = gender_m.group(1) if gender_m else ""

    if gender_raw == "ஆண்":
        gender = "Male"
    elif gender_raw == "பெண்":
        gender = "Female"
    else:
        gender = gender_raw.capitalize()

    # ---------------------------------------------------------
    # AGE
    # ---------------------------------------------------------
    age = age_m.group(1) if age_m else ""

    return {
        "name": name,
        "relation_type": rel_type,
        "relation_name": rel_name,
        "house_number": house,
        "age": age,
        "gender": gender,
    }


def completeness(f: dict) -> int:
    return sum(1 for k in ["name", "age", "gender", "house_number"] if f[k])


# =====================================================================
# PARSE ENTIRE PAGE
# =====================================================================

def parse_page(text: str, page_num: int) -> list[dict]:
    voters = []
    text_clean = re.sub(r"[ \t]+", " ", text)

    part_m = re.search(r"Part No\.:(\w+)", text_clean)
    section_m = re.search(r"Section No and Name\s+(.+?)(?:\n|Part No)", text_clean)

    part_no = part_m.group(1) if part_m else ""
    section = clean(section_m.group(1)) if section_m else ""

    id_positions = [(m.start(), m.group()) for m in VOTER_ID_PAT.finditer(text_clean)]

    for i, (pos, vid) in enumerate(id_positions):
        prev_pos = id_positions[i - 1][0] if i > 0 else 0
        next_pos = id_positions[i + 1][0] if i + 1 < len(id_positions) else len(text_clean)

        after_block = text_clean[pos:next_pos]
        before_block = text_clean[prev_pos:pos]

        candidates = [
            parse_block(after_block),
            parse_block(before_block),
            parse_block(before_block + "\n" + after_block),
        ]
        best = max(candidates, key=completeness)

        voters.append({
            "voter_id": vid,
            **best,
            "part_no": part_no,
            "section": section,
            "page": page_num,
            "constituency": "26-VELACHERY",
            "parliamentary_constituency": "3-CHENNAI SOUTH",
        })

    return voters


# =====================================================================
# JSON → CSV + DEBUG FILES
# =====================================================================

def json_to_csv(data: dict, csv_path: str) -> int:
    fieldnames = [
        "voter_id", "name", "relation_type", "relation_name",
        "house_number", "age", "gender",
        "part_no", "section", "constituency",
        "parliamentary_constituency", "page",
    ]

    all_voters = []
    for p in data["pages"]:
        all_voters.extend(parse_page(p["text"], p["page"]))

    out_dir = Path(csv_path).parent

    # RAW CSV
    with open(out_dir / "debug_raw.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(all_voters)

    # CLEANING
    cleaned = []
    seen = set()

    for row in all_voters:
        name = row.get("name", "").strip()
        house = row.get("house_number", "").strip()
        if not name or not house:
            continue
        key = (name.upper(), house)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(row)

    # CLEAN CSV
    with open(out_dir / "debug_clean.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        w.writeheader()
        w.writerows(cleaned)

    # CLEAN XLSX
    pd.DataFrame(cleaned).to_excel(out_dir / "debug_clean.xlsx", index=False)

    # CLEAN JSON
    with open(out_dir / "debug.json", "w", encoding="utf-8") as f:
        json.dump(cleaned, f, indent=2, ensure_ascii=False)

    # FINAL CSV
    with open(csv_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(cleaned)

    return len(cleaned)


# =====================================================================
# CLI
# =====================================================================

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_file")
    parser.add_argument("--output-dir", default=".")
    parser.add_argument("--lang", default="tam+eng")
    parser.add_argument("--dpi", type=int, default=200)
    parser.add_argument("--skip-ocr")
    args = parser.parse_args()

    input_path = args.input_file
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    stem = Path(input_path).stem
    json_path = output_dir / f"{stem}.json"
    csv_path = output_dir / f"{stem}_voters.csv"

    if args.skip_ocr:
        with open(args.skip_ocr, encoding="utf-8") as f:
            data = json.load(f)
    else:
        data = pdf_to_json(input_path, lang=args.lang, dpi=args.dpi)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    total = json_to_csv(data, str(csv_path))
    print(f"✓ CSV saved ({total} voters): {csv_path}")


# =====================================================================
# FLASK WRAPPER
# =====================================================================

def process_file(input_path):
    base = Path(input_path).stem
    json_path = Path(input_path).parent / f"{base}.json"
    csv_path = Path(input_path).parent / f"{base}_voters.csv"

    data = pdf_to_json(input_path)

    # OCR DUMP
    dump_path = Path(input_path).parent / "ocr_dump.txt"
    try:
        with open(dump_path, "w", encoding="utf-8") as f:
            for p in data["pages"]:
                f.write(f"\n\n======= PAGE {p['page']} =======\n\n")
                f.write(p["text"])
        print(f"[DEBUG] OCR dump saved to {dump_path}")
    except Exception as e:
        print("[ERROR] Cannot write OCR dump:", e)

    # SAVE JSON
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    # SAVE CSV
    json_to_csv(data, str(csv_path))
    return str(csv_path)


if __name__ == "__main__":
    main()