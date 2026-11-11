import { useState, useRef, useEffect, type FC, type FormEvent } from 'react';
import {
  Layers,
  Move,
  ZoomIn,
  ZoomOut,
  Grid,
  Play,
  Pause,
  Sliders,
  Send,
  Square,
  Database,
  Cpu,
  Activity,
  Radio,
  Box,
  Sparkles,
  Film,
  Image as ImageIcon,
  Volume2,
  Zap,
} from 'lucide-react';
import type {
  CanvasAssetLayer,
  GenerationParameters,
  GenerationSubmitRequest,
  GenerationSubmitResponse,
  ModelDefinition,
  StorySegmentResponse,
  TaskStatusEvent,
} from '../../types/studio';
import { detectGraphicsCapability } from '../../services/graphicsCapability';
import { Canvas2DFallback } from '../canvas/Canvas2DFallback';
import { StoryboardTimeline } from '../canvas/StoryboardTimeline';
import { apiClient } from '../../services/apiClient';
import { buildChainedPlanOptions, pickSequenceSeed } from '../../services/storyChaining';

interface AgentMessage {
  id: string;
  sender: 'user' | 'leader' | 'planner' | 'coder';
  content: string;
  timestamp: string;
  stage?: string;
}

export interface MediaIntent {
  type: 'image' | 'video' | 'mesh_3d';
  modelId: string;
  modelName: string;
  prompt: string;
  durationSec?: number;
  characterIds?: string[];
  seed?: number;
  startFrameRef?: string;
}

function detectMediaIntent(text: string): MediaIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('/image ') || trimmed.startsWith('/img ')) {
    const prompt = trimmed.replace(/^\/(?:image|img)\s+/i, '').trim();
    return { type: 'image', modelId: 'noctq-v4', modelName: 'NoctQ V4 Cinema', prompt };
  }
  if (trimmed.startsWith('/video ') || trimmed.startsWith('/vid ')) {
    const prompt = trimmed.replace(/^\/(?:video|vid)\s+/i, '').trim();
    return { type: 'video', modelId: 'minimax-h3', modelName: 'MiniMax H3 Video', prompt };
  }
  if (trimmed.startsWith('/3d ') || trimmed.startsWith('/mesh ')) {
    const prompt = trimmed.replace(/^\/(?:3d|mesh)\s+/i, '').trim();
    return { type: 'mesh_3d', modelId: 'tripo-3d-local', modelName: 'Tripo 3D Local', prompt };
  }

  const lower = trimmed.toLowerCase();

  // Verbes d'action obligatoires pour éviter les faux positifs conversationnels
  const hasActionVerb = /\b(g[ée]n[èe]re|g[ée]n[ée]rer|cr[ée]e|cr[ée]er|produis|produire|fais|faire|anime|animer|dessine|dessiner|lance|lancer|tourne|tourner|make|generate|create|render)\b/i.test(lower);
  if (!hasActionVerb) {
    return null;
  }

  const mentionsVideo = /\b(vid[ée]os?|clips?|films?|animations?|court-m[ée]trages?|travellings?)\b/i.test(lower);
  const mentionsImage = /\b(images?|photos?|illustrations?|visuels?|dessins?|concept-?arts?|tableaux?|portraits?|wallpapers?|fonds?\s+d'[ée]cran)\b/i.test(lower);
  const mentions3D = /\b(maillages?|mesh(es)?|mod[èe]les?\s+3d|objets?\s+3d)\b/i.test(lower);

  if (mentionsVideo && !mentionsImage) {
    return {
      type: 'video',
      modelId: 'minimax-h3',
      modelName: 'MiniMax H3 Video',
      prompt: trimmed,
    };
  }

  if (mentionsImage && !mentionsVideo) {
    return {
      type: 'image',
      modelId: 'noctq-v4',
      modelName: 'NoctQ V4 Cinema',
      prompt: trimmed,
    };
  }

  if (mentionsVideo && mentionsImage) {
    const imgIndex = lower.search(/\b(images?|photos?|illustrations?)\b/i);
    const vidIndex = lower.search(/\b(vid[ée]os?|clips?)\b/i);
    if (imgIndex !== -1 && (vidIndex === -1 || imgIndex < vidIndex)) {
      return {
        type: 'image',
        modelId: 'noctq-v4',
        modelName: 'NoctQ V4 Cinema',
        prompt: trimmed,
      };
    }
    return {
      type: 'video',
      modelId: 'minimax-h3',
      modelName: 'MiniMax H3 Video',
      prompt: trimmed,
    };
  }

  if (mentions3D) {
    return {
      type: 'mesh_3d',
      modelId: 'tripo-3d-local',
      modelName: 'Tripo 3D Local',
      prompt: trimmed,
    };
  }

  return null;
}

export interface ActiveGpuTask {
  taskId: string;
  prompt: string;
  modelId: string;
  modelName: string;
  type: 'image' | 'video' | 'mesh_3d';
  progress: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  step?: string;
  outputUrl?: string;
  error?: string;
}

export interface AgentsWorkspaceViewProps {
  injectedLayers?: CanvasAssetLayer[];
  onLayerInjected?: (layer: CanvasAssetLayer) => void;
  onSubmitGeneration?: (req: GenerationSubmitRequest) => Promise<GenerationSubmitResponse | void>;
  models?: ModelDefinition[];
}

export const AgentsWorkspaceView: FC<AgentsWorkspaceViewProps> = ({
  injectedLayers,
  onLayerInjected,
  onSubmitGeneration,
  models,
}) => {
  const [activeAgent, setActiveAgent] = useState<'leader' | 'planner' | 'coder'>('leader');
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [chatInput, setChatInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [layers, setLayers] = useState<CanvasAssetLayer[]>(() => injectedLayers || []);
  const [gpuTasks, setGpuTasks] = useState<ActiveGpuTask[]>([]);
  const [isGenerating3D, setIsGenerating3D] = useState(false);
  const [graphicsMode, setGraphicsMode] = useState<'webgpu' | 'canvas2d'>('webgpu');
  const [gpuInfo, setGpuInfo] = useState<string>('Détection GPU...');
  const [storySegments, setStorySegments] = useState<StorySegmentResponse[]>([]);
  const [storyOverview, setStoryOverview] = useState<string>('');
  const [storyTotalDuration, setStoryTotalDuration] = useState<number>(0);
  const [isBreakingDownStory, setIsBreakingDownStory] = useState(false);
  const [isGeneratingAllPlans, setIsGeneratingAllPlans] = useState(false);
  const [storyInput, setStoryInput] = useState('');
  const [hostSystem, setHostSystem] = useState<{
    cpu: string;
    ram: string;
    gpu: string;
    gpuTooltip: string;
  }>({
    cpu: typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? `CPU (${navigator.hardwareConcurrency}T)` : 'CPU...',
    ram: 'RAM...',
    gpu: 'GPU...',
    gpuTooltip: 'Détection GPU en cours...',
  });
  const abortControllerRef = useRef<AbortController | null>(null);
  const taskSubscriptionsRef = useRef<Map<string, () => void>>(new Map());

  useEffect(() => {
    const subscriptions = taskSubscriptionsRef.current;
    return () => {
      subscriptions.forEach((unsub) => unsub());
      subscriptions.clear();
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    detectGraphicsCapability().then((res) => {
      if (!isMounted) return;
      setGraphicsMode(res.renderer);
      setGpuInfo(
        res.renderer === 'webgpu'
          ? `WebGPU (${res.adapterInfo || 'Hardware'})`
          : `Canvas2D (${res.reason || 'Mode standard'})`
      );
    });

    const updateTelemetry = async () => {
      try {
        const health = await apiClient.getHealth();
        if (!isMounted) return;
        const host = health?.host;
        const threads = host?.threads || (typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null) || 32;
        const cpuName = host?.cpu || 'Core i9';
        const ramName = host?.ram || '64 Go RAM';
        const gpuObj = host?.gpu;
        const gpuLabel = gpuObj?.label || (gpuObj?.shortName ? `${gpuObj.shortName} · ${gpuObj.vramFreeGb} Go` : (health?.worker?.gpu || 'NVIDIA RTX 5000 Ada'));
        const gpuTooltip = gpuObj
          ? `${gpuObj.name} · VRAM: ${gpuObj.vramFreeGb} Go libres / ${gpuObj.vramTotalGb} Go (Util: ${gpuObj.utilizationPct ?? 0}% · Temp: ${gpuObj.temperatureC ?? '--'}°C)`
          : `GPU Dédié : ${health?.worker?.gpu || 'NVIDIA RTX 5000 Ada'}`;

        setHostSystem({
          cpu: `${cpuName} (${threads}T)`,
          ram: ramName,
          gpu: gpuLabel,
          gpuTooltip,
        });
      } catch {
        if (!isMounted) return;
        const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 32;
        setHostSystem((prev) => ({
          ...prev,
          cpu: `CPU (${threads}T)`,
          ram: '64 Go RAM',
          gpu: prev.gpu === 'GPU...' ? 'RTX 5000 Ada · 15.0 Go' : prev.gpu,
          gpuTooltip: 'GPU Dédié NVIDIA RTX 5000 Ada Generation (16 Go VRAM)',
        }));
      }
    };

    updateTelemetry();
    const intervalId = setInterval(updateTelemetry, 5000);

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, []);

  const [messages, setMessages] = useState<AgentMessage[]>([
    {
      id: 'msg-1',
      sender: 'leader',
      content: 'Système multi-agents Hilo initialisé. En attente d’instructions de conception ou d’animation.',
      timestamp: '12:00:01',
      stage: 'READY',
    },
    {
      id: 'msg-2',
      sender: 'planner',
      content: 'Prêt à décomposer la composition en calques WebGPU, keyframes et requêtes d’inférence 6 pôles.',
      timestamp: '12:00:02',
      stage: 'PLANNING',
    },
  ]);

  useEffect(() => {
    if (injectedLayers && injectedLayers.length > 0) {
      setLayers((prev) => {
        const existingIds = new Set(prev.map((l) => l.id));
        const toAdd = injectedLayers.filter((l) => !existingIds.has(l.id));
        return toAdd.length > 0 ? [...prev, ...toAdd] : prev;
      });
    }
  }, [injectedLayers]);

  useEffect(() => {
    const handleCustomInjection = (e: Event) => {
      const customEvt = e as CustomEvent<CanvasAssetLayer>;
      if (customEvt.detail) {
        const newLayer = customEvt.detail;
        setLayers((prev) => {
          if (prev.some((l) => l.id === newLayer.id)) return prev;
          return [...prev, newLayer];
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}`,
            sender: 'leader',
            content: `Média "${newLayer.name}" (${newLayer.type}) injecté avec succès sur le canevas infini WebGPU.`,
            timestamp: new Date().toLocaleTimeString(),
            stage: 'CANVAS_INJECT',
          },
        ]);
        onLayerInjected?.(newLayer);
      }
    };
    window.addEventListener('omniforge:inject-canvas-asset', handleCustomInjection);
    return () => {
      window.removeEventListener('omniforge:inject-canvas-asset', handleCustomInjection);
    };
  }, [onLayerInjected]);

  const handleStopStreaming = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsStreaming(false);
  };

  const executeMediaGeneration = async (intent: MediaIntent): Promise<string | undefined> => {
    let taskId = `task-${Date.now()}`;
    const targetModelDef = models?.find((m) => m.id === intent.modelId);
    const modelName = targetModelDef?.name || intent.modelName;

    const genParams: Partial<GenerationParameters> = {
      seed: intent.seed ?? Math.floor(Math.random() * 1000000),
      aspectRatio: '16:9',
      resolution: '720p',
      duration: intent.durationSec ? `${intent.durationSec}s` : '5s',
    };

    const genRefs = intent.startFrameRef
      ? ({ startFrame: intent.startFrameRef } as GenerationSubmitRequest['references'])
      : undefined;

    try {
      if (onSubmitGeneration) {
        const res = await onSubmitGeneration({
          modelId: intent.modelId,
          prompt: intent.prompt,
          type: intent.type === 'mesh_3d' ? '3d' : intent.type,
          parameters: genParams,
          references: genRefs,
          tags: intent.characterIds,
        });
        if (res?.taskId || res?.generationId) {
          taskId = res.taskId || res.generationId || taskId;
        }
      } else {
        const res = await apiClient.submitGeneration({
          modelId: intent.modelId,
          prompt: intent.prompt,
          type: intent.type === 'mesh_3d' ? '3d' : intent.type,
          parameters: genParams,
          references: genRefs,
          tags: intent.characterIds,
        });
        taskId = res.taskId || res.generationId || taskId;
      }

      const newTask: ActiveGpuTask = {
        taskId,
        prompt: intent.prompt,
        modelId: intent.modelId,
        modelName,
        type: intent.type,
        progress: 0,
        status: 'pending',
        step: 'Initialisation inférence sur RTX 5000 Ada...',
      };

      setGpuTasks((prev) => [...prev, newTask]);

      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          sender: 'leader',
          content: `Inférence GPU lancée avec ${modelName} pour "${intent.prompt}".`,
          timestamp: new Date().toLocaleTimeString(),
          stage: 'INFERENCE',
        },
      ]);

      const unsub = apiClient.subscribeTaskStatus(
        taskId,
        (event: TaskStatusEvent) => {
          setGpuTasks((prev) =>
            prev.map((t) =>
              t.taskId === event.taskId
                ? {
                    ...t,
                    status: event.status,
                    progress: event.progress,
                    step: event.step,
                    outputUrl: event.outputUrl,
                    thumbnailUrl: event.thumbnailUrl,
                    error: event.error,
                  }
                : t
            )
          );

          // Synchroniser le statut dans StoryboardTimeline si ce taskId correspond à un plan de séquence
          setStorySegments((prev) =>
            prev.map((s) =>
              s.taskId === event.taskId
                ? {
                    ...s,
                    status:
                      event.status === 'completed'
                        ? 'completed'
                        : event.status === 'failed' || event.status === 'cancelled'
                        ? 'failed'
                        : 'running',
                    outputUrl: event.outputUrl || s.outputUrl,
                  }
                : s
            )
          );

          if (event.status === 'completed') {
            const newLayer: CanvasAssetLayer = {
              id: `layer-${event.taskId}`,
              name: `${intent.type.toUpperCase()}: ${intent.prompt.slice(0, 24)}`,
              type: intent.type,
              taskId: event.taskId,
              status: 'ready',
              fileUrl:
                event.outputUrl ||
                (event.generation?.filePath ? `/outputs/${event.generation.filePath}` : undefined),
              thumbnailUrl:
                event.thumbnailUrl ||
                (event.generation?.thumbnailPath ? `/outputs/${event.generation.thumbnailPath}` : undefined),
            };

            setLayers((prev) => {
              if (prev.some((l) => l.taskId === event.taskId)) return prev;
              return [...prev, newLayer];
            });
            onLayerInjected?.(newLayer);

            setMessages((prev) => [
              ...prev,
              {
                id: `msg-${Date.now()}`,
                sender: 'leader',
                content: `✅ Calque "${newLayer.name}" généré et calqué sur le canevas infini WebGPU.`,
                timestamp: new Date().toLocaleTimeString(),
                stage: 'CANVAS_READY',
              },
            ]);
            unsub();
            taskSubscriptionsRef.current.delete(taskId);
          } else if (event.status === 'failed' || event.status === 'cancelled') {
            unsub();
            taskSubscriptionsRef.current.delete(taskId);
          }
        },
        (err) => {
          console.error('Erreur souscription tâche GPU:', err);
          setGpuTasks((prev) =>
            prev.map((t) =>
              t.taskId === taskId
                ? {
                    ...t,
                    status: 'failed',
                    error: 'Erreur de flux SSE ou déconnexion',
                    step: 'Échec de connexion au flux GPU',
                  }
                : t
            )
          );
          unsub();
          taskSubscriptionsRef.current.delete(taskId);
        }
      );

      taskSubscriptionsRef.current.set(taskId, unsub);
      return taskId;
    } catch (err) {
      console.error('Échec déclenchement inférence GPU:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          sender: 'leader',
          content: `Erreur lors du lancement de l'inférence avec ${modelName}.`,
          timestamp: new Date().toLocaleTimeString(),
          stage: 'ERROR',
        },
      ]);
    }
  };

  const handleSendMessage = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = chatInput.trim();
    if (!trimmed || isStreaming) return;

    const userMsg: AgentMessage = {
      id: `msg-${Date.now()}`,
      sender: 'user',
      content: trimmed,
      timestamp: new Date().toLocaleTimeString(),
    };

    const targetAgent = activeAgent;
    setMessages((prev) => [...prev, userMsg]);
    setChatInput('');

    if (trimmed.startsWith('/story ') || trimmed.startsWith('/script ')) {
      const storyPrompt = trimmed.replace(/^\/(?:story|script)\s+/i, '').trim();
      void handleBreakdownStory(storyPrompt);
      return;
    }

    const mediaIntent = detectMediaIntent(trimmed);
    if (mediaIntent) {
      void executeMediaGeneration(mediaIntent);
      return;
    }

    setIsStreaming(true);

    const agentMsgId = `msg-${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        id: agentMsgId,
        sender: targetAgent,
        content: '',
        timestamp: new Date().toLocaleTimeString(),
        stage: 'STREAMING',
      },
    ]);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: 'qwen-2.5-coder-32b',
          messages: [
            {
              role: 'system',
              content: `Vous êtes l'agent Hilo ${targetAgent}. Vous pilotez le canevas infini WebGPU et l'orchestration des plans.`,
            },
            { role: 'user', content: userMsg.content },
          ],
          stream: true,
        }),
      });

      if (!res.ok) {
        throw new Error(`Erreur proxy LLM: ${res.status}`);
      }

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let reading = true;

        while (reading) {
          const { done, value } = await reader.read();
          if (done) {
            reading = false;
            break;
          }

          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split('\n');

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine.startsWith('data: ')) {
              const dataStr = trimmedLine.slice(6);
              if (dataStr === '[DONE]') {
                break;
              }
              try {
                const parsed = JSON.parse(dataStr);
                const delta = parsed.choices?.[0]?.delta?.content || '';
                if (delta) {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === agentMsgId ? { ...m, content: m.content + delta } : m
                    )
                  );
                }
              } catch {
                // Ignore partial JSON chunks in SSE stream
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId ? { ...m, content: m.content + ' [Génération interrompue]' } : m
          )
        );
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === agentMsgId
              ? { ...m, content: 'Erreur lors de la communication avec l’agent local.' }
              : m
          )
        );
      }
    } finally {
      setIsStreaming(false);
      abortControllerRef.current = null;
    }
  };

  const handleGenerate3DMesh = async () => {
    setIsGenerating3D(true);
    try {
      const res = await fetch('/api/generate/media', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: '3d',
          prompt: '3D mesh layer generated from agents canvas',
          capabilities: { acceptedInputTypes: ['prompt'] },
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const newLayer: CanvasAssetLayer = {
          id: `mesh-${Date.now()}`,
          name: `Calque 3D #${layers.filter((l) => l.type === 'mesh_3d').length + 1}`,
          type: 'mesh_3d',
          taskId: data.taskId || `task-mesh-${Date.now()}`,
          status: 'ready',
        };
        setLayers((prev) => [...prev, newLayer]);
        onLayerInjected?.(newLayer);
      }
    } catch (err) {
      console.error('Failed to generate 3D mesh:', err);
    } finally {
      setIsGenerating3D(false);
    }
  };

  const handleBreakdownStory = async (promptOverride?: string) => {
    const textToBreak = (promptOverride || storyInput).trim();
    if (!textToBreak) return;
    setIsBreakingDownStory(true);
    try {
      const res = await apiClient.breakdownStory({ prompt: textToBreak, maxSegmentSec: 5.0 });
      setStorySegments(res.segments);
      setStoryOverview(res.sceneOverview);
      setStoryTotalDuration(res.totalDurationSec);
      setStoryInput('');

      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          sender: 'planner',
          content: `🎬 Story Director : Découpage terminé en ${res.numSegments} plan(s) (${res.totalDurationSec}s). Ancres de personnages synchronisées.`,
          timestamp: new Date().toLocaleTimeString(),
          stage: 'STORY_BREAKDOWN',
        },
      ]);
    } catch (err) {
      console.error('Erreur découpage story:', err);
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}`,
          sender: 'planner',
          content: '❌ Échec du découpage narratif : impossible de contacter le Story Director ou délai dépassé.',
          timestamp: new Date().toLocaleTimeString(),
          stage: 'ERROR',
        },
      ]);
    } finally {
      setIsBreakingDownStory(false);
    }
  };

  const sequenceSeedRef = useRef<number>(pickSequenceSeed());

  const handleGeneratePlan = async (
    segment: StorySegmentResponse,
    prevTaskId?: string
  ): Promise<string | undefined> => {
    // Génération d'un plan isolé : on chaîne sur le plan précédent s'il est déjà terminé
    const prevSegment = storySegments.find((s) => s.index === segment.index - 1);
    const prevDone = prevSegment?.status === 'completed' && prevSegment.taskId ? prevSegment : undefined;
    const chain = buildChainedPlanOptions(segment, {
      seed: sequenceSeedRef.current,
      prevTaskId: prevTaskId ?? prevDone?.taskId,
      prevCharacterIds: prevSegment?.characterIds,
    });
    setStorySegments((prev) =>
      prev.map((s) => (s.index === segment.index ? { ...s, status: 'running' } : s))
    );
    try {
      const taskId = await executeMediaGeneration({
        type: 'video',
        modelId: 'minimax-h3',
        modelName: 'MiniMax H3 Video',
        prompt: segment.compiledPrompt,
        durationSec: segment.durationSec,
        characterIds: segment.characterIds,
        seed: chain.seed,
        startFrameRef: chain.startFrameRef,
      });
      if (taskId) {
        setStorySegments((prev) =>
          prev.map((s) => (s.index === segment.index ? { ...s, taskId, status: 'running' } : s))
        );
      }
      return taskId;
    } catch (err) {
      setStorySegments((prev) =>
        prev.map((s) => (s.index === segment.index ? { ...s, status: 'failed' } : s))
      );
      throw err;
    }
  };

  const waitForTaskCompletion = (taskId: string, timeoutMs = 180000): Promise<TaskStatusEvent> => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsub();
        reject(new Error(`Délai d'attente dépassé pour la tâche ${taskId}`));
      }, timeoutMs);

      const unsub = apiClient.subscribeTaskStatus(
        taskId,
        (evt) => {
          if (evt.status === 'completed' || evt.status === 'failed' || evt.status === 'cancelled') {
            clearTimeout(timer);
            unsub();
            if (evt.status === 'completed') resolve(evt);
            else reject(new Error(evt.error || `Tâche terminée avec statut ${evt.status}`));
          }
        },
        (err) => {
          clearTimeout(timer);
          unsub();
          reject(err);
        }
      );
    });
  };

  const handleGenerateAllPlans = async () => {
    if (isGeneratingAllPlans || storySegments.length === 0) return;
    setIsGeneratingAllPlans(true);
    sequenceSeedRef.current = pickSequenceSeed();
    let prevTaskId: string | undefined;
    try {
      for (const segment of storySegments) {
        const taskId = await handleGeneratePlan(segment, prevTaskId);
        prevTaskId = undefined;
        if (taskId) {
          try {
            await waitForTaskCompletion(taskId);
            prevTaskId = taskId;
          } catch (planErr) {
            console.warn('Plan terminé avec avertissement/erreur:', segment.index, planErr);
          }
        }
      }
    } finally {
      setIsGeneratingAllPlans(false);
    }
  };

  return (
    <div
      data-testid="agents-workspace-view"
      className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-studio-canvas text-gray-900 dark:text-gray-100 overflow-hidden"
    >
      {/* Barre supérieure d'état d'orchestration Hilo */}
      <div className="h-10 px-4 border-b border-studio-border bg-white dark:bg-gray-900 flex items-center justify-between text-xs">
        <div className="flex items-center space-x-3">
          <span className="flex items-center space-x-1.5 font-bold tracking-wide text-indigo-600 dark:text-indigo-400">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>Hilo Swarm Dialogue</span>
          </span>
          <span className="text-gray-300 dark:text-gray-700">|</span>
          <span className="text-gray-500 font-mono text-[11px]">
            FastAPI: :8000 · NestJS Gateway: :51491 · SQLite WAL
          </span>
        </div>

        <div className="flex items-center space-x-3">
          {/* Badge statut graphique et commutateur WebGPU / Canvas2D */}
          <div className="flex items-center space-x-1.5">
            <div
              data-testid="graphics-mode-badge"
              className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[10px] font-mono border ${
                graphicsMode === 'webgpu'
                  ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                  : 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800'
              }`}
              title={gpuInfo}
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  graphicsMode === 'webgpu' ? 'bg-emerald-500' : 'bg-amber-500'
                } animate-pulse`}
              />
              <span>{graphicsMode === 'webgpu' ? 'WebGPU 60fps' : 'Canvas2D Fallback'}</span>
            </div>

            <button
              type="button"
              data-testid="toggle-renderer-btn"
              onClick={() => setGraphicsMode((m) => (m === 'webgpu' ? 'canvas2d' : 'webgpu'))}
              title="Basculer manuellement le moteur de rendu graphique"
              className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-[10px] font-mono text-gray-600 dark:text-gray-300 transition-colors border border-studio-border"
            >
              {graphicsMode === 'webgpu' ? 'Forcer 2D' : 'Mode GPU'}
            </button>
          </div>

          <div
            data-testid="telemetry-cpu-chip"
            className="flex items-center space-x-1 text-emerald-600 dark:text-emerald-400 text-[11px]"
            title="Télémétrie CPU dynamique sonde FastAPI"
          >
            <Cpu className="w-3.5 h-3.5" />
            <span>{hostSystem.cpu}</span>
          </div>
          <div
            data-testid="telemetry-ram-chip"
            className="flex items-center space-x-1 text-indigo-600 dark:text-indigo-400 text-[11px]"
            title="Mémoire vive totale hôte détectée"
          >
            <Database className="w-3.5 h-3.5" />
            <span>{hostSystem.ram}</span>
          </div>
          <div
            data-testid="telemetry-gpu-chip"
            className="flex items-center space-x-1 text-amber-600 dark:text-amber-400 text-[11px]"
            title={hostSystem.gpuTooltip}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>{hostSystem.gpu}</span>
          </div>
        </div>
      </div>

      {/* Corps principal : Volet conversationnel + Canevas infini */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* Volet conversationnel multi-agents */}
        <div className="w-96 flex-shrink-0 border-r border-studio-border bg-white dark:bg-gray-900 flex flex-col self-stretch">
          {/* Sélecteur d'agent actif */}
          <div className="p-3 border-b border-studio-border bg-gray-50 dark:bg-gray-800/50">
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-2">
              Agents Hilo Autonomes
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {(['leader', 'planner', 'coder'] as const).map((agent) => (
                <button
                  key={agent}
                  type="button"
                  onClick={() => setActiveAgent(agent)}
                  className={`px-2 py-1.5 rounded-lg text-xs font-medium capitalize transition-colors ${
                    activeAgent === agent
                      ? 'bg-indigo-600 text-white shadow-xs'
                      : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-studio-border'
                  }`}
                >
                  {agent}
                </button>
              ))}
            </div>
            <div className="mt-2 text-[11px] text-gray-500 flex items-center justify-between">
              <span>Rôle actif :</span>
              <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                {activeAgent} active
              </span>
            </div>
          </div>

          {/* Cartes d'inférence GPU actives */}
          {gpuTasks.length > 0 && (
            <div className="p-3 border-b border-studio-border bg-indigo-50/40 dark:bg-indigo-950/20 space-y-2 max-h-48 overflow-y-auto">
              <div className="text-[10px] font-bold uppercase tracking-wider text-indigo-600 dark:text-indigo-400 flex items-center justify-between">
                <span>Inférences GPU actives</span>
                <span className="font-mono">
                  {gpuTasks.filter((t) => t.status === 'running' || t.status === 'pending').length} en cours
                </span>
              </div>
              {gpuTasks.map((task) => (
                <div
                  key={task.taskId}
                  data-testid={`gpu-task-card-${task.taskId}`}
                  className="p-2.5 rounded-lg bg-white dark:bg-gray-800 border border-indigo-200 dark:border-indigo-800 shadow-xs space-y-1.5 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-indigo-600 dark:text-indigo-400 flex items-center space-x-1">
                      <Zap className="w-3 h-3 text-amber-500 animate-pulse" />
                      <span>{task.modelName}</span>
                    </span>
                    <span className="font-mono text-[10px] px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300">
                      {task.status.toUpperCase()} ({task.progress}%)
                    </span>
                  </div>
                  <p className="text-[11px] text-gray-600 dark:text-gray-300 truncate" title={task.prompt}>
                    {task.prompt}
                  </p>
                  <div className="w-full bg-gray-100 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                    <div
                      className="bg-indigo-600 h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }}
                    />
                  </div>
                  {task.step && (
                    <div className="text-[10px] font-mono text-gray-400 truncate">
                      {task.step}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Flux de messages */}
          <div className="flex-1 p-3 overflow-y-auto space-y-3">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex flex-col ${
                  msg.sender === 'user' ? 'items-end' : 'items-start'
                }`}
              >
                <div className="flex items-center space-x-1.5 mb-1 text-[10px] text-gray-400">
                  <span className="font-semibold uppercase tracking-wider">{msg.sender}</span>
                  <span>·</span>
                  <span className="font-mono">{msg.timestamp}</span>
                  {msg.stage && (
                    <span className="px-1.5 py-0.2 rounded bg-indigo-50 dark:bg-indigo-950 text-indigo-600 dark:text-indigo-400 font-mono text-[9px]">
                      {msg.stage}
                    </span>
                  )}
                </div>
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-xs leading-relaxed ${
                    msg.sender === 'user'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border border-studio-border'
                  }`}
                >
                  {msg.content || (
                    <span className="inline-flex items-center space-x-1 text-gray-400 italic">
                      <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                      <span>Génération de la réponse...</span>
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>

          {/* Saisie de message et commande LLM streaming */}
          <form
            onSubmit={handleSendMessage}
            className="p-3 border-t border-studio-border bg-gray-50 dark:bg-gray-800/30 flex items-center space-x-2"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={`Demander à ${activeAgent}...`}
              disabled={isStreaming}
              className="flex-1 px-3 py-1.5 text-xs rounded-lg bg-white dark:bg-gray-900 border border-studio-border focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:opacity-50"
            />
            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopStreaming}
                aria-label="Arrêter la réponse"
                className="p-1.5 rounded-lg bg-rose-600 text-white hover:bg-rose-700 transition-colors shadow-xs"
              >
                <Square className="w-4 h-4 fill-white" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={!chatInput.trim()}
                aria-label="Envoyer instruction agent"
                className="p-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40 transition-colors shadow-xs"
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </form>
        </div>

        {/* Espace central : Canevas infini WebGPU */}
        <div className="flex-1 flex flex-col bg-studio-canvas relative overflow-hidden">
          {/* Barre d'outils du canevas */}
          <div className="h-10 px-4 border-b border-studio-border bg-white/70 dark:bg-gray-900/70 backdrop-blur-xs flex items-center justify-between z-10">
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 p-0.5 rounded-lg">
                <button
                  type="button"
                  title="Déplacer"
                  className="p-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                >
                  <Move className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title="Calques"
                  className="p-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                >
                  <Layers className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  title="Grille"
                  className="p-1.5 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 rounded"
                >
                  <Grid className="w-4 h-4" />
                </button>
              </div>

              {/* Actions de génération rapide sur le GPU local */}
              <button
                type="button"
                data-testid="quick-generate-image-btn"
                onClick={() =>
                  executeMediaGeneration({
                    type: 'image',
                    modelId: 'noctq-v4',
                    modelName: 'NoctQ V4 Cinema',
                    prompt: 'Composition cinématique haute fidélité NoctQ V4',
                  })
                }
                title="Générer une image cinématique locale avec NoctQ V4"
                className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900 transition-colors shadow-xs"
              >
                <ImageIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                <span>+ Image NoctQ V4</span>
              </button>

              <button
                type="button"
                data-testid="quick-generate-video-btn"
                onClick={() =>
                  executeMediaGeneration({
                    type: 'video',
                    modelId: 'minimax-h3',
                    modelName: 'MiniMax H3 Video',
                    prompt: 'Séquence vidéo cinématique 1080p MiniMax H3',
                  })
                }
                title="Générer une vidéo cinématique locale avec MiniMax H3"
                className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-purple-50 dark:bg-purple-950/60 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900 transition-colors shadow-xs"
              >
                <Film className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />
                <span>+ Vidéo MiniMax H3</span>
              </button>

              {/* Action Passerelle 6 Pôles : Génération 3D */}
              <button
                type="button"
                onClick={handleGenerate3DMesh}
                disabled={isGenerating3D}
                aria-label="Injecter maillage 3D"
                className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors shadow-xs"
              >
                <Box className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                <span>{isGenerating3D ? 'Génération 3D...' : 'Ajouter Calque 3D'}</span>
              </button>

              {/* Barre de découpage Story Director */}
              <div className="flex items-center space-x-1.5 pl-2 border-l border-studio-border">
                <input
                  type="text"
                  value={storyInput}
                  onChange={(e) => setStoryInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void handleBreakdownStory();
                    }
                  }}
                  placeholder="Scénario narratif (@Astrid)..."
                  className="w-48 px-2 py-1 text-xs rounded-lg bg-gray-100 dark:bg-gray-800 border border-studio-border text-gray-800 dark:text-gray-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <button
                  type="button"
                  data-testid="story-director-breakdown-btn"
                  onClick={() => void handleBreakdownStory()}
                  disabled={isBreakingDownStory || !storyInput.trim()}
                  title="Découper la scène avec le Story Director"
                  className="flex items-center space-x-1.5 px-2.5 py-1 text-xs font-medium rounded-lg bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800 hover:bg-indigo-100 dark:hover:bg-indigo-900 transition-colors shadow-xs disabled:opacity-40"
                >
                  <Film className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                  <span>{isBreakingDownStory ? 'Découpage...' : 'Story Director'}</span>
                </button>
              </div>
            </div>

            <div className="flex items-center space-x-2 text-xs">
              <button
                type="button"
                onClick={() => setZoomLevel((z) => Math.max(25, z - 10))}
                className="p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="font-mono text-gray-700 dark:text-gray-300 w-12 text-center">
                {zoomLevel}%
              </span>
              <button
                type="button"
                onClick={() => setZoomLevel((z) => Math.min(400, z + 10))}
                className="p-1 text-gray-500 hover:text-gray-900 dark:hover:text-white"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Surface de canevas interactif */}
          <div className="flex-1 relative flex items-center justify-center p-8 overflow-hidden bg-[radial-gradient(#CBD5E1_1px,transparent_1px)] dark:bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:16px_16px]">
            {/* Artboard de travail 16:9 */}
            <div
              className="w-full max-w-3xl aspect-video bg-white dark:bg-gray-900 rounded-xl shadow-lg border border-gray-300 dark:border-gray-700 flex flex-col items-center justify-center text-center p-6 transition-transform relative overflow-hidden"
              style={{ transform: `scale(${zoomLevel / 100})` }}
            >
              {graphicsMode === 'canvas2d' && (
                <Canvas2DFallback
                  layers={layers}
                  zoomLevel={zoomLevel}
                  className="absolute inset-0 z-0 opacity-85 pointer-events-none"
                />
              )}
              <div className="relative z-10 w-full flex flex-col items-center justify-center">
                {layers.length > 0 ? (
                  <div className="space-y-3 w-full">
                    <div className="flex items-center justify-center space-x-2 text-indigo-600 dark:text-indigo-400">
                      <Sparkles className="w-5 h-5 animate-pulse" />
                      <span className="text-sm font-bold">
                        {layers.length} Calque(s) actif(s) sur le canevas
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {layers.map((layer) => (
                        <div
                          key={layer.id}
                          data-testid={layer.type === 'mesh_3d' ? 'canvas-3d-layer' : 'canvas-asset-layer'}
                          className="px-3 py-1.5 rounded-lg bg-indigo-50 dark:bg-indigo-950/70 border border-indigo-200 dark:border-indigo-800 text-xs font-mono text-indigo-700 dark:text-indigo-300 flex items-center space-x-2 shadow-xs"
                        >
                          {layer.type === 'mesh_3d' && <Box className="w-3.5 h-3.5" />}
                          {layer.type === 'video' && <Film className="w-3.5 h-3.5 text-purple-600 dark:text-purple-400" />}
                          {layer.type === 'image' && <ImageIcon className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />}
                          {layer.type === 'audio' && <Volume2 className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />}
                          <span className="truncate max-w-[180px]">{layer.name}</span>
                          <span className="text-[10px] text-gray-400">[{layer.taskId.slice(0, 8)}]</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="w-12 h-12 rounded-2xl bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center mb-3">
                      <Sliders className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
                    </div>
                    <h3 className="text-sm font-bold text-gray-900 dark:text-white mb-1">
                      CanvasAreaV3 — Espace de Composition Mini Design
                    </h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400 max-w-md">
                      Prêt pour le montage des calques WebGPU, la composition d’animations et l’injection directe des maillages 3D et vidéos Omniforge.
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Storyboard Timeline ou Séquenceur temporel en bas du canevas */}
          {storySegments.length > 0 ? (
            <StoryboardTimeline
              segments={storySegments}
              totalDurationSec={storyTotalDuration}
              sceneOverview={storyOverview}
              onGeneratePlan={handleGeneratePlan}
              onGenerateAllPlans={handleGenerateAllPlans}
              isGeneratingAll={isGeneratingAllPlans}
            />
          ) : (
            <div className="h-28 border-t border-studio-border bg-white dark:bg-gray-900 flex flex-col z-10">
              <div className="h-8 px-4 border-b border-studio-border flex items-center justify-between text-xs bg-gray-50/50 dark:bg-gray-800/30">
                <div className="flex items-center space-x-2">
                  <button
                    type="button"
                    onClick={() => setIsPlaying(!isPlaying)}
                    className="p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300"
                  >
                    {isPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  </button>
                  <span className="font-mono text-[11px] text-gray-500">00:00:00 / 00:00:10</span>
                </div>
                <div className="flex items-center space-x-2 text-[11px] text-gray-500 font-mono">
                  <span>30 FPS</span>
                  <span>·</span>
                  <span>1920x1080</span>
                </div>
              </div>

              {/* Pistes de montage vidéo / 3D */}
              <div className="flex-1 p-2 space-y-1.5 overflow-x-auto bg-gray-50/30 dark:bg-gray-950/30">
                <div className="h-6 rounded bg-indigo-100/50 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800 flex items-center px-2 text-[10px] font-mono text-indigo-700 dark:text-indigo-300">
                  <span className="font-bold mr-2">Piste 1 (3D / Vidéo)</span>
                  <span className="text-gray-400">Plan_01_Cinematic_Establish.mp4</span>
                </div>
                <div className="h-6 rounded bg-purple-100/50 dark:bg-purple-950/50 border border-purple-200 dark:border-purple-800 flex items-center px-2 text-[10px] font-mono text-purple-700 dark:text-purple-300">
                  <span className="font-bold mr-2">Piste 2 (FX / Shaders)</span>
                  <span className="text-gray-400">Volumetric_Lighting_Pass.fx</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
