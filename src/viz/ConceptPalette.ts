/**
 * @module viz/ConceptPalette
 *
 * Stable per-concept color and size mapping for the cosmos.gl renderer.
 *
 * The primary color key is a node's CONCEPT — in practice the local name of
 * its named-graph IRI (`Monster`, `Spell`, `Generic`, …) or its most-specific
 * `rdf:type`. Concepts are assigned colors from a hand-tuned, maximally-distinct
 * categorical palette (the proven legible look on the dark canvas). A small
 * curated table pins the well-known concepts to specific palette entries so
 * they never collide; any concept outside the table is placed on a free palette
 * slot deterministically, falling back to a golden-angle hue only once the
 * palette is exhausted.
 */

/**
 * Maps node concepts to stable colors and sizes for graph rendering.
 *
 * A "concept" is identified by a string key — the local name of the node's
 * named-graph IRI, or its most-specific class IRI. {@link ConceptPalette.colorFor}
 * resolves the local name, looks it up in a curated concept table, and falls
 * back to a deterministic palette/golden-angle assignment for unknown concepts.
 *
 * @category Viz
 * @since 0.10.0
 */
export class ConceptPalette {
  private constructor() {}

  /**
   * Hand-tuned, maximally-distinct categorical palette that reads well on the
   * `#0a0a0a` canvas. Adjacent entries are visually separated.
   */
  private static readonly PALETTE: ReadonlyArray<string> = [
    '#c09fef', // lavender
    '#e94560', // rose
    '#ffb13c', // amber
    '#4dd0e1', // cyan
    '#81c784', // green
    '#ffd54f', // sunflower
    '#ba68c8', // orchid
    '#ff8a65', // coral
    '#90caf9', // sky
    '#aed581', // chartreuse
    '#f06292', // pink
    '#7986cb', // periwinkle
    '#ffb74d', // tangerine
    '#a1887f', // taupe
    '#dce775', // lime
    '#4fc3f7', // azure
    '#9ccc65', // leaf
    '#f48fb1', // blossom
    '#80deea', // aqua
    '#ce93d8', // mauve
  ];

  /**
   * Curated concept → palette-index pins. Each well-known concept is assigned a
   * distinct palette slot so the showcase graph separates concepts cleanly.
   * Keys are case-folded local names.
   */
  private static readonly CONCEPT_SLOTS: Readonly<Record<string, number>> = {
    monster:        1,  // rose — the dominant cluster
    generic:        3,  // cyan
    spell:          6,  // orchid
    feat:           4,  // green
    monsterfamily:  11, // periwinkle
    hazard:         2,  // amber
    weapon:         14, // lime
    equipment:      7,  // coral
    trait:          13, // taupe
    action:         0,  // lavender
    ancestry:       10, // pink
    class:          9,  // chartreuse
    condition:      5,  // sunflower
    armor:          12, // tangerine
    background:     8,  // sky
    unknown:        15, // azure
  };

  /**
   * Returns a stable hex color for the given concept key (a named-graph IRI,
   * a class IRI, or a bare concept name).
   *
   * Resolves the local name, pins well-known concepts to their curated palette
   * slot, and assigns unknown concepts a deterministic slot (palette first,
   * then a golden-angle hue once the palette is exhausted). Empty keys return
   * the lavender default.
   *
   * @param conceptKey - A concept identifier (IRI or local name).
   * @returns A CSS hex color string such as `#81c784`.
   */
  static colorFor(conceptKey: string): string {
    if (conceptKey === '') return ConceptPalette.PALETTE[0] as string;

    const local = ConceptPalette.localName(conceptKey).toLowerCase();
    const pinned = ConceptPalette.CONCEPT_SLOTS[local];
    if (pinned !== undefined) {
      return ConceptPalette.PALETTE[pinned] as string;
    }

    // Unknown concept: deterministic placement. djb2 over the local name picks
    // a palette slot; if that slot lands on the palette, use it, else generate a
    // golden-angle hue so the color is still distinct and stable.
    const hash = ConceptPalette.djb2(local);
    const slot = hash % ConceptPalette.PALETTE.length;
    // Bias unknown concepts toward golden-angle hues so they don't masquerade as
    // a pinned concept's color — pinned concepts own the curated slots.
    const usedSlots = new Set(Object.values(ConceptPalette.CONCEPT_SLOTS));
    if (!usedSlots.has(slot)) {
      return ConceptPalette.PALETTE[slot] as string;
    }
    const hue = ((hash * 137.508) % 360 + 360) % 360;
    return ConceptPalette.hslToHex(hue, 62, 56);
  }

  /**
   * Returns a render size (float, 2–20 range) derived from node degree.
   *
   * @param degree - The node's graph degree (number of connected edges).
   * @returns A float in the range [2, 20].
   */
  static sizeFor(degree: number): number {
    return Math.max(2, Math.min(20, degree / 3));
  }

  /**
   * Returns the default edge hex color — a dark neutral for low visual contrast
   * at rest.
   *
   * @returns `'#2a2a2a'`
   */
  static edgeColor(): string {
    return '#2a2a2a';
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private static localName(iri: string): string {
    const hashIdx = iri.lastIndexOf('#');
    if (hashIdx !== -1) {
      return iri.slice(hashIdx + 1) || iri;
    }
    const slashIdx = iri.lastIndexOf('/');
    if (slashIdx !== -1) {
      return iri.slice(slashIdx + 1) || iri;
    }
    return iri;
  }

  private static djb2(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
      hash = hash >>> 0; // keep unsigned 32-bit
    }
    return hash;
  }

  private static hslToHex(h: number, s: number, l: number): string {
    const [r, g, b] = ConceptPalette.hslToRgb(h, s, l);
    return (
      '#' +
      Math.round(r * 255).toString(16).padStart(2, '0') +
      Math.round(g * 255).toString(16).padStart(2, '0') +
      Math.round(b * 255).toString(16).padStart(2, '0')
    );
  }

  /** Converts HSL (h∈[0,360), s∈[0,100], l∈[0,100]) to RGB∈[0,1]³. */
  private static hslToRgb(h: number, s: number, l: number): [number, number, number] {
    const sn = s / 100;
    const ln = l / 100;
    const a = sn * Math.min(ln, 1 - ln);
    const f = (n: number): number => {
      const k = (n + h / 30) % 12;
      return ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }
}
