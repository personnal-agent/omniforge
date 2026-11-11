import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CharactersModal } from '../components/characters/CharactersModal';
import { apiClient } from '../services/apiClient';
import type { Character } from '../types/studio';

const mockCharacters: Character[] = [
  {
    id: 'char-1',
    name: 'Elena Vance',
    triggerToken: '@Elena',
    physicalPrompt: 'Cyberpunk netrunner with silver cropped hair, glowing blue ocular implant',
    archetype: 'The Wildcard',
    visualAnchors: ['silver cropped hair', 'blue ocular implant', 'matte black duster'],
    voiceProfileId: 'voice-elena-1',
    voiceStyle: 'feminine_soft',
    enginePreference: 'local',
    createdAt: '2026-10-29T10:00:00Z',
  },
  {
    id: 'char-2',
    name: 'Marcus Sterling',
    triggerToken: '@Marcus',
    physicalPrompt: 'Corporate strategist in bespoke charcoal three-piece suit, gold signet ring',
    archetype: 'The Professional',
    visualAnchors: ['charcoal suit', 'gold signet ring'],
    voiceProfileId: 'voice-marcus-1',
    voiceStyle: 'masculine_deep',
    enginePreference: 'cloud',
    createdAt: '2026-10-29T11:00:00Z',
  },
];

describe('CharactersModal - Google Flow Pro Alignment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(apiClient, 'listCharacters').mockResolvedValue(mockCharacters);
    vi.spyOn(apiClient, 'createCharacter').mockResolvedValue(mockCharacters[0]);
    vi.spyOn(apiClient, 'deleteCharacter').mockResolvedValue({ deleted: true, id: 'char-1' });
  });

  it('renders existing characters with archetypes and visual anchors', async () => {
    render(<CharactersModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('@Elena')).toBeInTheDocument();
      expect(screen.getByText('@Marcus')).toBeInTheDocument();
    });

    expect(screen.getAllByText(/The Wildcard/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/The Professional/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/silver cropped hair/i).length).toBeGreaterThanOrEqual(1);
  });

  it('renders 6 archetypes, allows adding visual anchors and submits with engine preference', async () => {
    render(<CharactersModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/Nouveau personnage/i)).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText(/Nouveau personnage/i));

    // Verify all 6 archetypes exist
    expect(screen.getByText('The Eccentric')).toBeInTheDocument();
    expect(screen.getByText('The Professional')).toBeInTheDocument();
    expect(screen.getByText('The Wildcard')).toBeInTheDocument();
    expect(screen.getByText('The Familiar')).toBeInTheDocument();
    expect(screen.getByText('The Wicked')).toBeInTheDocument();
    expect(screen.getByText('The Fantastical')).toBeInTheDocument();

    // Select 'The Wicked'
    fireEvent.click(screen.getByText('The Wicked'));

    // Fill name & description
    fireEvent.change(screen.getByPlaceholderText(/Tomate/i), {
      target: { value: 'Shadow Lord' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Anthropomorphic ripe red tomato/i), {
      target: { value: 'Shadowy sorcerer with burning obsidian eyes' },
    });

    // Add visual anchors
    const anchorInput = screen.getByPlaceholderText(/Ajouter une ancre/i);
    fireEvent.change(anchorInput, { target: { value: 'cape d’éclipse' } });
    fireEvent.click(screen.getByRole('button', { name: /Ajouter ancre/i }));

    expect(screen.getByText('cape d’éclipse')).toBeInTheDocument();

    // Select engine preference 'hybrid'
    const hybridBtn = screen.getByRole('button', { name: /Hybride/i });
    fireEvent.click(hybridBtn);

    // Submit form
    fireEvent.click(screen.getByRole('button', { name: /Enregistrer la fiche/i }));

    await waitFor(() => {
      expect(apiClient.createCharacter).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Shadow Lord',
          physicalPrompt: 'Shadowy sorcerer with burning obsidian eyes',
          archetype: 'The Wicked',
          visualAnchors: ['cape d’éclipse'],
          enginePreference: 'hybrid',
        }),
      );
    });
  });

  it('filters characters list by archetype', async () => {
    render(<CharactersModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('@Elena')).toBeInTheDocument();
    });

    // Click filter pill for 'The Professional'
    const filterPill = screen.getByRole('button', { name: /Filtre: The Professional/i });
    fireEvent.click(filterPill);

    await waitFor(() => {
      expect(apiClient.listCharacters).toHaveBeenCalledWith('The Professional');
    });
  });

  it('triggers generateCharacterSheet when clicking planche reference button', async () => {
    vi.spyOn(apiClient, 'generateCharacterSheet').mockResolvedValue({
      taskId: 'gen-sheet-123',
      characterId: 'char-1',
      prompt: 'Character turnaround sheet',
      seed: 555444,
    });
    vi.spyOn(apiClient, 'subscribeTaskStatus').mockReturnValue(() => {});

    render(<CharactersModal isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('@Elena')).toBeInTheDocument();
    });

    const sheetBtns = screen.getAllByRole('button', { name: /Planche Réf|Regénérer/i });
    expect(sheetBtns.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(sheetBtns[0]);

    await waitFor(() => {
      expect(apiClient.generateCharacterSheet).toHaveBeenCalledWith('char-1');
    });
  });
});
