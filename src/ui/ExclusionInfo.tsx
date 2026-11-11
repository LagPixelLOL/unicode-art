import type { ExclusionRule } from "../engine/backend";
import { MAX_GLYPH_CELLS } from "../art/geometry";
import { HoverPanel } from "./HoverPanel";
import { InfoIcon } from "./icons";
import { summarizeExclusions } from "./text";

export function ExclusionInfo({ rules }: { rules: readonly ExclusionRule[] }) {
  const s = summarizeExclusions(rules);
  return (
    <HoverPanel
      trigger={<InfoIcon />}
      triggerLabel="Which characters are excluded"
      triggerClassName="flex h-5 w-5 items-center justify-center rounded-full text-zinc-500 hover:text-zinc-200 focus:text-zinc-200 focus:outline-none"
      width={448}
      testId="exclusions-panel"
    >
      <p className="text-zinc-200">
        Only characters that render as one standalone, left-to-right advance in monochrome are used. Excluded:
      </p>
      <h3 className="mt-3 font-medium text-zinc-200">Unicode general categories</h3>
      <p>{s.categories}</p>
      <h3 className="mt-3 font-medium text-zinc-200">Bidi classes</h3>
      <p>{s.bidi}</p>
      <h3 className="mt-3 font-medium text-zinc-200">Blocks needing complex shaping, joining or sequences</h3>
      <ul className="mt-1 space-y-0.5">
        {s.ranges.map((r) => (
          <li key={r.key}>
            <span className="font-mono text-zinc-400">{r.key}</span> {r.description}
          </li>
        ))}
      </ul>
      <h3 className="mt-3 font-medium text-zinc-200">Per font, at run time</h3>
      <p>
        Code points no loaded font maps to a real glyph, color glyphs (COLR, CBDT, sbix, SVG), glyphs with zero
        advance, characters whose browser advance disagrees with the font, and glyphs narrower than one sample or wider
        than {MAX_GLYPH_CELLS} cells.
      </p>
    </HoverPanel>
  );
}
