/** Options de soumission d'un plan pour garantir la continuité visuelle d'une séquence. */
export interface ChainedPlanOptions {
  seed: number;
  startFrameRef?: string;
}

/** Graine unique partagée par tous les plans d'une même séquence. */
export function pickSequenceSeed(): number {
  return Math.floor(Math.random() * 999_999) + 1;
}

/**
 * Plan 1 : texte -> vidéo (ou ancre personnage). Plans suivants : image de départ = dernière image
 * du plan précédent lorsque au moins un personnage persiste à l'écran. Si la distribution change
 * totalement entre deux plans (ex: Plan 1 @Astrid seule -> Plan 2 @Elena seule), on omet
 * `startFrameRef` pour que l'orchestrateur utilise directement la fiche de référence PNG du
 * nouveau personnage actif.
 */
export function buildChainedPlanOptions(
  segment: { index: number; characterIds?: string[] },
  ctx: { seed: number; prevTaskId?: string; prevCharacterIds?: string[] }
): ChainedPlanOptions {
  const opts: ChainedPlanOptions = { seed: ctx.seed };
  if (segment.index > 1 && ctx.prevTaskId) {
    const curChars = segment.characterIds || [];
    const prevChars = ctx.prevCharacterIds || [];
    const hasDisjointCast =
      curChars.length > 0 &&
      prevChars.length > 0 &&
      !curChars.some((id) => prevChars.includes(id));

    if (!hasDisjointCast) {
      opts.startFrameRef = ctx.prevTaskId;
    }
  }
  return opts;
}
