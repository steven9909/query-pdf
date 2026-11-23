/** Converts PDF link annotations into clickable page regions. */

export interface PageLink {
  left: number;
  top: number;
  width: number;
  height: number;
  url?: string;
  dest?: unknown;
}

export interface LinkAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
}

/** Returns true for URLs that may be handed to the system browser. */
export function isExternalUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

/** Maps link annotations to unscaled CSS boxes using a viewport rectangle converter. */
export function pageLinks(annotations: LinkAnnotation[], toViewport: (rect: number[]) => number[]): PageLink[] {
  const links: PageLink[] = [];
  for (const a of annotations) {
    if (a.subtype !== "Link" || !a.rect || a.rect.length !== 4) continue;
    const url = a.url && isExternalUrl(a.url) ? a.url : undefined;
    if (!url && a.dest == null) continue;
    const [x1, y1, x2, y2] = toViewport(a.rect);
    links.push({
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      ...(url ? { url } : { dest: a.dest }),
    });
  }
  return links;
}

/** Returns the index of the link containing an unscaled page point, or -1. */
export function linkAt(links: PageLink[], x: number, y: number): number {
  return links.findIndex((l) => x >= l.left && x <= l.left + l.width && y >= l.top && y <= l.top + l.height);
}
