#!/usr/bin/env python3
"""Overlay text onto selected PDF pages from a JSON specification."""

import argparse
import json
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def make_overlay(entries):
    packet = BytesIO()
    pdf = canvas.Canvas(packet, pagesize=letter)
    for entry in entries:
        pdf.setFont(entry.get("font", "Helvetica"), entry.get("size", 10))
        pdf.drawString(entry["x"], entry["y"], str(entry["text"]))
    pdf.save()
    packet.seek(0)
    return PdfReader(packet).pages[0]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("spec", type=Path, help="JSON file with an overlays array")
    args = parser.parse_args()

    spec = json.loads(args.spec.read_text(encoding="utf-8"))
    by_page = {}
    for entry in spec.get("overlays", []):
        page_index = int(entry["page"]) - 1
        by_page.setdefault(page_index, []).append(entry)

    reader = PdfReader(str(args.source))
    writer = PdfWriter()

    for index, page in enumerate(reader.pages):
        entries = by_page.get(index)
        if entries:
            page.merge_page(make_overlay(entries))
        writer.add_page(page)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("wb") as stream:
        writer.write(stream)


if __name__ == "__main__":
    main()
