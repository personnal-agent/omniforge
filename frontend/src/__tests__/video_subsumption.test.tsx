import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReferenceSlot } from '../components/dock/conditioning/ReferenceSlot';
import { ConditioningTray } from '../components/dock/conditioning/ConditioningTray';
import type { ModelDefinition, GenerationReferences } from '../types/studio';

describe('ReferenceSlot Component', () => {
  it('renders empty slot with label and file input trigger', () => {
    const onSelect = vi.fn();
    render(<ReferenceSlot label="Start frame" onFileSelected={onSelect} />);
    expect(screen.getByText('Start frame')).toBeInTheDocument();
    const file = new File(['fake'], 'start.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('reference-slot-input'), { target: { files: [file] } });
    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it('handles drag and drop of file', () => {
    const onSelect = vi.fn();
    render(<ReferenceSlot label="Drop frame" onFileSelected={onSelect} />);
    const slot = screen.getByRole('button', { name: /ajouter une référence : drop frame/i });
    const file = new File(['dummy-content'], 'dropped.png', { type: 'image/png' });
    fireEvent.dragOver(slot, { dataTransfer: { dropEffect: 'none' } });
    fireEvent.drop(slot, { dataTransfer: { files: [file] } });
    expect(onSelect).toHaveBeenCalledWith(file);
  });

  it('renders filled slot with preview and clear button', () => {
    const onClear = vi.fn();
    render(<ReferenceSlot label="Start frame" fileUrl="blob:http://localhost/start.png" onClear={onClear} />);
    const clearBtn = screen.getByRole('button', { name: /supprimer la référence start frame/i });
    expect(clearBtn).toBeInTheDocument();
    fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });
});

describe('ConditioningTray & Video Subsumption', () => {
  const completeVideoModel: ModelDefinition = {
    id: 'wan-2.1', name: 'Wan 2.1 Video', type: 'video',
    capabilities: { supportsFirstFrame: true, supportsLastFrame: true, supportsImageRef: true, maxImageRefs: 9, supportsVideoRef: true, maxVideoRefs: 1 },
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    window.URL.createObjectURL = vi.fn((file: File) => `blob:mock/${file.name}`);
    window.URL.revokeObjectURL = vi.fn();
  });

  it('renders complete video slots: Start frame, End frame and Ingredients', () => {
    render(<ConditioningTray mode="video" model={completeVideoModel} references={{ startFrame: null, endFrame: null, imageRefs: [], videoRefs: [] }} onReferencesChange={() => {}} />);
    expect(screen.getByText('Start frame')).toBeInTheDocument();
    expect(screen.getByText('End frame')).toBeInTheDocument();
    expect(screen.getByText('+ Ingrédient')).toBeInTheDocument();
  });

  it('supports single ingredient mode without start or end frame', () => {
    render(<ConditioningTray mode="video" model={completeVideoModel} references={{ imageRefs: ['blob:http://localhost/char_bible.png'] }} onReferencesChange={vi.fn()} />);
    expect(screen.getByText('Start frame')).toBeInTheDocument();
    expect(screen.getByText('End frame')).toBeInTheDocument();
    expect(screen.getByText('Réf 1')).toBeInTheDocument();
  });

  it('shows warning when exceeding maxImageRefs', () => {
    const overLimitRefs = { imageRefs: Array.from({ length: 10 }, (_, i) => `blob:ref_${i}.png`) };
    render(<ConditioningTray mode="video" model={completeVideoModel} references={overLimitRefs} onReferencesChange={() => {}} />);
    expect(screen.getByText(/limite de références/i)).toBeInTheDocument();
  });

  it('allows adding real files and revokes URL on clear and ingredient removal', () => {
    const ControlledTest = () => {
      const [refs, setRefs] = useState<GenerationReferences>({});
      return <ConditioningTray mode="video" model={completeVideoModel} references={refs} onReferencesChange={setRefs} />;
    };
    render(<ControlledTest />);

    // 1. Add Start Frame
    const startFile = new File(['start-data'], 'start.png', { type: 'image/png' });
    fireEvent.change(screen.getAllByTestId('reference-slot-input')[0], { target: { files: [startFile] } });
    expect(window.URL.createObjectURL).toHaveBeenCalledWith(startFile);

    // 2. Clear Start Frame -> verifies URL.revokeObjectURL
    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence start frame/i }));
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/start.png');

    // 3. Add Image Ingredient
    const imgIngredient = new File(['ingredient-img'], 'char.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getAllByTestId('reference-slot-input').pop()!, { target: { files: [imgIngredient] } });
    expect(screen.getByText('Réf 1')).toBeInTheDocument();

    // 4. Remove ingredient -> URL revoked
    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence réf 1/i }));
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/char.jpg');
  });

  it('enforces maxVideoRefs quota when adding video ingredients', () => {
    const ControlledTest = () => {
      const [refs, setRefs] = useState<GenerationReferences>({});
      return <ConditioningTray mode="video" model={completeVideoModel} references={refs} onReferencesChange={setRefs} />;
    };
    render(<ControlledTest />);

    // Add first video
    const video1 = new File(['video-1'], 'action.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getAllByTestId('reference-slot-input').pop()!, { target: { files: [video1] } });
    expect(screen.getByRole('button', { name: /supprimer la référence vidéo 1/i })).toBeInTheDocument();
    expect(screen.getByText('N-1')).toBeInTheDocument();

    // Try adding a second video when quota is 1
    const video2 = new File(['video-2'], 'extra.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getAllByTestId('reference-slot-input').pop()!, { target: { files: [video2] } });
    expect(screen.queryByRole('button', { name: /supprimer la référence vidéo 2/i })).not.toBeInTheDocument();
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/extra.mp4');
  });

  it('renders Lip Sync mode with portrait image and vocal audio slots', () => {
    render(<ConditioningTray mode="lip_sync" model={{ id: 'sad-talker', name: 'SadTalker', type: 'lip_sync' }} references={{}} onReferencesChange={() => {}} />);
    expect(screen.getByText(/portrait/i)).toBeInTheDocument();
    expect(screen.getByText(/voix/i)).toBeInTheDocument();
  });

  it('naturally attaches a video file or portrait image in Lip Sync mode', () => {
    let capturedRefs: GenerationReferences = {};
    const ControlledLipSync = () => {
      const [refs, setRefs] = useState<GenerationReferences>({});
      capturedRefs = refs;
      return (
        <ConditioningTray
          mode="lip_sync"
          model={{ id: 'latentsync', name: 'LatentSync Video Dubbing', type: 'lip_sync' }}
          references={refs}
          onReferencesChange={setRefs}
        />
      );
    };
    render(<ControlledLipSync />);

    const slots = screen.getAllByTestId('reference-slot-input');
    expect(slots[0].getAttribute('accept')).toContain('video/*');

    const videoFile = new File(['video-bytes'], 'plan1.mp4', { type: 'video/mp4' });
    fireEvent.change(slots[0], { target: { files: [videoFile] } });

    expect(capturedRefs.videoRefs).toEqual(['blob:mock/plan1.mp4']);
    expect(capturedRefs.imageRefs).toEqual([]);
    const videoElem = document.querySelector('video');
    expect(videoElem).toBeInTheDocument();
    expect(videoElem?.getAttribute('src')).toBe('blob:mock/plan1.mp4');
  });

  it('renders Upscale mode with media source slot and preserves video preview', () => {
    const ControlledUpscale = () => {
      const [refs, setRefs] = useState<GenerationReferences>({});
      return <ConditioningTray mode="upscale" model={{ id: 'topaz', name: 'Topaz Upscale', type: 'upscale' }} references={refs} onReferencesChange={setRefs} />;
    };
    render(<ControlledUpscale />);
    const videoFile = new File(['video-data'], 'render.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByTestId('reference-slot-input'), { target: { files: [videoFile] } });
    const videoElem = document.querySelector('video');
    expect(videoElem).toBeInTheDocument();
    expect(videoElem?.getAttribute('src')).toBe('blob:mock/render.mp4');
  });

  it('does not revoke a locally created blob URL on removal if it is still used elsewhere', () => {
    window.URL.revokeObjectURL = vi.fn();
    const ControlledShared = () => {
      const [refs, setRefs] = useState<GenerationReferences>({});
      return (
        <div>
          <ConditioningTray mode="video" model={completeVideoModel} references={refs} onReferencesChange={setRefs} />
          {refs.startFrame && !refs.imageRefs?.length && (
            <button data-testid="share-url" onClick={() => setRefs({ ...refs, imageRefs: [refs.startFrame!] })}>Share</button>
          )}
        </div>
      );
    };
    render(<ControlledShared />);
    const file = new File(['data'], 'shared.png', { type: 'image/png' });
    fireEvent.change(screen.getAllByTestId('reference-slot-input')[0], { target: { files: [file] } });
    fireEvent.click(screen.getByTestId('share-url'));
    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence start frame/i }));
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:mock/shared.png');
    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence réf 1/i }));
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock/shared.png');
  });

  it('does not revoke a parent-provided blob URL even when removed from all slots', () => {
    const parentUrl = 'blob:mock/parent-owned.png';
    window.URL.revokeObjectURL = vi.fn();
    const ControlledParent = () => {
      const [refs, setRefs] = useState<GenerationReferences>({ startFrame: parentUrl });
      return <ConditioningTray mode="video" model={completeVideoModel} references={refs} onReferencesChange={setRefs} />;
    };
    render(<ControlledParent />);
    fireEvent.click(screen.getByRole('button', { name: /supprimer la référence start frame/i }));
    expect(window.URL.revokeObjectURL).not.toHaveBeenCalledWith(parentUrl);
  });

  it('hides conditioning tray in LLM mode', () => {
    const { container } = render(<ConditioningTray mode="llm" model={{ id: 'llama', name: 'Llama 3', type: 'text' }} references={{}} onReferencesChange={() => {}} />);
    expect(container.firstChild).toBeNull();
  });
});
