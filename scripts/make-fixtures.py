"""Regenerates the font fixtures in tests/fixtures/fonts.

The fixtures are renamed subsets of the Liberation fonts (SIL OFL 1.1).

Requires: pip install fonttools brotli
Usage:    python3 scripts/make-fixtures.py [path/to/liberation/fonts]
"""

import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.ttLib.ttCollection import TTCollection

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


def make(src_name, out_name, family, flavor=None, unicodes=UNICODES):
    opts = subset.Options()
    opts.flavor = flavor
    opts.layout_features = []
    opts.name_IDs = [1, 2, 16]
    opts.notdef_outline = True
    font = subset.load_font(os.path.join(SRC, src_name), opts)
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(unicodes))
    sub.subset(font)
    rename(font, family)
    subset.save_font(font, os.path.join(OUT, out_name), opts)


def main():
    os.makedirs(OUT, exist_ok=True)
    make("LiberationSans-Regular.ttf", "sans.ttf", "Fixture Sans")
    make("LiberationSans-Regular.ttf", "sans.woff", "Fixture Sans", flavor="woff")
    make("LiberationSans-Regular.ttf", "sans.woff2", "Fixture Sans", flavor="woff2")
    make("LiberationMono-Regular.ttf", "mono.ttf", "Fixture Mono", unicodes="U+0020-007E")
    coll = TTCollection()
    coll.fonts = [TTFont(os.path.join(OUT, "mono.ttf")), TTFont(os.path.join(OUT, "sans.ttf"))]
    coll.save(os.path.join(OUT, "collection.ttc"))


if __name__ == "__main__":
    main()
