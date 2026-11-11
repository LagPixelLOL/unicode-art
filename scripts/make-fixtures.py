"""Regenerates the font fixtures in tests/fixtures/fonts.

The fixtures are renamed subsets of the Liberation fonts, Noto Color Emoji
Noto Sans and Noto Sans Arabic (all SIL OFL 1.1).

Requires: pip install fonttools brotli
Usage:    python3 scripts/make-fixtures.py [path/to/liberation/fonts]
"""

import os
import sys
import urllib.request

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.feaLib.builder import addOpenTypeFeaturesFromString
from fontTools.ttLib.ttCollection import TTCollection

# Noto Sans Arabic (variable, SIL OFL 1.1) as served by Google Fonts.
ARABIC_URL = (
    "https://fonts.gstatic.com/s/notosansarabic/v33/"
    "nwpxtLGrOAZMl5nJ_wfgRg3DrWFZWsnVBJ_sS6tlqHHFlhQ5l3sQWIHPqzCfyGyvuw.ttf"
)

# Noto Sans variable font (wght and wdth axes, SIL OFL 1.1).
VARIABLE_URL = "https://github.com/google/fonts/raw/main/ofl/notosans/NotoSans%5Bwdth,wght%5D.ttf"

# Ligature, contextual alternate and kerning rules, to check that the
# output never depends on shaping.
FEATURES = """
languagesystem DFLT dflt;
languagesystem latn dflt;
feature liga { sub f i by uniFB01; } liga;
feature calt { sub a' c by b; } calt;
feature kern { pos A V -300; } kern;
"""

SRC = sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/liberation"
OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures", "fonts")

# ASCII, Latin-1, combining acute, a few Hebrew letters, a zero width space
# and a full block: covers usable, combining, right-to-left and invisible
# code points.
UNICODES = "U+0020-007E,U+00A0-00FF,U+0300-0301,U+05D0-05D2,U+200B,U+2588"


def rename(font, family):
    # The OFL reserves the original family name for unmodified fonts.
    for rec in font["name"].names:
        if rec.nameID in (1, 16):
            rec.string = family


def make(src_name, out_name, family, flavor=None, unicodes=UNICODES, src_dir=None, keep_layout=False, fea=None):
    opts = subset.Options()
    opts.flavor = flavor
    opts.layout_features = ["*"] if keep_layout else []
    opts.name_IDs = [1, 2, 16]
    opts.notdef_outline = True
    font = subset.load_font(os.path.join(src_dir or SRC, src_name), opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(unicodes))
    sub.subset(font)
    rename(font, family)
    if fea:
        addOpenTypeFeaturesFromString(font, fea)
    subset.save_font(font, os.path.join(OUT, out_name), opts)


def main():
    os.makedirs(OUT, exist_ok=True)
    make("LiberationSans-Regular.ttf", "sans.ttf", "Fixture Sans")
    make("LiberationSans-Regular.ttf", "sans.woff", "Fixture Sans", flavor="woff")
    make("LiberationSans-Regular.ttf", "sans.woff2", "Fixture Sans", flavor="woff2")
    make("LiberationMono-Regular.ttf", "mono.ttf", "Fixture Mono", unicodes="U+0020-007E")
    # Bitmap color glyphs (CBDT) that must be excluded from the output.
    make("NotoColorEmoji.ttf", "color.ttf", "Fixture Color", unicodes="U+0020,U+1F600,U+2764",
         src_dir="/usr/share/fonts/truetype/noto")
    make("LiberationSans-Regular.ttf", "features.ttf", "Fixture Features",
         unicodes="U+0020-007E,U+FB01", fea=FEATURES)
    # Arabic joining forms, harakat, Arabic-Indic digits, joiners and Latin.
    arabic = os.path.join(OUT, "_arabic_src.ttf")
    urllib.request.urlretrieve(ARABIC_URL, arabic)
    try:
        make("_arabic_src.ttf", "arabic.ttf", "Fixture Arabic", src_dir=OUT, keep_layout=True,
             unicodes="U+0020,U+0030-0039,U+0041-005A,U+0627-0629,U+0644-0645,U+064E,U+0660-0662,U+200C-200D,U+FEFB")
    finally:
        os.remove(arabic)
    variable = os.path.join(OUT, "_variable_src.ttf")
    urllib.request.urlretrieve(VARIABLE_URL, variable)
    try:
        make("_variable_src.ttf", "variable.ttf", "Fixture Variable", src_dir=OUT, unicodes="U+0020-007E")
    finally:
        os.remove(variable)
    coll = TTCollection()
    coll.fonts = [TTFont(os.path.join(OUT, "mono.ttf")), TTFont(os.path.join(OUT, "sans.ttf"))]
    coll.save(os.path.join(OUT, "collection.ttc"))


if __name__ == "__main__":
    main()
