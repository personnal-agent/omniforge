import React from 'react';
import {
  Film,
  Play,
  Sparkles,
  Zap,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Camera,
  ArrowRight,
  User,
} from 'lucide-react';
import type { StorySegmentResponse } from '../../types/studio';

export interface StoryboardTimelineProps {
  segments: StorySegmentResponse[];
  totalDurationSec: number;
  sceneOverview?: string;
  activeSegmentIndex?: number | null;
  onGeneratePlan?: (segment: StorySegmentResponse) => void;
  onGenerateAllPlans?: () => void;
  isGeneratingAll?: boolean;
  onSelectSegment?: (segment: StorySegmentResponse) => void;
}

export const StoryboardTimeline: React.FC<StoryboardTimelineProps> = ({
  segments,
  totalDurationSec,
  sceneOverview,
  activeSegmentIndex,
  onGeneratePlan,
  onGenerateAllPlans,
  isGeneratingAll = false,
  onSelectSegment,
}) => {
  if (!segments || segments.length === 0) {
    return null;
  }

  return (
    <div
      data-testid="storyboard-timeline-bar"
      className="w-full bg-white dark:bg-gray-900 border-t border-studio-border p-3 shadow-md flex flex-col space-y-3 z-20"
    >
      {/* En-tête de la Timeline */}
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-2.5">
          <div className="w-7 h-7 rounded-lg bg-indigo-50 dark:bg-indigo-950/80 flex items-center justify-center text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
            <Film className="w-4 h-4" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="text-xs font-bold text-gray-900 dark:text-gray-100">
                Storyboard & Chaînage Visuel
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 font-semibold">
                {segments.length} {segments.length > 1 ? 'plans' : 'plan'}
              </span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                <Clock className="w-2.5 h-2.5 inline mr-1" />
                {totalDurationSec}s total
              </span>
            </div>
            {sceneOverview && (
              <p className="text-[11px] text-gray-400 line-clamp-1 max-w-xl mt-0.5" title={sceneOverview}>
                {sceneOverview}
              </p>
            )}
          </div>
        </div>

        {/* Action globale : Lancer la séquence complète */}
        <button
          type="button"
          data-testid="generate-all-sequence-btn"
          onClick={onGenerateAllPlans}
          disabled={isGeneratingAll}
          className="flex items-center space-x-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold shadow-xs disabled:opacity-50 transition-colors"
        >
          {isGeneratingAll ? (
            <>
              <Zap className="w-3.5 h-3.5 animate-pulse text-amber-300" />
              <span>Rendu Séquence en cours...</span>
            </>
          ) : (
            <>
              <Play className="w-3.5 h-3.5 fill-white" />
              <span>Lancer la séquence complète</span>
            </>
          )}
        </button>
      </div>

      {/* Bande de défilement des plans reliés */}
      <div className="flex items-stretch space-x-3 overflow-x-auto pb-1 pt-0.5 scrollbar-thin">
        {segments.map((segment, idx) => {
          const isActive = activeSegmentIndex === segment.index;
          const status = segment.status || 'pending';

          return (
            <React.Fragment key={`plan-${segment.index}`}>
              {/* Carte de plan */}
              <div
                data-testid={`storyboard-plan-card-${segment.index}`}
                onClick={() => onSelectSegment?.(segment)}
                className={`w-72 flex-shrink-0 bg-gray-50 dark:bg-gray-800/80 rounded-xl p-3 border transition-all flex flex-col justify-between space-y-2.5 cursor-pointer ${
                  isActive
                    ? 'border-indigo-500 ring-2 ring-indigo-500/20 shadow-md'
                    : 'border-studio-border hover:border-gray-300 dark:hover:border-gray-600'
                }`}
              >
                {/* En-tête de carte */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5">
                    <span className="font-mono text-xs font-bold text-gray-800 dark:text-gray-200">
                      Plan {segment.index}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
                      {segment.durationSec}s
                    </span>
                  </div>

                  {/* Badge statut */}
                  <div className="flex items-center space-x-1 text-[10px] font-medium">
                    {status === 'completed' && (
                      <span className="text-emerald-600 dark:text-emerald-400 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Prêt</span>
                      </span>
                    )}
                    {status === 'running' && (
                      <span className="text-amber-600 dark:text-amber-400 flex items-center space-x-1 animate-pulse">
                        <Zap className="w-3 h-3" />
                        <span>GPU...</span>
                      </span>
                    )}
                    {status === 'failed' && (
                      <span className="text-rose-600 dark:text-rose-400 flex items-center space-x-1">
                        <AlertTriangle className="w-3 h-3" />
                        <span>Échec</span>
                      </span>
                    )}
                    {status === 'pending' && (
                      <span className="text-gray-400">En attente</span>
                    )}
                  </div>
                </div>

                {/* Type de plan caméra */}
                <div className="flex items-center space-x-1 text-[10px] text-gray-500 font-mono">
                  <Camera className="w-3 h-3 text-indigo-400" />
                  <span>{segment.shotType}</span>
                </div>

                {/* Prompt de l'action */}
                <p className="text-xs text-gray-700 dark:text-gray-300 line-clamp-2 leading-relaxed">
                  {segment.actionPrompt}
                </p>

                {/* Ancres de Personnages détectées */}
                {segment.characterAnchors && segment.characterAnchors.length > 0 && (
                  <div className="space-y-1.5 pt-1 border-t border-gray-200 dark:border-gray-700">
                    {segment.characterAnchors.map((char) => (
                      <div key={char.id || char.name} className="flex flex-wrap items-center gap-1">
                        <span className="inline-flex items-center space-x-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-indigo-50 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 border border-indigo-200 dark:border-indigo-800">
                          <User className="w-2.5 h-2.5" />
                          <span>{char.name || char.label}</span>
                        </span>
                        {char.visualAnchors &&
                          Array.isArray(char.visualAnchors) &&
                          char.visualAnchors.map((anchor: string, aIdx: number) => (
                            <span
                              key={`${char.id || char.name || 'char'}-${anchor}-${aIdx}`}
                              className="px-1.5 py-0.5 rounded text-[9px] bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-400 border border-studio-border"
                            >
                              {anchor}
                            </span>
                          ))}
                      </div>
                    ))}
                  </div>
                )}

                {/* Bouton de génération individuel */}
                <div className="pt-1 flex items-center justify-between">
                  <button
                    type="button"
                    data-testid={`generate-plan-${segment.index}-btn`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onGeneratePlan?.(segment);
                    }}
                    disabled={status === 'running'}
                    className="w-full flex items-center justify-center space-x-1.5 py-1 px-2.5 rounded-lg bg-white dark:bg-gray-700 hover:bg-gray-100 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-200 text-xs font-medium border border-studio-border transition-colors disabled:opacity-50"
                  >
                    <Sparkles className="w-3 h-3 text-indigo-500" />
                    <span>Générer ce plan</span>
                  </button>
                </div>
              </div>

              {/* Connecteur temporel visuel entre plans */}
              {idx < segments.length - 1 && (
                <div className="flex items-center justify-center flex-shrink-0 text-gray-300 dark:text-gray-600">
                  <ArrowRight className="w-4 h-4" />
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
};
