import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Loader2, XCircle } from 'lucide-react';
import { MediaGallery, type ActiveTaskState } from './components/gallery/MediaGallery';
import { MediaPlayerModal } from './components/gallery/MediaPlayerModal';
import { TopNavBar } from './components/header/TopNavBar';
import { FloatingPromptDock } from './components/dock/FloatingPromptDock';
import { AgentsWorkspaceView } from './components/agents/AgentsWorkspaceView';
import type { AppMode } from './components/header/AppModeSwitch';
import { apiClient, getMediaFileUrl } from './services/apiClient';
import type {
  Generation,
  ModelDefinition,
  BrandKit,
  GenerationSubmitRequest,
  GenerationSubmitResponse,
  TaskStatusEvent,
  CanvasAssetLayer,
} from './types/studio';

export default function App(): React.ReactElement {
  const [appMode, setAppMode] = useState<AppMode>('Studio');
  const [canvasLayers, setCanvasLayers] = useState<CanvasAssetLayer[]>([]);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedGeneration, setSelectedGeneration] = useState<Generation | null>(null);
  const [remixContext, setRemixContext] = useState<Generation | null>(null);
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [models, setModels] = useState<ModelDefinition[]>([]);
  const [brandKits, setBrandKits] = useState<BrandKit[]>([]);
  const [activeTask, setActiveTask] = useState<ActiveTaskState | null>(null);
  const taskUnsubRef = useRef<(() => void) | null>(null);

  const subscribeToTask = useCallback(
    (taskId: string, prompt: string, modelName: string, initialProgress = 5) => {
      if (taskUnsubRef.current) {
        taskUnsubRef.current();
        taskUnsubRef.current = null;
      }

      const initialTask: ActiveTaskState = {
        event: {
          taskId,
          status: 'running',
          progress: initialProgress,
          step: 'Traitement en cours sur le GPU...',
        },
        prompt,
        modelName,
      };
      setActiveTask(initialTask);

      if (apiClient.subscribeTaskStatus) {
        const unsub = apiClient.subscribeTaskStatus(
          taskId,
          (evt: TaskStatusEvent) => {
            setActiveTask((prev) => {
              if (!prev || prev.event.taskId !== taskId) return prev;
              return { ...prev, event: evt };
            });

            if (evt.type === 'segment_completed') {
              if (apiClient.listGenerations) {
                const targetId = activeProjectIdRef.current;
                apiClient.listGenerations(targetId ? { projectId: targetId } : undefined)
                  .then((updated) => {
                    if (activeProjectIdRef.current === targetId) {
                      setGenerations(updated);
                    }
                  })
                  .catch(() => {});
              }
            }

            if (evt.status === 'completed' && evt.type !== 'segment_completed') {
              setTimeout(() => {
                if (apiClient.listGenerations) {
                  const targetId = activeProjectIdRef.current;
                  apiClient.listGenerations(targetId ? { projectId: targetId } : undefined)
                    .then((updated) => {
                      if (activeProjectIdRef.current === targetId) {
                        setGenerations(updated);
                      }
                    })
                    .catch(() => {});
                }
                setActiveTask(null);
              }, 1200);
            } else if (evt.status === 'failed' || evt.status === 'cancelled') {
              setTimeout(() => {
                setActiveTask(null);
              }, 2500);
            }
          },
          (err) => {
            console.warn('Erreur SSE statut tâche:', err);
          }
        );
        taskUnsubRef.current = unsub;
      }
    },
    []
  );

  useEffect(() => {
    if (activeTask || taskUnsubRef.current) return;
    const running =
      generations.find(
        (g) => (g.status === 'running' || g.status === 'pending') && (!g.sequenceIndex || g.sequenceIndex === 1)
      ) || generations.find((g) => g.status === 'running' || g.status === 'pending');

    if (running) {
      subscribeToTask(
        running.sequenceId || running.id,
        running.prompt,
        running.modelName || running.modelId,
        running.progress || 10
      );
    }
  }, [generations, activeTask, subscribeToTask]);

  useEffect(() => {
    return () => {
      if (taskUnsubRef.current) {
        taskUnsubRef.current();
        taskUnsubRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (apiClient.listModels) {
      apiClient.listModels().then(setModels).catch(() => {});
    }
    if (apiClient.listBrandKits) {
      apiClient.listBrandKits().then(setBrandKits).catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      if (window.electron.getAppMode) {
        window.electron.getAppMode().then((mode) => {
          if (mode === 'Studio' || mode === 'Agents') {
            setAppMode(mode);
          }
        }).catch(() => {});
      }

      if (window.electron.onModeChanged) {
        const unsub = window.electron.onModeChanged((mode) => {
          if (mode === 'Studio' || mode === 'Agents') {
            setAppMode(mode);
          }
        });
        return () => {
          unsub();
        };
      }
    }
  }, []);

  const handleRemix = (gen: Generation) => {
    setRemixContext(gen);
    setSelectedGeneration(null);
  };

  const handleUpscale = (gen: Generation) => {
    setSelectedGeneration(null);
    setRemixContext({
      ...gen,
      mediaType: 'upscale',
      references: {
        ...gen.references,
        upscaleSource: gen.filePath || `/api/generations/${gen.id}/file`,
        upscaleSourceType: gen.mediaType === 'video' ? 'video' : 'image',
        upscaleSourceFilename: gen.filePath ? gen.filePath.split('/').pop() : `${gen.id}.mp4`,
      },
      parameters: {
        ...gen.parameters,
        resolution: '4K',
        upscaleScale: '2x',
      },
    });
  };

  const handleLipSync = (gen: Generation) => {
    setSelectedGeneration(null);
    const sourceUrl = gen.filePath || `/api/generations/${gen.id}/file`;
    const isVideoGen =
      gen.mediaType === 'video' ||
      gen.mediaType === 'lip_sync' ||
      Boolean(gen.filePath?.toLowerCase().endsWith('.mp4'));
    setRemixContext({
      ...gen,
      mediaType: 'lip_sync',
      references: {
        ...gen.references,
        videoRefs: isVideoGen ? [sourceUrl] : [],
        imageRefs: isVideoGen ? [] : [sourceUrl],
      },
    });
  };

  const handleFavoriteToggled = (updated: Generation) => {
    setGenerations((prev) => prev.map((g) => (g.id === updated.id ? updated : g)));
    if (selectedGeneration && selectedGeneration.id === updated.id) {
      setSelectedGeneration(updated);
    }
  };

  const activeProjectIdRef = useRef(activeProjectId);
  useEffect(() => { activeProjectIdRef.current = activeProjectId; }, [activeProjectId]);

  const handleCancelActiveTask = async (taskId: string) => {
    try {
      if (apiClient.cancelTask) {
        await apiClient.cancelTask(taskId);
      }
    } catch (err) {
      console.error('Erreur annulation tâche:', err);
    } finally {
      if (taskUnsubRef.current) {
        taskUnsubRef.current();
        taskUnsubRef.current = null;
      }
      setActiveTask(null);
    }
  };

  const handleSubmitGeneration = async (
    req: GenerationSubmitRequest
  ): Promise<GenerationSubmitResponse | void> => {
    if (!apiClient.submitGeneration) return;
    try {
      const res = await apiClient.submitGeneration(req);
      const taskId = res.taskId || res.generationId || '';
      const modelDef = models.find((m) => m.id === req.modelId);
      const modelName = modelDef?.name || req.modelId;

      subscribeToTask(taskId, req.prompt, modelName, 5);
      return res;
    } catch (err) {
      console.error('Erreur soumission génération:', err);
      setActiveTask(null);
    }
  };

  const handleCreateBrandKit = async (data: {
    source: 'blank' | 'website' | 'files'; name: string; overview?: string; url?: string; files?: File[];
  }): Promise<BrandKit> => {
    const created = await apiClient.createBrandKit(data);
    setBrandKits((prev) => [created, ...prev.filter((k) => k.id !== created.id)]);
    return created;
  };

  const handleDeleteGeneration = (deleted: Generation) => {
    setGenerations((prev) => prev.filter((g) => g.id !== deleted.id));
    if (selectedGeneration?.id === deleted.id) {
      setSelectedGeneration(null);
    }
  };

  const handleInjectToCanvas = useCallback((generation: Generation) => {
    const is3D =
      generation.mediaType === '3d' ||
      generation.mediaType === 'mesh_3d' ||
      Boolean(
        generation.parameters?.characterAnchors &&
          Object.keys(generation.parameters.characterAnchors).length > 0
      );
    const isVideo = generation.mediaType === 'video' || generation.mediaType === 'lip_sync';
    const isAudio = generation.mediaType === 'audio';
    const layerType: 'mesh_3d' | 'video' | 'image' | 'audio' = is3D
      ? 'mesh_3d'
      : isVideo
      ? 'video'
      : isAudio
      ? 'audio'
      : 'image';

    const newLayer: CanvasAssetLayer = {
      id: `layer-${generation.id}`,
      name: generation.prompt ? generation.prompt.slice(0, 32) : `Média ${generation.mediaType}`,
      type: layerType,
      taskId: generation.id,
      fileUrl: getMediaFileUrl(generation),
      status: 'ready',
    };

    setCanvasLayers((prev) => {
      if (prev.some((l) => l.id === newLayer.id)) return prev;
      return [...prev, newLayer];
    });

    setAppMode('Agents');

    window.dispatchEvent(
      new CustomEvent('omniforge:inject-canvas-asset', { detail: newLayer })
    );
    window.electron?.switchMode('Agents').catch(() => {});
  }, []);

  return (
    <div
      className={`min-h-screen bg-studio-canvas text-gray-900 flex flex-col font-sans selection:bg-indigo-500 selection:text-white ${
        appMode === 'Studio' ? 'pb-36' : 'overflow-hidden'
      }`}
      data-remix-active={Boolean(remixContext)}
      data-app-mode={appMode}
    >
      {/* Barre supérieure unifiée */}
      <TopNavBar
        favoritesOnly={favoritesOnly}
        onToggleFavorites={() => setFavoritesOnly((prev) => !prev)}
        activeProjectId={activeProjectId}
        onSelectProject={setActiveProjectId}
        appMode={appMode}
        onAppModeChange={setAppMode}
      />

      {appMode === 'Agents' ? (
        <AgentsWorkspaceView
          injectedLayers={canvasLayers}
          onLayerInjected={(layer) => {
            setCanvasLayers((prev) => (prev.some((l) => l.id === layer.id) ? prev : [...prev, layer]));
          }}
          onSubmitGeneration={handleSubmitGeneration}
          models={models}
        />
      ) : (
        <>
          {/* Bannière de progression globale temps réel pour tout traitement */}
          {activeTask && (
            <aside
              aria-label="Traitement en cours"
              data-testid="global-progress-banner"
              className="sticky top-3 z-40 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 mb-2 animate-in fade-in slide-in-from-top-2 duration-200"
            >
              <div className="bg-white/95 dark:bg-gray-900/95 backdrop-blur-md rounded-2xl border border-indigo-200 dark:border-indigo-800 shadow-xl p-4 flex flex-col space-y-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-8 h-8 rounded-full bg-indigo-50 dark:bg-indigo-950/60 flex items-center justify-center flex-shrink-0">
                      <Loader2 className="w-4 h-4 text-indigo-600 dark:text-indigo-400 animate-spin" />
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-bold text-gray-900 dark:text-white uppercase tracking-wider">
                          Traitement en cours
                        </span>
                        <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                          {activeTask.modelName}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-xl" title={activeTask.prompt}>
                        {activeTask.prompt}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center space-x-3.5">
                    <span className="text-base font-mono font-extrabold text-indigo-600 dark:text-indigo-400">
                      {Math.min(100, Math.max(0, activeTask.event.progress || 0))}%
                    </span>
                    <button
                      type="button"
                      onClick={() => handleCancelActiveTask(activeTask.event.taskId)}
                      aria-label="Annuler le traitement en cours"
                      className="px-3 py-1.5 text-xs font-semibold text-rose-600 hover:text-rose-700 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-400 rounded-lg border border-rose-200 dark:border-rose-800 transition-colors flex items-center space-x-1 shadow-sm"
                    >
                      <XCircle className="w-3.5 h-3.5" />
                      <span>Annuler</span>
                    </button>
                  </div>
                </div>

                {/* Barre de progression avec shimmer animé */}
                <div className="w-full bg-gray-100 dark:bg-gray-800 rounded-full h-2.5 overflow-hidden relative">
                  <div
                    className="bg-gradient-to-r from-indigo-500 via-indigo-600 to-purple-600 h-2.5 rounded-full transition-all duration-300 relative overflow-hidden"
                    style={{ width: `${Math.min(100, Math.max(0, activeTask.event.progress || 0))}%` }}
                  >
                    <div className="absolute inset-0 bg-white/30 animate-pulse" />
                  </div>
                </div>

                <div className="flex items-center justify-between text-[11px] text-gray-400 font-mono">
                  <span className="truncate max-w-md">{activeTask.event.step || 'Calcul en cours sur GPU...'}</span>
                  <span>Tâche : {activeTask.event.taskId}</span>
                </div>
              </div>
            </aside>
          )}

          {/* Contenu principal : Galerie & Recherche */}
          <main className="flex-1 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 py-4">
            <h1 className="sr-only">Colab AI Studio</h1>
            <MediaGallery
              favoritesOnly={favoritesOnly}
              activeProjectId={activeProjectId}
              onSelectGeneration={setSelectedGeneration}
              generations={generations}
              onGenerationsChange={setGenerations}
              onFavoriteToggled={handleFavoriteToggled}
              onDeleteGeneration={handleDeleteGeneration}
              onInjectToCanvas={handleInjectToCanvas}
              activeTask={activeTask}
              onTaskCancelled={handleCancelActiveTask}
            />
          </main>

          {/* Floating Prompt Dock modulaire adaptatif */}
          <FloatingPromptDock
            models={models}
            brandKits={brandKits}
            generations={generations}
            activeProjectId={activeProjectId}
            remixContext={remixContext}
            onClearRemix={() => setRemixContext(null)}
            onSubmitGeneration={handleSubmitGeneration}
            onCreateBrandKit={handleCreateBrandKit}
          />
        </>
      )}

      {/* Modale d'inspection grand format */}
      <MediaPlayerModal
        generation={selectedGeneration}
        isOpen={Boolean(selectedGeneration)}
        onClose={() => setSelectedGeneration(null)}
        onRemix={handleRemix}
        onUpscale={handleUpscale}
        onLipSync={handleLipSync}
        onFavoriteToggled={handleFavoriteToggled}
        onDelete={handleDeleteGeneration}
        onInjectToCanvas={handleInjectToCanvas}
      />
    </div>
  );
}
