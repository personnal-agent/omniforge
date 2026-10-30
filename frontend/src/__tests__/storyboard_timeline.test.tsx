import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StoryboardTimeline } from '../components/canvas/StoryboardTimeline';
import type { StorySegmentResponse } from '../types/studio';

describe('StoryboardTimeline Component (TDD)', () => {
  const mockSegments: StorySegmentResponse[] = [
    {
      index: 1,
      durationSec: 5.0,
      actionPrompt: '@Astrid scrute le glacier nordique',
      shotType: "Plan d'ensemble",
      compiledPrompt: '[Astrid Identity] Astrid scrute le glacier',
      characterIds: ['char_a54bffeb'],
      characterAnchors: [
        {
          id: 'char_a54bffeb',
          name: 'Astrid',
          archetype: 'The Fantastical',
          visualAnchors: ['platinum braid', 'cyan glowing runes'],
        },
      ],
      status: 'pending',
    },
    {
      index: 2,
      durationSec: 5.0,
      actionPrompt: '@Astrid dégaine son épée de valkyrie',
      shotType: 'Gros plan',
      compiledPrompt: '[Astrid Identity] Astrid dégaine son épée',
      characterIds: ['char_a54bffeb'],
      characterAnchors: [],
      status: 'running',
    },
  ];

  it('renders shot count, total duration and plan cards', () => {
    render(
      <StoryboardTimeline
        segments={mockSegments}
        totalDurationSec={10.0}
        sceneOverview="Glacier nordique brumeux"
        onGeneratePlan={vi.fn()}
        onGenerateAllPlans={vi.fn()}
      />
    );

    expect(screen.getByText(/2 plans/i)).toBeInTheDocument();
    expect(screen.getByText(/10s total/i)).toBeInTheDocument();
    expect(screen.getByText(/@Astrid scrute le glacier nordique/i)).toBeInTheDocument();
    expect(screen.getByText(/@Astrid dégaine son épée de valkyrie/i)).toBeInTheDocument();
    expect(screen.getByText(/Plan 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Plan 2/i)).toBeInTheDocument();
  });

  it('displays character anchors pills for detected characters', () => {
    render(
      <StoryboardTimeline
        segments={mockSegments}
        totalDurationSec={10.0}
        sceneOverview=""
        onGeneratePlan={vi.fn()}
        onGenerateAllPlans={vi.fn()}
      />
    );

    expect(screen.getByText('Astrid')).toBeInTheDocument();
    expect(screen.getByText('platinum braid')).toBeInTheDocument();
    expect(screen.getByText('cyan glowing runes')).toBeInTheDocument();
  });

  it('triggers onGeneratePlan when clicking a plan render button', () => {
    const handleGeneratePlan = vi.fn();
    render(
      <StoryboardTimeline
        segments={mockSegments}
        totalDurationSec={10.0}
        sceneOverview=""
        onGeneratePlan={handleGeneratePlan}
        onGenerateAllPlans={vi.fn()}
      />
    );

    const plan1Btn = screen.getByTestId('generate-plan-1-btn');
    fireEvent.click(plan1Btn);

    expect(handleGeneratePlan).toHaveBeenCalledWith(mockSegments[0]);
  });

  it('triggers onGenerateAllPlans when clicking the global sequence button', () => {
    const handleGenerateAll = vi.fn();
    render(
      <StoryboardTimeline
        segments={mockSegments}
        totalDurationSec={10.0}
        sceneOverview=""
        onGeneratePlan={vi.fn()}
        onGenerateAllPlans={handleGenerateAll}
      />
    );

    const allBtn = screen.getByTestId('generate-all-sequence-btn');
    fireEvent.click(allBtn);

    expect(handleGenerateAll).toHaveBeenCalled();
  });
});
