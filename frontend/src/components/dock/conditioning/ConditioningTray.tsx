import React, { useRef, useEffect } from 'react';
import { AlertCircle } from 'lucide-react';
import type { GenerationReferences, ModelDefinition } from '../../../types/studio';
import { apiClient } from '../../../services/apiClient';
import { ReferenceSlot } from './ReferenceSlot';

/**
 * Plateau de conditionnement multimédia (dock).
 * Contrat de propriété mémoire : ConditioningTray ne révoque que les Object URLs
 * qu'il crée localement lors de l'upload utilisateur. Les URLs fournies par le parent
 * restent sous la responsabilité exclusive du parent.
 */
export interface ConditioningTrayProps {
  mode: string;
  model?: ModelDefinition | null;
  references: GenerationReferences;
  onReferencesChange: (refs: GenerationReferences) => void;
}

export const ConditioningTray: React.FC<ConditioningTrayProps> = ({
  mode, model, references, onReferencesChange,
}) => {
  const caps = model?.capabilities;
  const supportsFirstFrame = mode === 'video' ? (caps?.supportsFirstFrame ?? true) : false;
  const supportsLastFrame = mode === 'video' ? (caps?.supportsLastFrame ?? true) : false;
  const supportsVideoRef = caps?.supportsVideoRef ?? true;
  const maxImageRefs = mode === 'lip_sync' ? Math.max(1, caps?.maxImageRefs ?? 1) : (caps?.maxImageRefs ?? 9);
  const maxVideoRefs = mode === 'lip_sync' ? Math.max(1, caps?.maxVideoRefs ?? 1) : (caps?.maxVideoRefs ?? 1);

  const imageRefs = references.imageRefs ?? [];
  const videoRefs = references.videoRefs ?? [];
  const isImageOverLimit = imageRefs.length > maxImageRefs;
  const isVideoOverLimit = videoRefs.length > maxVideoRefs;
  const isOverLimit = isImageOverLimit || isVideoOverLimit;

  const canAddImage = imageRefs.length < maxImageRefs;
  const canAddVideo = supportsVideoRef && videoRefs.length < maxVideoRefs;
  const canAddIngredient = !isOverLimit && (canAddImage || canAddVideo);
  const ingredientAccept = canAddVideo ? (canAddImage ? 'image/*,video/*' : 'video/*') : 'image/*';

  const createdUrlsRef = useRef<Set<string>>(new Set());
  const latestRefsRef = useRef(references);
  latestRefsRef.current = references;

  const isUrlReferenced = (url: string, refs: GenerationReferences) => {
    if (refs.startFrame === url || refs.endFrame === url || refs.upscaleSource === url) return true;
    if (refs.imageRefs?.some((u) => u === url)) return true;
    if (refs.videoRefs?.some((u) => u === url)) return true;
    if (refs.audioRefs?.some((u) => u === url)) return true;
    return false;
  };

  const safeRevokeIfNotReferenced = (url: string | null | undefined, nextRefs: GenerationReferences) => {
    if (url && typeof url === 'string' && url.startsWith('blob:') && createdUrlsRef.current.has(url)) {
      if (!isUrlReferenced(url, nextRefs)) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
        createdUrlsRef.current.delete(url);
      }
    }
  };

  const updateReferences = (nextRefs: GenerationReferences) => {
    latestRefsRef.current = nextRefs;
    const oldUrls = [
      references.startFrame, references.endFrame, references.upscaleSource,
      ...(references.imageRefs || []), ...(references.videoRefs || []), ...(references.audioRefs || []),
    ].filter((u): u is string => Boolean(u));

    oldUrls.forEach((u) => safeRevokeIfNotReferenced(u, nextRefs));
    onReferencesChange(nextRefs);
  };

  const prevRefsRef = useRef(references);
  useEffect(() => {
    const prev = prevRefsRef.current;
    if (prev !== references) {
      const prevUrls = [
        prev.startFrame, prev.endFrame, prev.upscaleSource,
        ...(prev.imageRefs || []), ...(prev.videoRefs || []), ...(prev.audioRefs || []),
      ].filter((u): u is string => Boolean(u));

      prevUrls.forEach((u) => safeRevokeIfNotReferenced(u, references));
      prevRefsRef.current = references;
    }
  });

  const handleFileSelect = (
    slotType: 'startFrame' | 'endFrame' | 'upscaleSource' | 'lipSyncImage' | 'lipSyncAudio' | 'ingredient',
    file: File
  ) => {
    const blobUrl = URL.createObjectURL(file);
    createdUrlsRef.current.add(blobUrl);

    if (slotType === 'startFrame') {
      updateReferences({ ...latestRefsRef.current, startFrame: blobUrl });
      apiClient.uploadFile(file).then((res) => {
        updateReferences({ ...latestRefsRef.current, startFrame: res.filePath });
      }).catch((e) => console.warn('Erreur téléversement startFrame:', e));
    } else if (slotType === 'endFrame') {
      updateReferences({ ...latestRefsRef.current, endFrame: blobUrl });
      apiClient.uploadFile(file).then((res) => {
        updateReferences({ ...latestRefsRef.current, endFrame: res.filePath });
      }).catch((e) => console.warn('Erreur téléversement endFrame:', e));
    } else if (slotType === 'upscaleSource') {
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
      updateReferences({
        ...latestRefsRef.current,
        upscaleSource: blobUrl,
        upscaleSourceType: isVideo ? 'video' : 'image',
        upscaleSourceFilename: file.name,
      });
      apiClient.uploadFile(file).then((res) => {
        updateReferences({
          ...latestRefsRef.current,
          upscaleSource: res.filePath,
          upscaleSourceType: isVideo ? 'video' : 'image',
          upscaleSourceFilename: file.name,
        });
      }).catch((e) => {
        console.warn('Erreur téléversement média source:', e);
      });
    } else if (slotType === 'lipSyncImage') {
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv|avi)$/i.test(file.name);
      if (isVideo) {
        updateReferences({ ...latestRefsRef.current, videoRefs: [blobUrl], imageRefs: [] });
        apiClient.uploadFile(file).then((res) => {
          updateReferences({ ...latestRefsRef.current, videoRefs: [res.filePath], imageRefs: [] });
        }).catch((e) => console.warn('Erreur téléversement lipSyncVideo:', e));
      } else {
        updateReferences({ ...latestRefsRef.current, imageRefs: [blobUrl], videoRefs: [] });
        apiClient.uploadFile(file).then((res) => {
          updateReferences({ ...latestRefsRef.current, imageRefs: [res.filePath], videoRefs: [] });
        }).catch((e) => console.warn('Erreur téléversement lipSyncImage:', e));
      }
    } else if (slotType === 'lipSyncAudio') {
      updateReferences({ ...latestRefsRef.current, audioRefs: [blobUrl] });
      apiClient.uploadFile(file).then((res) => {
        updateReferences({ ...latestRefsRef.current, audioRefs: [res.filePath] });
      }).catch((e) => console.warn('Erreur téléversement lipSyncAudio:', e));
    } else if (slotType === 'ingredient') {
      const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
      if (isVideo) {
        if (!supportsVideoRef || (latestRefsRef.current.videoRefs || []).length >= maxVideoRefs) {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
          createdUrlsRef.current.delete(blobUrl);
          return;
        }
        updateReferences({
          ...latestRefsRef.current,
          videoRefs: [...(latestRefsRef.current.videoRefs || []), blobUrl],
        });
        apiClient.uploadFile(file).then((res) => {
          const cur = latestRefsRef.current;
          const currentVideoRefs = cur.videoRefs || [];
          const nextList = currentVideoRefs.map((u) => (u === blobUrl ? res.filePath : u));
          if (!nextList.includes(res.filePath) && !currentVideoRefs.includes(res.filePath)) {
            nextList.push(res.filePath);
          }
          updateReferences({
            ...cur,
            videoRefs: nextList,
          });
        }).catch((e) => console.warn('Erreur téléversement ingrédient vidéo:', e));
      } else {
        if ((latestRefsRef.current.imageRefs || []).length >= maxImageRefs) {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
          createdUrlsRef.current.delete(blobUrl);
          return;
        }
        updateReferences({
          ...latestRefsRef.current,
          imageRefs: [...(latestRefsRef.current.imageRefs || []), blobUrl],
        });
        apiClient.uploadFile(file).then((res) => {
          const cur = latestRefsRef.current;
          const currentImageRefs = cur.imageRefs || [];
          const nextList = currentImageRefs.map((u) => (u === blobUrl ? res.filePath : u));
          if (!nextList.includes(res.filePath) && !currentImageRefs.includes(res.filePath)) {
            nextList.push(res.filePath);
          }
          updateReferences({
            ...cur,
            imageRefs: nextList,
          });
        }).catch((e) => console.warn('Erreur téléversement ingrédient image:', e));
      }
    }
  };

  const removeIngredient = (idx: number, isVideo: boolean) => {
    const cur = latestRefsRef.current;
    if (isVideo) {
      updateReferences({ ...cur, videoRefs: (cur.videoRefs || []).filter((_, i) => i !== idx) });
    } else {
      updateReferences({ ...cur, imageRefs: (cur.imageRefs || []).filter((_, i) => i !== idx) });
    }
  };

  if (mode === 'llm' || mode === 'text') return null;

  return (
    <div className="w-full flex flex-col gap-2 pt-1 pb-2">
      {isOverLimit && (
        <div className="flex items-center gap-1.5 text-xs text-rose-600 bg-rose-50 px-3 py-1 rounded-lg border border-rose-200">
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            {isVideoOverLimit && isImageOverLimit
              ? `Limite de références (images et vidéos) dépassée. Retirez des ingrédients.`
              : isVideoOverLimit
              ? `Limite de références (vidéos) dépassée (${videoRefs.length}/${maxVideoRefs} max). Retirez des vidéos.`
              : `Limite de références (images) dépassée (${imageRefs.length}/${maxImageRefs} max). Retirez des images.`}
          </span>
        </div>
      )}

      <div className="flex items-center gap-2 overflow-x-auto scrollbar-none py-1">
        {mode === 'video' && (
          <>
            {supportsFirstFrame && (
              <ReferenceSlot
                label="Start frame" fileUrl={references.startFrame} accept="image/*"
                onFileSelected={(f: File) => handleFileSelect('startFrame', f)}
                onClear={() => updateReferences({ ...latestRefsRef.current, startFrame: null })}
              />
            )}
            {supportsLastFrame && (
              <ReferenceSlot
                label="End frame" fileUrl={references.endFrame} accept="image/*"
                onFileSelected={(f: File) => handleFileSelect('endFrame', f)}
                onClear={() => updateReferences({ ...latestRefsRef.current, endFrame: null })}
              />
            )}
            {imageRefs.map((url, idx) => (
              <ReferenceSlot
                key={`img-ref-${url}-${idx}`} label={`Réf ${idx + 1}`} badge={`Réf ${idx + 1}`}
                fileUrl={url} isWarning={isOverLimit} onClear={() => removeIngredient(idx, false)}
              />
            ))}
            {videoRefs.map((url, idx) => (
              <ReferenceSlot
                key={`vid-ref-${url}-${idx}`} label={`Vidéo ${idx + 1}`} badge="N-1"
                mediaType="video" fileUrl={url} isWarning={isOverLimit} onClear={() => removeIngredient(idx, true)}
              />
            ))}
            {canAddIngredient && (
              <ReferenceSlot
                label="+ Ingrédient" accept={ingredientAccept}
                onFileSelected={(f: File) => handleFileSelect('ingredient', f)}
              />
            )}
          </>
        )}

        {mode === 'image' && (
          <>
            {imageRefs.map((url, idx) => (
              <ReferenceSlot
                key={`img-ref-${url}-${idx}`} label={`Réf ${idx + 1}`} badge={`Réf ${idx + 1}`}
                fileUrl={url} onClear={() => removeIngredient(idx, false)}
              />
            ))}
            {imageRefs.length < (caps?.maxImageRefs ?? 4) && (
              <ReferenceSlot
                label="+ Réf Image" accept="image/*"
                onFileSelected={(f: File) => handleFileSelect('ingredient', f)}
              />
            )}
          </>
        )}

        {mode === 'lip_sync' && (
          <>
            <ReferenceSlot
              label="Vidéo / Portrait source"
              fileUrl={videoRefs[0] || imageRefs[0] || null}
              mediaType={videoRefs[0] ? 'video' : 'image'}
              accept="video/*,image/*"
              badge={videoRefs[0] ? 'Vidéo' : undefined}
              onFileSelected={(f: File) => handleFileSelect('lipSyncImage', f)}
              onClear={() => updateReferences({ ...latestRefsRef.current, videoRefs: [], imageRefs: [] })}
            />
            <ReferenceSlot
              label="Voix / Audio vocal" mediaType="audio" fileUrl={references.audioRefs?.[0] || null} accept="audio/*"
              onFileSelected={(f: File) => handleFileSelect('lipSyncAudio', f)}
              onClear={() => updateReferences({ ...latestRefsRef.current, audioRefs: [] })}
            />
          </>
        )}

        {mode === 'upscale' && (
          <ReferenceSlot
            label="Média source" fileUrl={references.upscaleSource}
            mediaType={references.upscaleSourceType || 'image'} accept="image/*,video/*"
            onFileSelected={(f: File) => handleFileSelect('upscaleSource', f)}
            onClear={() => updateReferences({ ...latestRefsRef.current, upscaleSource: null, upscaleSourceType: null, upscaleSourceFilename: null })}
          />
        )}
      </div>
    </div>
  );
};
