/**
 * Contrats TypeScript pour Colab AI Studio (frontend/src/types/studio.ts).
 * Miroir exact des modèles Pydantic v2 (app/models/domain.py) et des payloads de l'API.
 */
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ExecutionMode = 'colab' | 'local';
export type MediaType = 'image' | 'video' | 'audio' | 'upscale' | 'lip_sync' | 'text';

export interface CanvasAssetLayer {
  id: string;
  name: string;
  type: 'mesh_3d' | 'video' | 'image' | 'audio';
  taskId: string;
  fileUrl?: string;
  thumbnailUrl?: string;
  status: 'pending' | 'ready';
}

export interface CharacterAnchorData {
  url?: string;
  label?: string;
  sourceShotIndex?: number;
  description?: string;
  seed?: number;
}

export interface GenerationParameters {
  seed: number; aspectRatio: string; resolution: string; duration: string;
  frameRate?: string | null; audio?: boolean | null; enhance?: boolean | null;
  talkingStyle?: string; upscaleScale?: string; upscaleQuality?: string; upscaleFrameRate?: string;
  horizontalAngle?: number | null; verticalAngle?: number | null; zoomFactor?: number | null;
  autoVoiceOver?: boolean | null; chaining?: boolean | null;
  steps?: number | null; guidanceScale?: number | null;
  characterAnchors?: Record<string, CharacterAnchorData> | null;
  scriptPlan?: Record<string, unknown> | null;
  agentEnabled?: boolean | null;
  enginePreference?: EnginePreference | null;
  activeInstructionIds?: string[] | null;
}
export interface GenerationReferences {
  startFrame?: string | null; endFrame?: string | null; imageRefs?: string[];
  videoRefs?: string[]; audioRefs?: string[]; upscaleSource?: string | null;
  upscaleSourceType?: 'image' | 'video' | null; upscaleSourceFilename?: string | null; brandKitId?: string | null;
}
export interface BrandKitSnapshot {
  id: string; name: string; overview: string; colors: string[]; logos: string[]; fonts: string[]; guidelines: string[];
}
export type CharacterArchetype =
  | 'The Eccentric'
  | 'The Professional'
  | 'The Wildcard'
  | 'The Familiar'
  | 'The Wicked'
  | 'The Fantastical';

export type EnginePreference = 'local' | 'cloud' | 'hybrid';

export interface Character {
  id: string;
  name: string;
  triggerToken: string;
  physicalPrompt: string;
  archetype?: CharacterArchetype;
  visualAnchors?: string[];
  voiceProfileId?: string | null;
  voiceSamplePath?: string | null;
  voiceStyle?: string | null;
  enginePreference?: EnginePreference;
  referenceImagePath?: string | null;
  loraName?: string | null;
  loraStrength?: number;
  defaultSeed?: number | null;
  createdAt: string;
  updatedAt?: string;
}

export interface AgentInstruction {
  id: string;
  title: string;
  description: string;
  isActive: boolean;
  referenceAssetUrls: string[];
  order: number;
  createdAt: string;
  updatedAt: string;
}
export interface WorkloadEstimate {
  mediaType: string; modelId: string; numSegments: number; totalDurationSec: number;
  isChained: boolean; estimatedSecondsGpu: number; estimatedVramGb: number; vramTotalGb: number;
  detectedCharacters: string[]; detectedDialoguesCount: number;
}
export interface Generation {
  id: string; status: TaskStatus; mediaType: string; prompt: string;
  negativePrompt?: string | null; compiledPrompt?: string | null;
  filePath?: string | null; thumbnailPath?: string | null; progress?: number | null;
  errorMessage?: string | null; modelId: string; modelName: string;
  parameters: GenerationParameters; references: GenerationReferences;
  brandKitSnapshot?: BrandKitSnapshot | null; isFavorite: boolean;
  rating?: number; tags?: string[]; characterIds?: string[]; cameraAngleLabel?: string | null;
  projectId?: string | null; createdAt: string; workerUrl?: string | null;
  sequenceId?: string | null; sequenceIndex?: number | null; sequenceTotal?: number | null;
}
export interface Project {
  id: string; name: string; description?: string | null;
  colorTag?: string | null; storagePath?: string | null; createdAt: string; updatedAt: string;
}
export interface Logo { id: string; filePath: string; label: string; }
export interface Color { hex: string; label: string; isDominant?: boolean; }
export interface Font { family: string; weight: string; filePath?: string | null; }
export interface Asset { id: string; filePath: string; }
export interface Guideline { kind: 'do' | 'dont'; text: string; }

export interface BrandKit {
  id: string; name: string; overview: string; logos: Logo[]; colors: Color[]; fonts: Font[];
  referenceImages: Asset[]; voices: Array<Record<string, unknown>>;
  captions: Array<Record<string, unknown>>; guidelines: Guideline[];
  createdAt: string; updatedAt: string; lastUsedAt?: string | null;
}

export interface ColabConfig {
  tunnelUrl: string; accountEmail?: string | null; lastPing?: string | null;
  secret?: string | null;
  gpuName?: string | null; vramTotalMb?: number | null; vramUsedMb?: number | null;
}
export interface LocalConfig { device: string; threads: number; workerUrl: string; }
export interface CompilerLlmConfig { provider: string; model: string; apiKeyEnv: string; apiKey?: string | null; }
export interface LlmProxyConfig { enabled: boolean; host: string; port: number; timeout: number; }

export interface StudioConfig {
  executionMode: ExecutionMode; colab: ColabConfig; local: LocalConfig;
  compilerLlm: CompilerLlmConfig; defaultStoragePath: string; llmProxy: LlmProxyConfig;
}

export interface WorkerInfo {
  reachable: boolean; executionMode?: ExecutionMode; latencyMs?: number | null;
  gpu?: string | null; gpuName?: string | null; vramFreeMb?: number | null;
  vramTotalMb?: number | null; vramUsedMb?: number | null; error?: string | null;
}

export interface HostGpuInfo {
  name: string;
  shortName: string;
  vramTotalMb: number;
  vramUsedMb: number;
  vramFreeMb: number;
  vramTotalGb: number;
  vramUsedGb: number;
  vramFreeGb: number;
  temperatureC?: number | null;
  utilizationPct?: number | null;
  label: string;
}

export interface HostSystemInfo {
  cpu?: string;
  cpuRaw?: string;
  threads?: number;
  physicalCores?: number | null;
  ram?: string;
  ramAvailableGb?: number;
  gpu?: HostGpuInfo | null;
}

export interface HealthResponse {
  status: string;
  storage?: { path?: string; dataDirectory?: string; writable?: boolean; reachable?: boolean; availableBytes?: number };
  executionMode: ExecutionMode;
  worker: WorkerInfo;
  host?: HostSystemInfo;
}

export interface ModelCapabilities {
  supportsImageRef?: boolean; maxImageRefs?: number; supportsVideoRef?: boolean; maxVideoRefs?: number;
  supportsAudioRef?: boolean; supportsFirstFrame?: boolean; supportsLastFrame?: boolean;
  aspectRatios?: string[]; resolutions?: string[];
  durations?: string[] | { min: number; max: number; type: 'range' | 'discrete' };
  fps?: string[]; supportsAudio?: boolean; supportsEnhance?: boolean;
}

export interface ModelDefinition {
  id: string; name: string; type: 'image' | 'video' | 'audio' | 'upscale' | 'text' | string;
  description?: string; badge?: 'Beta' | 'New' | '! Slower than usual' | string;
  capabilities?: ModelCapabilities; active?: boolean;
}

export interface GenerationSubmitRequest {
  modelId: string; prompt: string; type?: string; negativePrompt?: string;
  parameters?: Partial<GenerationParameters>; references?: GenerationReferences;
  projectId?: string | null; brandKitId?: string | null; tags?: string[]; cameraAngleLabel?: string;
}
export interface GenerationSubmitResponse { taskId: string; status: TaskStatus; generationId?: string; }
export interface TaskStatusEvent {
  type?: string;
  taskId: string; status: TaskStatus; progress: number;
  step?: string; filePath?: string | null; outputUrl?: string; thumbnailUrl?: string; error?: string;
  generation?: Generation;
}

export interface StoryBreakdownRequest {
  prompt: string;
  totalDurationSec?: number | null;
  maxSegmentSec?: number;
  characterIds?: string[];
}

export interface StoryCharacterProfile {
  id: string;
  name: string;
  label?: string;
  description?: string;
  physicalPrompt?: string;
  archetype?: string | null;
  visualAnchors?: string[];
  voiceProfileId?: string | null;
  voiceStyle?: string | null;
}

export interface StorySegmentResponse {
  index: number;
  durationSec: number;
  actionPrompt: string;
  shotType: string;
  compiledPrompt: string;
  characterIds: string[];
  characterAnchors: StoryCharacterProfile[];
  status?: 'pending' | 'running' | 'completed' | 'failed';
  taskId?: string;
  outputUrl?: string;
}

export interface StoryBreakdownResponse {
  totalDurationSec: number;
  numSegments: number;
  sceneOverview: string;
  segments: StorySegmentResponse[];
  characters: StoryCharacterProfile[];
}

