import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ArrowUp, Square, Image, Video, Mic, Maximize2, MessageSquare, AlertCircle,
  Sparkles, User, ChevronDown, ChevronUp, Sliders,
} from 'lucide-react';
import type {
  ModelDefinition, BrandKit, Generation, GenerationParameters,
  GenerationReferences, GenerationSubmitRequest, WorkloadEstimate,
  EnginePreference, AgentInstruction,
} from '../../types/studio';
import { ConditioningTray } from './conditioning/ConditioningTray';
import { ParameterRegistry } from './ParameterRegistry';
import { PromptEditorWithChip } from '../brand-kit/PromptEditorWithChip';
import { BrandKitSelectorPopover } from '../brand-kit/BrandKitSelectorPopover';
import { BrandKitCreateModal } from '../brand-kit/BrandKitCreateModal';
import { BrandKitInspectorModal } from '../brand-kit/BrandKitInspectorModal';
import { CharactersModal } from '../characters/CharactersModal';
import { LlmChatView, type ChatMessage } from './LlmChatView';
import { EngineSelectorPill } from './EngineSelectorPill';
import { IngredientsPopover } from './IngredientsPopover';
import { AgentInstructionsDrawer } from './AgentInstructionsDrawer';
import { apiClient } from '../../services/apiClient';

export type DockMode = 'image' | 'video' | 'lip_sync' | 'upscale' | 'llm';

interface ModeState {
  prompt: string;
  model: ModelDefinition | null;
  parameters: GenerationParameters;
  references: GenerationReferences;
  selectedBrandKit: BrandKit | null;
  batchCount: number;
  talkingStyle: string;
  upscaleScale: string;
  upscaleQuality: string;
  upscaleFrameRate: string;
  negativePrompt: string;
}

const DEFAULT_PARAMS: GenerationParameters = {
  aspectRatio: '16:9', resolution: '1080p', duration: '5s', seed: -1, enhance: false,
};

const DEFAULT_REFS: GenerationReferences = { imageRefs: [], videoRefs: [], audioRefs: [] };

const createInitialState = (): ModeState => ({
  prompt: '', model: null, parameters: { ...DEFAULT_PARAMS }, references: { ...DEFAULT_REFS },
  selectedBrandKit: null, batchCount: 1, talkingStyle: 'Stable', upscaleScale: '2x',
  upscaleQuality: 'Fast', upscaleFrameRate: 'Same as source', negativePrompt: '',
});

export interface FloatingPromptDockProps {
  models: ModelDefinition[];
  brandKits: BrandKit[];
  generations?: Generation[];
  activeProjectId?: string | null;
  remixContext?: Generation | null;
  onClearRemix?: () => void;
  onCreateBrandKit?: (data: {
    source: 'blank' | 'website' | 'files'; name: string; overview?: string; url?: string; files?: File[];
  }) => Promise<BrandKit>;
  onSubmitGeneration?: (req: GenerationSubmitRequest) => Promise<unknown>;
  onBrandKitCreated?: (kit: BrandKit) => void;
  className?: string;
}

export const FloatingPromptDock: React.FC<FloatingPromptDockProps> = ({
  models, brandKits, generations = [], activeProjectId, remixContext, onClearRemix,
  onCreateBrandKit, onSubmitGeneration, onBrandKitCreated, className = '',
}) => {
  const [activeMode, setActiveMode] = useState<DockMode>('video');
  const [modeStates, setModeStates] = useState<Record<DockMode, ModeState>>({
    image: createInitialState(), video: createInitialState(), lip_sync: createInitialState(),
    upscale: createInitialState(), llm: createInitialState(),
  });

  const [llmMessages, setLlmMessages] = useState<ChatMessage[]>([]);
  const [isLlmStreaming, setIsLlmStreaming] = useState(false);
  const llmAbortRef = useRef<AbortController | null>(null);

  // Google Flow Pro States
  const [agentEnabled, setAgentEnabled] = useState(true);
  const [enginePreference, setEnginePreference] = useState<EnginePreference>('local');
  const [isAgentDrawerOpen, setIsAgentDrawerOpen] = useState(false);
  const [isIngredientsPopoverOpen, setIsIngredientsPopoverOpen] = useState(false);
  const [agentInstructions, setAgentInstructions] = useState<AgentInstruction[]>([]);

  const [isBrandKitPopoverOpen, setIsBrandKitPopoverOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isCharactersModalOpen, setIsCharactersModalOpen] = useState(false);
  const [inspectingKit, setInspectingKit] = useState<BrandKit | null>(null);
  const [estimate, setEstimate] = useState<WorkloadEstimate | null>(null);
  const [isMinimized, setIsMinimized] = useState(false);

  useEffect(() => {
    if (apiClient.listAgentInstructions) {
      apiClient.listAgentInstructions().then(setAgentInstructions).catch(() => {});
    }
  }, []);

  const current = modeStates[activeMode];

  const updateCurrent = useCallback((patch: Partial<ModeState>) => {
    setModeStates((prev) => ({
      ...prev, [activeMode]: { ...prev[activeMode], ...patch },
    }));
  }, [activeMode]);

  useEffect(() => {
    if (!current.prompt.trim() || activeMode === 'llm' || activeMode === 'upscale') {
      setEstimate(null);
      return;
    }
    const timer = setTimeout(() => {
      apiClient.estimateWorkload({
        prompt: current.prompt,
        modelId: current.model?.id || 'minimax-h3',
        type: activeMode,
        duration: current.parameters.duration || '5s',
        resolution: current.parameters.resolution,
        batchCount: current.batchCount,
      }).then(setEstimate).catch(() => setEstimate(null));
    }, 200);
    return () => clearTimeout(timer);
  }, [current.prompt, activeMode, current.model, current.parameters.duration, current.parameters.resolution, current.batchCount]);

  const [mediaError, setMediaError] = useState<string | null>(null);
  const [isSubmittingMedia, setIsSubmittingMedia] = useState(false);

  useEffect(() => {
    setModeStates((prev) => {
      const next = { ...prev };
      const modes: DockMode[] = ['image', 'video', 'lip_sync', 'upscale', 'llm'];
      modes.forEach((m) => {
        const typeMatch = m === 'llm' ? 'text' : m === 'lip_sync' ? 'lipsync' : m;
        const currentModel = next[m].model;
        const matchType = (t: string) => {
          if (typeMatch === 'text') return t === 'text' || t === 'llm';
          if (typeMatch === 'lipsync') return t === 'lipsync' || t === 'lip_sync';
          return t === typeMatch;
        };
        const isCurrentValid = currentModel && matchType(currentModel.type);
        const isCurrentLocal = currentModel?.badge === 'Local';
        const localFound = models.find((mod) => matchType(mod.type) && mod.badge === 'Local');
        if (!isCurrentValid || (!isCurrentLocal && localFound)) {
          const found = localFound || models.find((mod) => matchType(mod.type));
          if (found) next[m].model = found;
        }
      });
      return next;
    });
  }, [models]);

  useEffect(() => {
    if (remixContext) {
      const mediaType = remixContext.mediaType.toLowerCase();
      let targetMode: DockMode = 'image';
      if (mediaType.includes('video')) targetMode = 'video';
      else if (mediaType.includes('lip')) targetMode = 'lip_sync';
      else if (mediaType.includes('up')) targetMode = 'upscale';

      setActiveMode(targetMode);
      setModeStates((prev) => {
        const cur = prev[targetMode];
        let matchingModel: ModelDefinition | null = models.find((m) => m.id === remixContext.modelId) || null;
        if (
          !matchingModel ||
          (targetMode === 'upscale' && matchingModel.type !== 'upscale') ||
          (targetMode === 'lip_sync' && matchingModel.type !== 'lipsync' && matchingModel.type !== 'lip_sync')
        ) {
          if (targetMode === 'upscale') {
            matchingModel = models.find((m) => m.type === 'upscale' && m.badge === 'Local') || models.find((m) => m.type === 'upscale') || cur.model;
          } else if (targetMode === 'lip_sync') {
            matchingModel =
              models.find((m) => (m.type === 'lipsync' || m.type === 'lip_sync') && m.badge === 'Local') ||
              models.find((m) => m.type === 'lipsync' || m.type === 'lip_sync') ||
              cur.model;
          } else {
            matchingModel = cur.model;
          }
        }
        const matchingKit = remixContext.brandKitSnapshot
          ? brandKits.find((k) => k.id === remixContext.brandKitSnapshot?.id) || null
          : null;
        return {
          ...prev,
          [targetMode]: {
            ...cur, prompt: remixContext.prompt, model: matchingModel,
            parameters: { ...cur.parameters, ...remixContext.parameters },
            references: { ...cur.references, ...remixContext.references },
            selectedBrandKit: matchingKit, negativePrompt: remixContext.negativePrompt || '',
          },
        };
      });
      if (onClearRemix) onClearRemix();
    }
  }, [remixContext, models, brandKits, onClearRemix]);

  const resolveBlobToUploaded = async (url: string | null | undefined): Promise<string | null | undefined> => {
    if (!url || typeof url !== 'string' || !url.startsWith('blob:')) return url;
    try {
      const resp = await fetch(url);
      const blob = await resp.blob();
      const ext = blob.type.includes('mp4')
        ? 'mp4'
        : blob.type.includes('webm')
        ? 'webm'
        : blob.type.includes('wav')
        ? 'wav'
        : blob.type.includes('mpeg') || blob.type.includes('mp3')
        ? 'mp3'
        : blob.type.includes('webp')
        ? 'webp'
        : 'png';
      const file = new File([blob], `ref_${Date.now()}.${ext}`, { type: blob.type || 'image/png' });
      const res = await apiClient.uploadFile(file);
      return res.filePath;
    } catch (err) {
      console.warn('Erreur téléversement référence blob:', err);
      return url;
    }
  };

  const resolveAllBlobReferences = async (refs: GenerationReferences): Promise<GenerationReferences> => {
    const next: GenerationReferences = { ...refs };
    if (next.startFrame?.startsWith('blob:')) next.startFrame = await resolveBlobToUploaded(next.startFrame);
    if (next.endFrame?.startsWith('blob:')) next.endFrame = await resolveBlobToUploaded(next.endFrame);
    if (next.upscaleSource?.startsWith('blob:')) next.upscaleSource = await resolveBlobToUploaded(next.upscaleSource);
    if (next.imageRefs?.length) {
      next.imageRefs = (await Promise.all(next.imageRefs.map(resolveBlobToUploaded))).filter(Boolean) as string[];
    }
    if (next.videoRefs?.length) {
      next.videoRefs = (await Promise.all(next.videoRefs.map(resolveBlobToUploaded))).filter(Boolean) as string[];
    }
    if (next.audioRefs?.length) {
      next.audioRefs = (await Promise.all(next.audioRefs.map(resolveBlobToUploaded))).filter(Boolean) as string[];
    }
    return next;
  };

  const handleSubmit = async () => {
    if (activeMode === 'llm') {
      const text = current.prompt.trim();
      if (!text || isLlmStreaming) return;

      const userMsg: ChatMessage = { id: `user_${Date.now()}`, role: 'user', content: text };
      const assistantId = `asst_${Date.now()}`;
      const assistantMsg: ChatMessage = { id: assistantId, role: 'assistant', content: '' };

      const newMessages = [...llmMessages, userMsg];
      setLlmMessages([...newMessages, assistantMsg]);
      updateCurrent({ prompt: '' });
      setIsLlmStreaming(true);

      const controller = new AbortController();
      llmAbortRef.current = controller;

      let chatPayloadMessages = newMessages.map((m) => ({ role: m.role, content: m.content }));
      if (current.selectedBrandKit) {
        const kit = current.selectedBrandKit;
        const brandSummary = [
          `Brand: ${kit.name}`,
          kit.overview ? `Overview: ${kit.overview}` : null,
          kit.colors?.length ? `Colors: ${kit.colors.map((c) => `${c.label} (${c.hex})`).join(', ')}` : null,
          kit.fonts?.length ? `Fonts: ${kit.fonts.map((f) => `${f.family} ${f.weight}`).join(', ')}` : null,
          kit.guidelines?.length ? `Guidelines: ${kit.guidelines.map((g) => `[${g.kind.toUpperCase()}] ${g.text}`).join('; ')}` : null,
        ].filter(Boolean).join('\n');
        chatPayloadMessages = [{ role: 'system', content: `Condition your responses using this Brand Kit:\n${brandSummary}` }, ...chatPayloadMessages];
      }

      try {
        await apiClient.streamChatCompletion(
          {
            model: current.model?.name || current.model?.id || 'Qwen 3.5 9B Defiant Fable Heretic',
            messages: chatPayloadMessages,
          },
          (chunk) => {
            setLlmMessages((prev) => prev.map((msg) => (msg.id === assistantId ? { ...msg, content: msg.content + chunk } : msg)));
          },
          controller.signal
        );
      } catch (err: unknown) {
        if ((err as Error)?.name !== 'AbortError') {
          setLlmMessages((prev) =>
            prev.map((msg) => (msg.id === assistantId ? { ...msg, content: msg.content + ` [Erreur: ${(err as Error)?.message || 'Inconnue'}]` } : msg))
          );
        }
      } finally {
        setIsLlmStreaming(false);
        llmAbortRef.current = null;
      }
      return;
    }

    const hasLipSyncMediaOnly =
      activeMode === 'lip_sync' &&
      Boolean(
        (current.references.videoRefs?.length || current.references.imageRefs?.length) &&
          current.references.audioRefs?.length
      );
    if (activeMode !== 'upscale' && !hasLipSyncMediaOnly && !current.prompt.trim()) return;
    if (isSubmittingMedia) return;

    if (onSubmitGeneration && current.model) {
      setMediaError(null);
      setIsSubmittingMedia(true);
      try {
        const count = Math.max(1, current.batchCount || 1);
        const mediaType = activeMode === 'upscale' ? 'upscale' : activeMode === 'lip_sync' ? 'lip_sync' : activeMode;
        const resolvedReferences = await resolveAllBlobReferences(current.references);
        const effectivePrompt =
          current.prompt.trim() ||
          (activeMode === 'lip_sync' ? 'Synchronisation labiale haute fidélité' : current.prompt);
        for (let i = 0; i < count; i++) {
          await onSubmitGeneration({
            modelId: current.model.id,
            prompt: effectivePrompt,
            type: mediaType,
            negativePrompt: current.negativePrompt || undefined,
            parameters: {
              ...current.parameters,
              talkingStyle: current.talkingStyle,
              upscaleScale: current.upscaleScale,
              upscaleQuality: current.upscaleQuality,
              upscaleFrameRate: current.upscaleFrameRate,
              agentEnabled,
              enginePreference,
              activeInstructionIds: agentInstructions.filter((i) => i.isActive).map((i) => i.id),
            },
            references: resolvedReferences,
            projectId: activeProjectId,
            brandKitId: current.selectedBrandKit?.id,
          });
        }
      } catch (err: unknown) {
        setMediaError(err instanceof Error ? err.message : 'Échec de soumission de la génération.');
      } finally {
        setIsSubmittingMedia(false);
      }
    }
  };

  const handleStopLlmStreaming = () => {
    if (llmAbortRef.current) {
      llmAbortRef.current.abort();
      setIsLlmStreaming(false);
    }
  };

  const handleCreateBrandKitInternal = async (data: {
    source: 'blank' | 'website' | 'files'; name: string; overview?: string; url?: string; files?: File[];
  }): Promise<BrandKit> => {
    if (onCreateBrandKit) return await onCreateBrandKit(data);
    return await apiClient.createBrandKit(data);
  };

  const modeTabs: { id: DockMode; label: string; icon: React.ElementType }[] = [
    { id: 'image', label: 'Image', icon: Image },
    { id: 'video', label: 'Video', icon: Video },
    { id: 'lip_sync', label: 'Lip sync', icon: Mic },
    { id: 'upscale', label: 'Upscaling', icon: Maximize2 },
    { id: 'llm', label: 'LLM', icon: MessageSquare },
  ];

  if (isMinimized) {
    const activeTab = modeTabs.find((t) => t.id === activeMode) || modeTabs[0];
    const ActiveIcon = activeTab.icon;
    return (
      <div className={`fixed bottom-5 left-1/2 -translate-x-1/2 z-40 px-4 transition-all duration-200 ease-out animate-in fade-in slide-in-from-bottom-2 ${className}`}>
        <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl rounded-full shadow-2xl border border-gray-200/90 dark:border-gray-800 px-4 py-2 flex items-center space-x-3 max-w-xl sm:max-w-2xl">
          <div className="flex items-center space-x-1.5 flex-shrink-0">
            <span className="p-1.5 rounded-full bg-black text-white dark:bg-white dark:text-black">
              <ActiveIcon className="w-3.5 h-3.5" />
            </span>
            <span className="text-xs font-semibold text-gray-900 dark:text-gray-100">
              {activeTab.label}
            </span>
            {current.model && (
              <span className="text-[11px] text-gray-500 dark:text-gray-400 hidden sm:inline">
                • {current.model.name}
              </span>
            )}
          </div>

          <div className="h-4 w-px bg-gray-200 dark:bg-gray-700 flex-shrink-0" />

          <div
            className="flex-1 min-w-0 cursor-pointer"
            onClick={() => setIsMinimized(false)}
            title="Cliquer pour restaurer la fenêtre de saisie"
          >
            {current.prompt.trim() ? (
              <p className="text-xs text-gray-600 dark:text-gray-300 truncate font-mono">
                {current.prompt}
              </p>
            ) : (
              <p className="text-xs text-gray-400 italic">
                Fenêtre de saisie réduite (cliquer pour restaurer)
              </p>
            )}
          </div>

          {estimate && (
            <span className="hidden md:inline-flex items-center space-x-1 px-2.5 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950/60 text-[10px] font-medium text-indigo-700 dark:text-indigo-300 border border-indigo-100 dark:border-indigo-900/50 flex-shrink-0">
              <span>🎬 {estimate.numSegments > 1 ? `${estimate.numSegments} plans` : '1 plan'}</span>
            </span>
          )}

          <button
            type="button"
            aria-label="Restaurer la fenêtre de saisie"
            onClick={() => setIsMinimized(false)}
            title="Restaurer la fenêtre de saisie à sa place"
            className="flex items-center space-x-1.5 py-1.5 px-3.5 rounded-full text-xs font-semibold bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 shadow-sm transition-all active:scale-95 flex-shrink-0"
          >
            <ChevronUp className="w-3.5 h-3.5" />
            <span>Restaurer</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 w-full max-w-4xl z-40 px-4 transition-all duration-150 ease-out ${className}`}>
      <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-xl rounded-3xl shadow-2xl border border-gray-200/80 dark:border-gray-800 p-3 sm:p-4 flex flex-col space-y-2">
        <div className="flex items-center justify-between pb-1 border-b border-gray-100 dark:border-gray-800">
          <div className="flex items-center space-x-1 sm:space-x-1.5" role="tablist">
            {modeTabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeMode === tab.id;
              return (
                <button
                  key={tab.id} type="button" role="tab" aria-selected={isActive} aria-label={tab.label}
                  onClick={() => { setActiveMode(tab.id); setMediaError(null); }}
                  className={`flex items-center space-x-1.5 py-1 px-2.5 sm:px-3 rounded-full text-xs font-semibold transition-all duration-150 ${isActive ? 'bg-black text-white dark:bg-white dark:text-black shadow-sm' : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                >
                  <Icon className="w-3.5 h-3.5 flex-shrink-0" /><span>{tab.label}</span>
                </button>
              );
            })}
          </div>
          <div className="flex items-center space-x-1.5 sm:space-x-2">
            {/* Agent ON/OFF Switch */}
            <button
              type="button"
              role="switch"
              aria-checked={agentEnabled}
              aria-label="Basculer Agent"
              onClick={() => setAgentEnabled(!agentEnabled)}
              className={`px-2.5 py-1 rounded-full text-xs font-semibold flex items-center space-x-1 border transition-all ${
                agentEnabled
                  ? 'bg-indigo-600 text-white border-indigo-500 shadow-xs'
                  : 'bg-gray-100 text-gray-500 border-gray-200 dark:bg-gray-800 dark:text-gray-400 dark:border-gray-700'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              <span>Agent {agentEnabled ? 'ON' : 'OFF'}</span>
            </button>

            {/* Agent Instructions Drawer trigger */}
            <button
              type="button"
              aria-label="Agent Instructions"
              onClick={() => setIsAgentDrawerOpen(true)}
              className="text-xs text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 font-medium py-1 px-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center space-x-1"
            >
              <Sliders className="w-3.5 h-3.5 text-indigo-500" />
              <span className="hidden sm:inline">Instructions</span>
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-indigo-500/10 text-indigo-500 dark:bg-indigo-400/10 dark:text-indigo-300 font-mono">
                {agentInstructions.filter((i) => i.isActive).length}
              </span>
            </button>

            {/* Characters Modal trigger */}
            <button
              type="button"
              aria-label="Personnages"
              onClick={() => setIsCharactersModalOpen(true)}
              className="text-xs text-gray-600 hover:text-indigo-600 dark:text-gray-300 dark:hover:text-indigo-400 font-medium py-1 px-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center space-x-1"
            >
              <User className="w-3.5 h-3.5 text-indigo-500" />
              <span className="hidden sm:inline">Personnages</span>
            </button>

            <div className="h-4 w-px bg-gray-200 dark:bg-gray-700 mx-0.5" />
            <button
              type="button"
              aria-label="Réduire la fenêtre de saisie"
              onClick={() => setIsMinimized(true)}
              title="Réduire pour laisser mieux entrevoir la galerie"
              className="text-xs text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 font-medium py-1 px-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex items-center space-x-1"
            >
              <ChevronDown className="w-3.5 h-3.5 text-gray-500" />
              <span>Réduire</span>
            </button>
          </div>
        </div>

        {activeMode === 'llm' && (
          <LlmChatView
            messages={llmMessages}
            isStreaming={isLlmStreaming}
            onStopStreaming={handleStopLlmStreaming}
          />
        )}

        {activeMode !== 'llm' && (
          <ConditioningTray
            mode={activeMode} model={current.model} references={current.references}
            onReferencesChange={(refs) => updateCurrent({ references: refs })}
          />
        )}

        {mediaError && (
          <div className="flex items-center justify-between px-3.5 py-2 text-xs bg-red-50 dark:bg-red-950/40 text-red-600 dark:text-red-400 rounded-xl border border-red-200 dark:border-red-800 animate-in fade-in duration-100">
            <div className="flex items-center space-x-1.5">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>{mediaError}</span>
            </div>
            <button type="button" aria-label="Dismiss error" onClick={() => setMediaError(null)} className="ml-2 font-bold text-gray-400 hover:text-red-700">&times;</button>
          </div>
        )}

        <div className="bg-gray-50 dark:bg-gray-800/60 rounded-2xl p-3 border border-gray-100 dark:border-gray-700/60 focus-within:border-gray-300 dark:focus-within:border-gray-600 transition-colors">
          {estimate && (
            <div className="flex items-center flex-wrap gap-2 px-2.5 py-1.5 mb-2 bg-indigo-50/70 dark:bg-indigo-950/40 border border-indigo-100 dark:border-indigo-900/50 rounded-xl text-[11px] text-indigo-900 dark:text-indigo-200 animate-in fade-in duration-100">
              <span className="font-semibold flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span>{estimate.numSegments > 1 ? `🎬 ${estimate.numSegments} plans (${estimate.totalDurationSec}s)` : `🎬 1 plan (${estimate.totalDurationSec}s)`}</span>
              </span>
              <span className="text-gray-300 dark:text-gray-600">•</span>
              <span className="font-mono text-gray-700 dark:text-gray-300">
                ⚡ ~{Math.max(1, Math.round(estimate.estimatedSecondsGpu / 60))} min (RTX 5000 Ada)
              </span>
              <span className="text-gray-300 dark:text-gray-600">•</span>
              <span className="text-gray-600 dark:text-gray-400">
                💾 {estimate.estimatedVramGb} Go VRAM
              </span>
              {estimate.detectedDialoguesCount > 0 && (
                <>
                  <span className="text-gray-300 dark:text-gray-600">•</span>
                  <span className="text-purple-700 dark:text-purple-300 font-medium">
                    🎙️ {estimate.detectedDialoguesCount} dialogue(s) audio
                  </span>
                </>
              )}
              {estimate.detectedCharacters.length > 0 && (
                <>
                  <span className="text-gray-300 dark:text-gray-600">•</span>
                  <span className="text-emerald-700 dark:text-emerald-400 font-bold font-mono">
                    👤 {estimate.detectedCharacters.join(' ')}
                  </span>
                </>
              )}
            </div>
          )}

          <PromptEditorWithChip
            prompt={current.prompt}
            onPromptChange={(prompt) => {
              updateCurrent({ prompt });
              if (mediaError) setMediaError(null);
            }}
            selectedBrandKit={current.selectedBrandKit} onRemoveBrandKit={() => updateCurrent({ selectedBrandKit: null })}
            onOpenBrandKitSelector={() => setIsBrandKitPopoverOpen(true)}
            onOpenIngredientsPopover={() => setIsIngredientsPopoverOpen(true)}
            onSubmit={handleSubmit}
            placeholder={activeMode === 'llm' ? 'Ask the LLM anything or generate prompts, copy and code...' : 'Describe what you want to create or @ to mention characters, voices, brand kits...'}
          />
          <BrandKitSelectorPopover
            isOpen={isBrandKitPopoverOpen} onOpenChange={setIsBrandKitPopoverOpen}
            brandKits={brandKits} selectedBrandKitId={current.selectedBrandKit?.id}
            onSelectBrandKit={(kit) => updateCurrent({ selectedBrandKit: kit })}
            onInspectBrandKit={(kit) => setInspectingKit(kit)}
            onCreateBrandKitClick={() => setIsCreateModalOpen(true)}
          />
          <div className="flex items-center justify-between pt-2.5 mt-2 border-t border-gray-200/60 dark:border-gray-700/60">
            <div className="flex items-center space-x-2 flex-wrap">
              <EngineSelectorPill value={enginePreference} onChange={setEnginePreference} />
              <ParameterRegistry
                mode={activeMode} model={current.model} models={models} onModelChange={(model) => updateCurrent({ model })}
                parameters={current.parameters} onParametersChange={(params) => updateCurrent({ parameters: { ...current.parameters, ...params } })}
                batchCount={current.batchCount} onBatchCountChange={(count) => updateCurrent({ batchCount: count })}
                talkingStyle={current.talkingStyle} onTalkingStyleChange={(style) => updateCurrent({ talkingStyle: style })}
                upscaleScale={current.upscaleScale} onUpscaleScaleChange={(scale) => updateCurrent({ upscaleScale: scale })}
                upscaleQuality={current.upscaleQuality} onUpscaleQualityChange={(quality) => updateCurrent({ upscaleQuality: quality })}
                upscaleFrameRate={current.upscaleFrameRate} onUpscaleFrameRateChange={(fps) => updateCurrent({ upscaleFrameRate: fps })}
                negativePrompt={current.negativePrompt} onNegativePromptChange={(val) => updateCurrent({ negativePrompt: val })}
                steps={current.parameters.steps ?? 25} onStepsChange={(steps) => updateCurrent({ parameters: { ...current.parameters, steps } })}
              />
            </div>
            <div className="flex items-center space-x-2 flex-shrink-0 ml-2">
              {activeMode === 'llm' && isLlmStreaming ? (
                <button
                  type="button" aria-label="Stop generating" onClick={handleStopLlmStreaming}
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-rose-600 hover:bg-rose-700 active:scale-95 text-white shadow-md transition-all"
                >
                  <Square className="w-4 h-4 fill-current" />
                </button>
              ) : (
                <button
                  type="button" aria-label="Submit" onClick={handleSubmit}
                  disabled={
                    (!current.prompt.trim() &&
                      activeMode !== 'upscale' &&
                      !(
                        activeMode === 'lip_sync' &&
                        (current.references.videoRefs?.length || current.references.imageRefs?.length) &&
                        current.references.audioRefs?.length
                      )) ||
                    isSubmittingMedia
                  }
                  className="w-9 h-9 flex items-center justify-center rounded-full bg-black hover:bg-gray-800 dark:bg-white dark:hover:bg-gray-200 dark:text-black active:scale-95 text-white shadow-md transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isSubmittingMedia ? (
                    <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  ) : (
                    <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <BrandKitCreateModal
        isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)}
        onCreateBrandKit={handleCreateBrandKitInternal}
        onSuccess={(createdKit) => {
          setIsCreateModalOpen(false); setInspectingKit(createdKit); updateCurrent({ selectedBrandKit: createdKit });
          onBrandKitCreated?.(createdKit);
        }}
      />
      <BrandKitInspectorModal
        brandKit={inspectingKit} isOpen={Boolean(inspectingKit)} onClose={() => setInspectingKit(null)}
        onSelectBrandKit={(kit) => { updateCurrent({ selectedBrandKit: kit }); setInspectingKit(null); }}
      />
      <CharactersModal
        isOpen={isCharactersModalOpen}
        onClose={() => setIsCharactersModalOpen(false)}
        onSelectCharacterToken={(token) => {
          const separator = current.prompt.trim() ? ' ' : '';
          updateCurrent({ prompt: `${current.prompt}${separator}${token} ` });
        }}
      />
      <AgentInstructionsDrawer
        isOpen={isAgentDrawerOpen}
        onClose={() => setIsAgentDrawerOpen(false)}
        onInstructionsChange={setAgentInstructions}
      />
      <IngredientsPopover
        isOpen={isIngredientsPopoverOpen}
        onClose={() => setIsIngredientsPopoverOpen(false)}
        brandKits={brandKits}
        generations={generations}
        onSelectIngredient={(token, metadata) => {
          const separator = current.prompt.trim() ? ' ' : '';
          const nextPrompt = `${current.prompt}${separator}${token} `;
          if (metadata?.videoId) {
            const vidUrl = (metadata.filePath as string) || `/api/generations/${String(metadata.videoId)}/file`;
            if (activeMode === 'lip_sync') {
              updateCurrent({
                prompt: nextPrompt,
                references: { ...current.references, videoRefs: [vidUrl], imageRefs: [] },
              });
              return;
            }
            if (activeMode === 'video') {
              const prevVids = current.references.videoRefs || [];
              updateCurrent({
                prompt: nextPrompt,
                references: {
                  ...current.references,
                  videoRefs: prevVids.includes(vidUrl) ? prevVids : [...prevVids, vidUrl],
                },
              });
              return;
            }
          }
          if (metadata?.imageId) {
            const imgUrl = (metadata.filePath as string) || `/api/generations/${String(metadata.imageId)}/file`;
            if (activeMode === 'lip_sync') {
              updateCurrent({
                prompt: nextPrompt,
                references: { ...current.references, imageRefs: [imgUrl], videoRefs: [] },
              });
              return;
            }
          }
          updateCurrent({ prompt: nextPrompt });
        }}
      />
    </div>
  );
};
