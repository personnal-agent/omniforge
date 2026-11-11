import React, { useState, useEffect } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  User, Plus, Trash2, X, Upload, Sparkles, Check, Mic, Cpu, Cloud, Shuffle, Tag, Loader2,
} from 'lucide-react';
import { apiClient } from '../../services/apiClient';
import type { Character, CharacterArchetype, EnginePreference } from '../../types/studio';

export interface CharactersModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectCharacterToken?: (token: string) => void;
}

const CHARACTER_ARCHETYPES: Array<{
  id: CharacterArchetype;
  label: string;
  subtitle: string;
  emoji: string;
  badgeColor: string;
}> = [
  { id: 'The Eccentric', label: 'The Eccentric', subtitle: 'Exubérant & créatif décalé', emoji: '🎨', badgeColor: 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/30' },
  { id: 'The Professional', label: 'The Professional', subtitle: 'Corporate & formel', emoji: '👔', badgeColor: 'bg-blue-500/10 text-blue-400 border-blue-500/30' },
  { id: 'The Wildcard', label: 'The Wildcard', subtitle: 'Spontané & imprévisible', emoji: '⚡', badgeColor: 'bg-amber-500/10 text-amber-400 border-amber-500/30' },
  { id: 'The Familiar', label: 'The Familiar', subtitle: 'Accessible & chaleureux', emoji: '🤝', badgeColor: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' },
  { id: 'The Wicked', label: 'The Wicked', subtitle: 'Sombre, énigmatique & intense', emoji: '🌑', badgeColor: 'bg-rose-500/10 text-rose-400 border-rose-500/30' },
  { id: 'The Fantastical', label: 'The Fantastical', subtitle: 'Mythique, féérique & onirique', emoji: '✨', badgeColor: 'bg-purple-500/10 text-purple-400 border-purple-500/30' },
];

export const CharactersModal: React.FC<CharactersModalProps> = ({
  isOpen,
  onClose,
  onSelectCharacterToken,
}) => {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [selectedArchetypeFilter, setSelectedArchetypeFilter] = useState<string | null>(null);

  // Form states
  const [newName, setNewName] = useState('');
  const [newPhysicalPrompt, setNewPhysicalPrompt] = useState('');
  const [selectedArchetype, setSelectedArchetype] = useState<CharacterArchetype>('The Familiar');
  const [visualAnchors, setVisualAnchors] = useState<string[]>([]);
  const [anchorInputText, setAnchorInputText] = useState('');
  const [enginePreference, setEnginePreference] = useState<EnginePreference>('local');
  const [newVoiceStyle, setNewVoiceStyle] = useState('feminine_soft');
  const [uploadedImage, setUploadedImage] = useState<{ path: string; url: string } | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  const fetchCharacters = async (archetypeFilter?: string | null) => {
    setLoading(true);
    try {
      const list = await apiClient.listCharacters(archetypeFilter || undefined);
      setCharacters(list);
    } catch (err) {
      console.error('Failed to load characters:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchCharacters(selectedArchetypeFilter);
      setIsCreating(false);
    }
  }, [isOpen, selectedArchetypeFilter]);

  const [generatingSheetId, setGeneratingSheetId] = useState<string | null>(null);

  const handleGenerateSheet = async (characterId: string) => {
    try {
      setGeneratingSheetId(characterId);
      const res = await apiClient.generateCharacterSheet(characterId);
      if (res.taskId) {
        const unsub = apiClient.subscribeTaskStatus(
          res.taskId,
          (evt) => {
            if (evt.status === 'completed' || evt.status === 'failed' || evt.status === 'cancelled') {
              unsub();
              setGeneratingSheetId(null);
              fetchCharacters(selectedArchetypeFilter);
            }
          },
          () => {
            unsub();
            setGeneratingSheetId(null);
          }
        );
      } else {
        setGeneratingSheetId(null);
      }
    } catch (err) {
      console.error('Erreur génération planche:', err);
      setGeneratingSheetId(null);
    }
  };

  const handleFilterClick = (archetypeId: string | null) => {
    setSelectedArchetypeFilter(archetypeId);
    fetchCharacters(archetypeId);
  };

  const handleAddAnchor = () => {
    const trimmed = anchorInputText.trim();
    if (trimmed && !visualAnchors.includes(trimmed)) {
      setVisualAnchors((prev) => [...prev, trimmed]);
      setAnchorInputText('');
    }
  };

  const handleRemoveAnchor = (tag: string) => {
    setVisualAnchors((prev) => prev.filter((a) => a !== tag));
  };

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const res = await apiClient.uploadFile(file);
      setUploadedImage({ path: res.filePath, url: res.url });
    } catch (err) {
      console.error('Upload failed:', err);
    }
  };

  const handleCreateCharacter = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPhysicalPrompt.trim()) return;

    try {
      await apiClient.createCharacter({
        name: newName.trim(),
        physicalPrompt: newPhysicalPrompt.trim(),
        archetype: selectedArchetype,
        visualAnchors,
        enginePreference,
        referenceImagePath: uploadedImage?.path || null,
        voiceStyle: newVoiceStyle,
      });
      setNewName('');
      setNewPhysicalPrompt('');
      setVisualAnchors([]);
      setAnchorInputText('');
      setUploadedImage(null);
      setIsCreating(false);
      fetchCharacters(selectedArchetypeFilter);
    } catch (err) {
      console.error('Failed to create character:', err);
    }
  };

  const handleDelete = async (id: string) => {
    if (!window.confirm('Supprimer cette fiche personnage ?')) return;
    try {
      await apiClient.deleteCharacter(id);
      setCharacters((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.error('Failed to delete character:', err);
    }
  };

  const handleInsertToken = (token: string) => {
    onSelectCharacterToken?.(token);
    setCopiedToken(token);
    setTimeout(() => {
      setCopiedToken(null);
      onClose();
    }, 400);
  };

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 animate-fade-in" />
        <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-2xl max-h-[90vh] z-50 bg-[#121316] text-white rounded-3xl shadow-2xl border border-white/10 p-6 flex flex-col overflow-hidden outline-none">
          {/* Header */}
          <div className="flex items-center justify-between pb-4 border-b border-white/10">
            <div className="flex items-center space-x-3">
              <div className="w-9 h-9 rounded-full bg-indigo-500/20 flex items-center justify-center text-indigo-400 border border-indigo-500/30">
                <User className="w-5 h-5" />
              </div>
              <div>
                <Dialog.Title className="text-sm font-bold text-white flex items-center gap-2">
                  <span>Fiches Personnages Google Flow Pro</span>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/40">
                    6 Archétypes
                  </span>
                </Dialog.Title>
                <Dialog.Description className="text-xs text-neutral-400">
                  Archétypes dramatiques, ancres visuelles multi-angles et ancrage vocal persistant (@Nom)
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Fermer"
                className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </Dialog.Close>
          </div>

          {/* Subheader & Archetype Filters */}
          {!isCreating && (
            <div className="py-3 border-b border-white/5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-neutral-300">
                  {characters.length} personnage(s) enregistré(s)
                </span>
                <button
                  type="button"
                  onClick={() => setIsCreating(true)}
                  className="px-3.5 py-1.5 rounded-full text-xs font-semibold bg-white text-black hover:bg-neutral-200 flex items-center space-x-1.5 transition-all shadow-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Nouveau personnage</span>
                </button>
              </div>

              {/* Archetype Filter Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[11px] scrollbar-none">
                <button
                  type="button"
                  onClick={() => handleFilterClick(null)}
                  className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors border ${
                    selectedArchetypeFilter === null
                      ? 'bg-white text-black border-white font-semibold'
                      : 'bg-white/5 text-neutral-400 border-white/10 hover:bg-white/10'
                  }`}
                >
                  Tous
                </button>
                {CHARACTER_ARCHETYPES.map((arch) => (
                  <button
                    key={arch.id}
                    type="button"
                    aria-label={`Filtre: ${arch.id}`}
                    onClick={() => handleFilterClick(arch.id)}
                    className={`px-2.5 py-1 rounded-full whitespace-nowrap transition-colors flex items-center gap-1 border ${
                      selectedArchetypeFilter === arch.id
                        ? 'bg-indigo-600 text-white border-indigo-400 font-semibold'
                        : 'bg-white/5 text-neutral-400 border-white/10 hover:bg-white/10'
                    }`}
                  >
                    <span>{arch.emoji}</span>
                    <span>{arch.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Main Body */}
          <div className="flex-1 overflow-y-auto py-4 space-y-4">
            {isCreating ? (
              <form onSubmit={handleCreateCharacter} className="bg-white/5 p-4 rounded-2xl border border-white/10 space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-white flex items-center gap-1.5">
                    <Sparkles className="w-4 h-4 text-indigo-400" />
                    Créer un personnage (Alignement Google Flow Pro)
                  </span>
                  <button
                    type="button"
                    onClick={() => setIsCreating(false)}
                    className="text-xs text-neutral-400 hover:text-white transition-colors"
                  >
                    Annuler
                  </button>
                </div>

                {/* 6 Archetype Selection Cards */}
                <div>
                  <label className="text-[11px] font-semibold text-neutral-300 block mb-2">
                    Sélectionner l'Archétype Dramatique (Google Flow Pro)
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {CHARACTER_ARCHETYPES.map((arch) => {
                      const isSelected = selectedArchetype === arch.id;
                      return (
                        <button
                          key={arch.id}
                          type="button"
                          onClick={() => setSelectedArchetype(arch.id)}
                          className={`p-2.5 rounded-xl border text-left transition-all ${
                            isSelected
                              ? 'border-indigo-400 bg-indigo-500/20 shadow-md ring-1 ring-indigo-400/50'
                              : 'border-white/10 bg-white/5 hover:bg-white/10 text-neutral-300'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-base">{arch.emoji}</span>
                            {isSelected && <Check className="w-3.5 h-3.5 text-indigo-400" />}
                          </div>
                          <div className="text-xs font-bold text-white">{arch.label}</div>
                          <div className="text-[10px] text-neutral-400 leading-tight mt-0.5 line-clamp-1">
                            {arch.subtitle}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Character Name */}
                <div>
                  <label className="text-[11px] font-semibold text-neutral-300 block mb-1">
                    Nom du Personnage (ex: Tomate, Elena, Marcus)
                  </label>
                  <input
                    type="text"
                    required
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Tomate"
                    className="w-full text-xs px-3 py-2 rounded-xl border border-white/10 bg-black/40 text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                {/* Physical Prompt */}
                <div>
                  <label className="text-[11px] font-semibold text-neutral-300 block mb-1">
                    Description physique immuable (Injectée automatiquement dès que @Nom est écrit)
                  </label>
                  <textarea
                    required
                    rows={3}
                    value={newPhysicalPrompt}
                    onChange={(e) => setNewPhysicalPrompt(e.target.value)}
                    placeholder="Anthropomorphic ripe red tomato character, glossy expressive eyes, fine organic skin pores..."
                    className="w-full text-xs px-3 py-2 rounded-xl border border-white/10 bg-black/40 text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500 leading-relaxed"
                  />
                </div>

                {/* Visual Anchors Tag Manager */}
                <div>
                  <label className="text-[11px] font-semibold text-neutral-300 block mb-1 flex items-center gap-1.5">
                    <Tag className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Ancres Visuelles Multi-Angles (Visual Anchors)</span>
                  </label>
                  <div className="flex gap-2 mb-2">
                    <input
                      type="text"
                      value={anchorInputText}
                      onChange={(e) => setAnchorInputText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddAnchor();
                        }
                      }}
                      placeholder="Ajouter une ancre visuelle (ex: lunettes rondes, cicatrice front)..."
                      className="flex-1 text-xs px-3 py-2 rounded-xl border border-white/10 bg-black/40 text-white placeholder-neutral-500 focus:outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      aria-label="Ajouter ancre"
                      onClick={handleAddAnchor}
                      className="px-3 py-2 rounded-xl bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-colors flex items-center gap-1"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Ajouter</span>
                    </button>
                  </div>

                  {visualAnchors.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {visualAnchors.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
                        >
                          <span>{tag}</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveAnchor(tag)}
                            className="hover:text-white transition-colors"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Engine Preference & Voice */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  {/* Engine Preference */}
                  <div>
                    <label className="text-[11px] font-semibold text-neutral-300 block mb-1">
                      Préférence Moteur d'Inférence
                    </label>
                    <div className="grid grid-cols-3 gap-1 p-1 bg-black/40 border border-white/10 rounded-xl text-[10px]">
                      <button
                        type="button"
                        onClick={() => setEnginePreference('local')}
                        className={`py-1.5 rounded-lg font-medium transition-all flex flex-col items-center gap-0.5 ${
                          enginePreference === 'local'
                            ? 'bg-emerald-600 text-white shadow-xs'
                            : 'text-neutral-400 hover:text-white'
                        }`}
                      >
                        <Cpu className="w-3.5 h-3.5" />
                        <span>Local RTX</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEnginePreference('cloud')}
                        className={`py-1.5 rounded-lg font-medium transition-all flex flex-col items-center gap-0.5 ${
                          enginePreference === 'cloud'
                            ? 'bg-indigo-600 text-white shadow-xs'
                            : 'text-neutral-400 hover:text-white'
                        }`}
                      >
                        <Cloud className="w-3.5 h-3.5" />
                        <span>Cloud API</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setEnginePreference('hybrid')}
                        className={`py-1.5 rounded-lg font-medium transition-all flex flex-col items-center gap-0.5 ${
                          enginePreference === 'hybrid'
                            ? 'bg-purple-600 text-white shadow-xs'
                            : 'text-neutral-400 hover:text-white'
                        }`}
                      >
                        <Shuffle className="w-3.5 h-3.5" />
                        <span>Hybride</span>
                      </button>
                    </div>
                  </div>

                  {/* Voice Profile */}
                  <div>
                    <label className="text-[11px] font-semibold text-neutral-300 block mb-1 flex items-center gap-1">
                      <Mic className="w-3.5 h-3.5 text-indigo-400" />
                      Profil vocal (Audio Weaver)
                    </label>
                    <select
                      value={newVoiceStyle}
                      onChange={(e) => setNewVoiceStyle(e.target.value)}
                      className="w-full text-xs px-3 py-2.5 rounded-xl border border-white/10 bg-black/40 text-white focus:outline-none focus:border-indigo-500"
                    >
                      <option value="feminine_soft">Féminine douce</option>
                      <option value="whisper_intimate">Murmure intime</option>
                      <option value="masculine_deep">Masculine grave</option>
                      <option value="energetic">Énergique / TikTok</option>
                    </select>
                  </div>
                </div>

                {/* Reference Photo Upload */}
                <div>
                  <label className="text-[11px] font-semibold text-neutral-300 block mb-1 flex items-center gap-1">
                    <Upload className="w-3.5 h-3.5 text-indigo-400" />
                    Image de référence (visage/corps)
                  </label>
                  <label className="flex items-center justify-center px-3 py-2 rounded-xl border border-dashed border-white/20 cursor-pointer hover:bg-white/5 text-xs text-neutral-300 transition-colors">
                    <span>{uploadedImage ? '✓ Réf chargée' : 'Choisir une photo...'}</span>
                    <input type="file" accept="image/*" onChange={handleImageUpload} className="hidden" />
                  </label>
                </div>

                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-md transition-colors mt-2"
                >
                  Enregistrer la fiche personnage
                </button>
              </form>
            ) : loading ? (
              <div className="py-8 text-center text-xs text-neutral-400">Chargement des personnages...</div>
            ) : characters.length === 0 ? (
              <div className="py-8 text-center space-y-2">
                <p className="text-xs text-neutral-400">
                  Aucun personnage enregistré pour ce filtre. Cliquez sur "Nouveau personnage" pour créer votre premier personnage persistant.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {characters.map((c) => {
                  const archetypeObj = CHARACTER_ARCHETYPES.find((a) => a.id === c.archetype);
                  return (
                    <div
                      key={c.id}
                      className="p-3.5 rounded-2xl border border-white/10 bg-white/5 flex flex-col justify-between hover:border-indigo-500/40 transition-colors shadow-xs"
                    >
                      <div>
                        {/* Card Header */}
                        <div className="flex items-center justify-between mb-1.5">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-mono font-bold text-xs text-indigo-400">{c.triggerToken}</span>
                            <span className="text-neutral-400 text-xs">({c.name})</span>
                            {c.archetype && (
                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${
                                  archetypeObj?.badgeColor || 'bg-white/5 text-neutral-300 border-white/10'
                                }`}
                              >
                                <span>{archetypeObj?.emoji}</span>
                                <span>{c.archetype}</span>
                              </span>
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => handleDelete(c.id)}
                            className="text-neutral-400 hover:text-rose-400 p-1 rounded-full transition-colors"
                            title="Supprimer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Reference Image Preview */}
                        {c.referenceImagePath && (
                          <div className="relative mb-2.5 rounded-xl overflow-hidden border border-white/10 group bg-black/40">
                            <img
                              src={
                                c.referenceImagePath.startsWith('http') || c.referenceImagePath.startsWith('/')
                                  ? c.referenceImagePath
                                  : `/files/${c.referenceImagePath.split('/').pop()}`
                              }
                              alt={c.name}
                              className="w-full h-28 object-cover object-top transition-transform group-hover:scale-105"
                              onError={(e) => {
                                const target = e.currentTarget;
                                const fname = c.referenceImagePath?.split('/').pop() || '';
                                if (!target.src.includes('/api/uploads/')) {
                                  target.src = `/api/uploads/${fname}`;
                                }
                              }}
                            />
                            <div className="absolute top-1.5 right-1.5 px-2 py-0.5 rounded-full bg-black/70 backdrop-blur-xs text-[9px] text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                              <Check className="w-2.5 h-2.5 text-emerald-400" />
                              <span>Planche Active</span>
                            </div>
                          </div>
                        )}

                        {/* Physical Prompt */}
                        <p className="text-[11px] text-neutral-300 line-clamp-2 leading-relaxed">
                          {c.physicalPrompt}
                        </p>

                        {/* Visual Anchors badges */}
                        {c.visualAnchors && c.visualAnchors.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {c.visualAnchors.map((tag) => (
                              <span
                                key={tag}
                                className="text-[10px] px-2 py-0.5 rounded-md bg-white/5 text-neutral-400 border border-white/5"
                              >
                                #{tag}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Card Footer */}
                      <div className="mt-3 pt-2.5 border-t border-white/5 flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] text-neutral-400 uppercase font-mono">
                            {c.voiceStyle || 'voix douce'}
                          </span>
                          {c.enginePreference && (
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-neutral-400 border border-white/5 uppercase font-mono">
                              {c.enginePreference}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={generatingSheetId === c.id}
                            onClick={() => handleGenerateSheet(c.id)}
                            className="px-2.5 py-1 rounded-full bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-300 border border-indigo-500/30 text-[11px] font-semibold flex items-center space-x-1 transition-colors"
                            title="Générer une planche de référence multi-angles avec NoctQ V4 pour figer l'apparence"
                          >
                            {generatingSheetId === c.id ? (
                              <>
                                <Loader2 className="w-3 h-3 animate-spin text-indigo-400" />
                                <span>Génération...</span>
                              </>
                            ) : (
                              <>
                                <Sparkles className="w-3 h-3 text-indigo-400" />
                                <span>{c.referenceImagePath ? 'Regénérer' : 'Planche Réf'}</span>
                              </>
                            )}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleInsertToken(c.triggerToken)}
                            className="px-2.5 py-1 rounded-full bg-white/10 text-white hover:bg-white/20 border border-white/10 text-[11px] font-semibold flex items-center space-x-1 transition-colors"
                          >
                            {copiedToken === c.triggerToken ? (
                              <>
                                <Check className="w-3 h-3 text-emerald-400" />
                                <span>Inséré !</span>
                              </>
                            ) : (
                              <>
                                <Plus className="w-3 h-3" />
                                <span>Insérer</span>
                              </>
                            )}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
