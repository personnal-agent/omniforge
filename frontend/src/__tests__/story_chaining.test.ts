import { describe, it, expect } from 'vitest';
import { buildChainedPlanOptions, pickSequenceSeed } from '../services/storyChaining';

describe('storyChaining (continuité visuelle inter-plans)', () => {
  it('plan 1 : aucune image de départ, graine de séquence partagée', () => {
    const opts = buildChainedPlanOptions({ index: 1 }, { seed: 4242 });
    expect(opts.seed).toBe(4242);
    expect(opts.startFrameRef).toBeUndefined();
  });

  it('plan N>1 : démarre sur le plan précédent avec la même graine', () => {
    const opts = buildChainedPlanOptions({ index: 3 }, { seed: 4242, prevTaskId: 'gen_prev' });
    expect(opts.seed).toBe(4242);
    expect(opts.startFrameRef).toBe('gen_prev');
  });

  it('plan N>1 sans plan précédent réussi : pas de startFrame (repli T2V)', () => {
    const opts = buildChainedPlanOptions({ index: 2 }, { seed: 7 });
    expect(opts.startFrameRef).toBeUndefined();
  });

  it('plan N>1 avec changement complet de personnage : omet startFrameRef pour laisser la fiche personnage dédiée prendre le relais', () => {
    const optsDisjoint = buildChainedPlanOptions(
      { index: 2, characterIds: ['char_elena'] },
      { seed: 4242, prevTaskId: 'gen_plan1', prevCharacterIds: ['char_astrid'] }
    );
    expect(optsDisjoint.seed).toBe(4242);
    expect(optsDisjoint.startFrameRef).toBeUndefined();

    const optsOverlap = buildChainedPlanOptions(
      { index: 3, characterIds: ['char_astrid', 'char_elena'] },
      { seed: 4242, prevTaskId: 'gen_plan2', prevCharacterIds: ['char_elena'] }
    );
    expect(optsOverlap.startFrameRef).toBe('gen_plan2');
  });

  it('pickSequenceSeed retourne un entier strictement positif', () => {
    for (let i = 0; i < 50; i++) {
      const s = pickSequenceSeed();
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThan(0);
    }
  });
});
