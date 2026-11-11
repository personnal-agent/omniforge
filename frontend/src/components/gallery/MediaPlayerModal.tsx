import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Camera, Check, Copy, Download, Folder, Layers, Mic, Sparkles, Star, Trash2, Volume2, X, Zap } from 'lucide-react';
import { apiClient, getMediaFileUrl } from '../../services/apiClient';
import type { CharacterAnchorData, Generation } from '../../types/studio';

export interface MediaPlayerModalProps {
  generation: Generation | null;
  isOpen: boolean;
  onClose: () => void;
  onRemix: (generation: Generation) => void;
  onUpscale?: (generation: Generation) => void;
  onLipSync?: (generation: Generation) => void;
  onFavoriteToggled?: (generation: Generation) => void;
  onDelete?: (generation: Generation) => void;
  onInjectToCanvas?: (generation: Generation) => void;
}

export const MediaPlayerModal: React.FC<MediaPlayerModalProps> = ({
  generation, isOpen, onClose, onRemix, onUpscale, onLipSync, onFavoriteToggled, onDelete, onInjectToCanvas,
}) => {
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [isUpdatingFavorite, setIsUpdatingFavorite] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [rating, setRating] = useState(generation?.rating || 0);
  const [angleFeedback, setAngleFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (generation) {
      setRating(generation.rating || 0);
    }
  }, [generation]);

  if (!generation) return null;

  const handleSetRating = async (star: number) => {
    const nextRating = rating === star ? 0 : star;
    setRating(nextRating);
    try {
      await apiClient.updateGenerationMetadata(generation.id, { rating: nextRating });
    } catch (err) {
      console.error('Failed to update rating:', err);
    }
  };

  const handleGenerateAngleMatrix = async () => {
    if (!generation) return;
    setAngleFeedback('Génération des 4 angles...');
    try {
      await apiClient.generateAngleMatrix({
        sourceImage: generation.filePath || generation.id,
        aspectRatio: generation.parameters?.aspectRatio || '16:9',
        projectId: generation.projectId,
      });
      setAngleFeedback('✓ 4 angles lancés !');
      setTimeout(() => setAngleFeedback(null), 3000);
    } catch (err) {
      console.error('Angle matrix failed:', err);
      setAngleFeedback('Erreur');
      setTimeout(() => setAngleFeedback(null), 3000);
    }
  };

  const copyText = async (text: string, setCopied: (v: boolean) => void) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) { console.error('Failed to copy:', err); }
  };

  const handleToggleFavorite = async () => {
    if (isUpdatingFavorite) return;
    setIsUpdatingFavorite(true);
    try {
      const res = await apiClient.toggleFavorite(generation.id);
      onFavoriteToggled?.({ ...generation, isFavorite: res.isFavorite });
    } catch (err) { console.error('Failed to toggle favorite:', err); }
    finally { setIsUpdatingFavorite(false); }
  };

  const handleDelete = async () => {
    if (isDeleting || !generation) return;
    setIsDeleting(true);
    try {
      await apiClient.deleteGeneration(generation.id);
      onDelete?.(generation);
      onClose();
    } catch (err) {
      console.error('Failed to delete generation:', err);
    } finally {
      setIsDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed inset-3 sm:inset-8 z-50 bg-white rounded-dock shadow-2xl flex flex-col md:flex-row overflow-hidden border border-studio-border outline-none">
          <Dialog.Title className="sr-only">Inspection du média : {generation.prompt}</Dialog.Title>
          <Dialog.Description className="sr-only">Fiche technique et lecture du média</Dialog.Description>
          {/* Lecteur grand format */}
          <div className="flex-1 bg-black flex items-center justify-center relative overflow-hidden min-h-[300px]">
            {(generation.mediaType === 'video' || generation.mediaType === 'lip_sync' || (generation.mediaType === 'upscale' && (Boolean(generation.filePath?.endsWith('.mp4')) || generation.references?.upscaleSourceType === 'video'))) ? (
              <video src={getMediaFileUrl(generation)} controls autoPlay playsInline className="max-h-full max-w-full object-contain" />
            ) : generation.mediaType === 'audio' ? (
              <div className="flex flex-col items-center justify-center p-8 gap-4">
                <div className="w-20 h-20 rounded-full bg-indigo-900/60 flex items-center justify-center border border-indigo-500/30">
                  <Volume2 className="w-10 h-10 text-indigo-400 animate-pulse" />
                </div>
                <audio src={getMediaFileUrl(generation)} controls className="mt-4" />
              </div>
            ) : (
              <img src={getMediaFileUrl(generation)} alt={generation.prompt} className="max-h-full max-w-full object-contain" />
            )}
          </div>

          {/* Volet latéral de métadonnées */}
          <div className="w-full md:w-96 flex flex-col h-full border-t md:border-t-0 md:border-l border-studio-border bg-white overflow-hidden">
            <div className="p-4 border-b border-studio-border flex items-center justify-between bg-white z-10 flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs font-semibold px-2.5 py-1 rounded bg-indigo-50 text-indigo-700 border border-indigo-100">
                  {generation.modelName}
                </span>
                <span className="text-[11px] text-gray-400 uppercase tracking-wider font-semibold">{generation.mediaType}</span>
              </div>
              <Dialog.Close asChild>
                <button type="button" aria-label="Fermer" onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-studio-subtle transition-colors">
                  <X className="w-4 h-4" />
                </button>
              </Dialog.Close>
            </div>

            <div className="p-4 space-y-4 flex-1 text-xs overflow-y-auto min-h-0">
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider">Prompt original</span>
                  <button type="button" onClick={() => copyText(generation.prompt, setCopiedPrompt)} aria-label="Copier le prompt" className="text-gray-500 hover:text-indigo-600 flex items-center gap-1 transition-colors">
                    {copiedPrompt ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedPrompt ? 'Copié !' : 'Copier'}</span>
                  </button>
                </div>
                <div className="bg-studio-canvas p-3 rounded-dock border border-studio-border text-gray-800 leading-relaxed max-h-36 overflow-y-auto select-text">
                  {generation.prompt}
                </div>
              </div>

              {generation.compiledPrompt && (
                <div>
                  <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider block mb-1.5 flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-indigo-500" /> Prompt compilé (BrandKit)
                  </span>
                  <div className="bg-indigo-50/50 p-3 rounded-dock border border-indigo-100 text-indigo-900 leading-relaxed max-h-36 overflow-y-auto select-text">
                    {generation.compiledPrompt}
                  </div>
                </div>
              )}

              {generation.brandKitSnapshot && (
                <div>
                  <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider block mb-1.5 flex items-center gap-1">
                    <Layers className="w-3 h-3 text-purple-500" /> Snapshot BrandKit
                  </span>
                  <div className="bg-purple-50/50 p-2.5 rounded-dock border border-purple-100 space-y-1">
                    <div className="font-medium text-purple-900">{generation.brandKitSnapshot.name}</div>
                    {generation.brandKitSnapshot.overview && (
                      <div className="text-[11px] text-purple-700">{generation.brandKitSnapshot.overview}</div>
                    )}
                  </div>
                </div>
              )}

              <div>
                <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider block mb-2">Paramètres de génération</span>
                <div className="grid grid-cols-2 gap-2 font-mono text-[11px]">
                  {[
                    { label: 'Seed', val: generation.parameters?.seed ?? 'Aléatoire' },
                    { label: 'Ratio', val: generation.parameters?.aspectRatio || '16:9' },
                    { label: 'Résolution', val: generation.parameters?.resolution || 'HD' },
                    { label: 'Durée', val: generation.parameters?.duration || '5s' },
                  ].map((p) => (
                    <div key={p.label} className="bg-studio-canvas p-2 rounded border border-studio-border">
                      <span className="text-gray-400 block text-[10px]">{p.label}</span>
                      <span className="font-semibold text-gray-800">{p.val}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Module B: Ancres d'identité des personnages extraites */}
              {generation.parameters?.characterAnchors && Object.keys(generation.parameters.characterAnchors).length > 0 && (
                <div className="bg-indigo-50/60 p-2.5 rounded-dock border border-indigo-100">
                  <span className="font-semibold text-indigo-900 uppercase text-[10px] tracking-wider block mb-1.5 flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5 text-indigo-600" />
                    Ancres de personnages verrouillées
                  </span>
                  <div className="space-y-1.5">
                    {Object.entries(generation.parameters.characterAnchors).map(([key, anchor]: [string, CharacterAnchorData]) => (
                      <div key={key} className="flex items-center gap-2 p-1.5 bg-white rounded border border-indigo-100 text-[11px]">
                        {anchor.url && (
                          <img
                            src={anchor.url}
                            alt={anchor.label}
                            className="w-8 h-8 rounded object-cover flex-shrink-0 border border-indigo-200"
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-gray-800 truncate">
                            {anchor.label} <span className="text-[10px] font-normal text-indigo-600 font-mono">(Plan {anchor.sourceShotIndex})</span>
                          </div>
                          <div className="text-[10px] text-gray-500 truncate" title={anchor.description}>
                            {anchor.description}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Module F: Notation par étoiles 1-5 */}
              <div className="bg-gray-50 p-2.5 rounded-dock border border-studio-border">
                <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider block mb-1.5">
                  Appréciation & Note
                </span>
                <div className="flex items-center gap-1.5">
                  {[1, 2, 3, 4, 5].map((star) => (
                    <button
                      key={star}
                      type="button"
                      aria-label={`Attribuer ${star} étoile(s)`}
                      onClick={() => handleSetRating(star)}
                      className="p-1 hover:scale-110 transition-transform"
                    >
                      <Star
                        className={`w-4 h-4 ${
                          star <= rating
                            ? 'fill-amber-400 text-amber-400'
                            : 'text-gray-300 hover:text-amber-300'
                        }`}
                      />
                    </button>
                  ))}
                  <span className="text-[11px] font-mono text-gray-500 ml-1.5">
                    {rating > 0 ? `${rating}/5 étoiles` : 'Non noté'}
                  </span>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="font-semibold text-gray-700 uppercase text-[10px] tracking-wider flex items-center gap-1">
                    <Folder className="w-3 h-3 text-gray-400" /> Chemin de sortie
                  </span>
                  <button type="button" onClick={() => copyText(generation.filePath || '', setCopiedPath)} aria-label="Copier le chemin" className="text-gray-500 hover:text-indigo-600 flex items-center gap-1 transition-colors">
                    {copiedPath ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedPath ? 'Copié !' : 'Copier'}</span>
                  </button>
                </div>
                <div className="bg-studio-canvas p-2 rounded border border-studio-border text-gray-600 font-mono text-[11px] truncate select-all">
                  {generation.filePath}
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-studio-border bg-studio-canvas space-y-2 flex-shrink-0">
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleToggleFavorite} disabled={isUpdatingFavorite} aria-label={generation.isFavorite ? 'Retirer des favoris' : 'Favori'} className={`flex-1 h-9 rounded-full border text-xs font-medium flex items-center justify-center gap-1.5 transition-colors ${generation.isFavorite ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100' : 'bg-white border-studio-border text-gray-700 hover:bg-gray-50'}`}>
                  <Star className={`w-3.5 h-3.5 ${generation.isFavorite ? 'fill-amber-400 text-amber-400' : 'text-gray-400'}`} />
                  <span>Favori</span>
                </button>
                <a href={generation.filePath || '#'} download className="flex-1 h-9 rounded-full border border-studio-border bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors">
                  <Download className="w-3.5 h-3.5 text-gray-500" />
                  <span>Télécharger</span>
                </a>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => onRemix(generation)} aria-label="Remix" className="flex-1 h-10 rounded-full bg-gray-900 hover:bg-black text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors shadow-sm">
                  <Sparkles className="w-4 h-4 text-amber-400" />
                  <span>Remix</span>
                </button>
                {onLipSync && (
                  <button type="button" onClick={() => onLipSync(generation)} aria-label="Lip Sync" className="flex-1 h-10 rounded-full bg-purple-600 hover:bg-purple-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm">
                    <Mic className="w-4 h-4 text-purple-200" />
                    <span>Lip Sync</span>
                  </button>
                )}
                {onUpscale && (
                  <button type="button" onClick={() => onUpscale(generation)} aria-label="Upscale 4K" className="flex-1 h-10 rounded-full bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors shadow-sm">
                    <Zap className="w-4 h-4 text-amber-300 fill-amber-300" />
                    <span>Upscale 4K</span>
                  </button>
                )}
              </div>

              {/* Module A: Bouton Matrice 4 Angles */}
              <button
                type="button"
                onClick={handleGenerateAngleMatrix}
                className="w-full h-9 rounded-full border border-indigo-200 bg-indigo-50/80 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-xs"
              >
                <Camera className="w-3.5 h-3.5 text-indigo-600" />
                <span>{angleFeedback || '🎥 Générer Matrice 4 Angles Caméra'}</span>
              </button>

              {/* Action Passerelle Omniforge v3 : Injecter dans le Canevas Agents */}
              {onInjectToCanvas && (
                <button
                  type="button"
                  onClick={() => {
                    onInjectToCanvas(generation);
                    onClose();
                  }}
                  aria-label="Injecter dans le canevas"
                  className="w-full h-9 rounded-full border border-indigo-200 bg-indigo-50/90 hover:bg-indigo-100 text-indigo-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-xs"
                >
                  <Layers className="w-3.5 h-3.5 text-indigo-600" />
                  <span>🎨 Injecter dans le Canevas Agents</span>
                </button>
              )}

              {!confirmDelete ? (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  aria-label="Supprimer la génération"
                  className="w-full h-8 rounded-full border border-rose-200 bg-rose-50 hover:bg-rose-100 text-rose-700 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5 text-rose-600" />
                  <span>Supprimer la création</span>
                </button>
              ) : (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={handleDelete}
                    disabled={isDeleting}
                    aria-label="Confirmer la suppression"
                    className="flex-1 h-8 rounded-full bg-rose-600 hover:bg-rose-700 text-white text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors shadow-sm disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isDeleting ? 'Suppression...' : 'Confirmer'}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    disabled={isDeleting}
                    aria-label="Annuler la suppression"
                    className="h-8 px-3 rounded-full border border-studio-border bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium"
                  >
                    Annuler
                  </button>
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
