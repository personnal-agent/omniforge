# Architecture & Cartographie du Projet — Colab AI Studio

## 1. Vue d'Ensemble du Système

**Colab AI Studio** est une plateforme de création multimédia assistée par IA conçue pour opérer sur une machine locale modeste (sans carte graphique dédiée) en déléguant l'inférence lourde à un environnement distant Google Colab équipé d'un GPU T4 (16 Go VRAM) via un tunnel chiffré (ngrok / Cloudflare Tunnels).

```
┌────────────────────────────────────────────────────────────────────────┐
│                          MACHINE LOCALE (PC)                           │
│                                                                        │
│   ┌──────────────────────────┐          ┌──────────────────────────┐   │
│   │    Frontend SPA React    │          │  Backend Local FastAPI   │   │
│   │    (Vite 5, Tailwind v3, │  HTTP /  │  (Python 3.10+, Uvicorn, │   │
│   │     Radix UI, Lucide)    │◄────────►│   Orchestrateur asynchr.)│   │
│   │                          │   SSE    │                          │   │
│   │  • Floating Prompt Dock  │          │  • Proxy /v1/chat API    │   │
│   │  • 4 Modes de création   │          │  • Persistance JSON data/│   │
│   │  • Interface adaptative  │          │  • Rapatriement outputs/ │   │
│   └──────────────────────────┘          └─────────────┬────────────┘   │
└───────────────────────────────────────────────────────┼────────────────┘
                                                        │ HTTP Tunnel
                                                        │ (ngrok / CF)
                                                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       WORKER DISTANT (GOOGLE COLAB)                    │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ Serveur GPU (FastAPI / PyTorch sur Nvidia T4 16 Go)            │   │
│   │                                                                │   │
│   │ • Dynamic Model Swapper (éviction VRAM agressive gc/cuda cache)│   │
│   │ • Pipeline Vidéo (Wan 2.1, CogVideoX)                          │   │
│   │ • Pipeline Image (Wan 2.5, SDXL, Flux)                         │   │
│   │ • Pipeline Lip Sync & Modèles de voix                          │   │
│   │ • Moteur LLM (Transformers / vLLM légers)                      │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Cartographie des Répertoires

```
colab-ai-studio/
├── README.md                      # Présentation générale et guide de démarrage
├── SPECIFICATION.md               # Spécifications fonctionnelles et techniques système
├── UI_SPECIFICATION.md            # Spécifications ergonomiques, composants et maquettes UI
├── DESIGN_SPECIFICATION.md        # Charte graphique, tokens de design et palette Tailwind
├── ARCHITECTURE.md                # Cartographie d'architecture et flux du système (ce fichier)
├── AGENTS.md                      # Règles de gouvernance et protocoles d'interaction IA
├── SECURITY.md                    # Procédure de divulgation des vulnérabilités de sécurité
│
├── .GCC/                          # Persistance de session et mémoire d'architecture
│   ├── PROTOCOL.md                # Spécification canonique et gabarits de session
│   ├── main.md                    # Registre global : jalons, backlog, journal de décisions
│   ├── resume.md                  # État de transition factuel et directives de reprise
│   └── branches/                  # Plans d'action tactiques et journaux de test
│       ├── test.md                # Journal d'exécution des tests et anomalies résolues
│       └── test_todo.md           # Scénarios et suites de test en attente
│
├── .gouvernance/                  # Politiques d'exécution et de revue de code
│   ├── accompanied-agent.md       # Matrice de droits allow/ask/deny (mode interactif par défaut)
│   ├── autonomous-agent.md        # Protocole d'exécution en boucle fermée (runners isolés)
│   ├── review-policy.md           # Mode Strict : l'IA n'approuve jamais son propre code
│   └── GOVERNANCE.md              # Cycle de vie GitHub, gestion des PRs et intégration continue
│
├── .githooks/                     # Garde-fous Git locaux (qualité et sécurité)
│   ├── pre-commit                 # Quality Gate ciblé sur le diff indexé + détection de secrets
│   ├── commit-msg                 # Validation Conventional Commits type(scope): description
│   └── pre-push                   # Tests unitaires + Quality Gate global (dépôt entier)
│
├── .github/                       # Workflows d'automatisation GitHub Actions
│   ├── workflows/                 # CI, gouvernance, sécurité, triage, hygiène
│   ├── ISSUE_TEMPLATE/            # Modèles d'anomalies, fonctionnalités et documentation
│   └── PULL_REQUEST_TEMPLATE.md   # Structure obligatoire de soumission de PR
│
├── ui-specifications/             # 17 captures d'écran et maquettes graphiques de référence
│
├── app/                           # [À initialiser] Backend local FastAPI
│   ├── main.py                    # Point d'entrée de l'API locale et distribution SPA
│   ├── config.py                  # Gestion du tunnel ngrok/CF et chemins locaux
│   ├── api/                       # Endpoints REST (/api/models, /api/generate, /v1/chat)
│   ├── services/                  # Client asynchrone Colab, rapatriement & compiler
│   └── storage/                   # Gestionnaire documentaire JSON (data/)
│
├── frontend/                      # [À initialiser] Application React SPA
│   ├── package.json               # Dépendances Vite, React, Radix UI, Lucide, Tailwind
│   ├── tailwind.config.js         # Configuration des tokens selon DESIGN_SPECIFICATION.md
│   └── src/                       # Composants atomiques (Dock, ParameterRegistry, boutons isolés), hooks et types
│
├── data/                          # Données applicatives locales (JSON légers)
│   ├── generations.json           # Journal exhaustif des créations (métadonnées complètes)
│   ├── brand_kits.json            # Profils de marque (logos, couleurs, polices, Do/Don't)
│   ├── projects.json              # Collections et regroupements thématiques
│   └── config.json                # Paramètres de configuration et URL du tunnel actif
│
├── outputs/                       # Sauvegarde locale sécurisée des binaires générés
│   └── YYYY-MM-DD/                # Partitionnement chronologique automatique (.mp4, .png)
│
└── colab_worker.ipynb             # [À initialiser] Notebook GPU pour Google Colab
```

---

## 3. Flux de Données & Responsabilités

### 3.1. Cycle de Génération Multimédia
1. L'utilisateur configure son prompt, sélectionne un modèle et ajoute des références dans le `FloatingPromptDock`.
2. Si un `Brand Kit` est actif, le `BrandContextCompiler` enrichit le brief et alloue les fentes disponibles.
3. La requête est transmise via l'API locale FastAPI (`POST /api/generate/media`).
4. Le backend local relaie la requête au worker GPU Colab via le tunnel chiffré.
5. Le worker Colab exécute l'inférence asynchrone (avec bascule dynamique de VRAM si un autre modèle était chargé) et renvoie un `task_id`.
6. L'interface locale suit l'avancement en direct via Server-Sent Events (SSE).
7. Dès l'achèvement, le backend local télécharge automatiquement le fichier média dans son dossier de destination résolu (le répertoire dédié `storagePath` si le projet en définit un, le sous-dossier standard `outputs/projects/<id>/` par défaut, ou `outputs/YYYY-MM-DD/` hors projet) et enregistre ses métadonnées dans `data/generations.json`.

### 3.2. Passerelle LLM Locale (`/v1/chat/completions`)
1. L'endpoint local FastAPI reçoit les requêtes compatibles avec l'API OpenAI standard.
2. La requête est streamée vers le worker Colab.
3. Les tokens sont retransmis en streaming mot à mot vers l'outil client externe (Cursor, Continue, scripts).

### 3.3. Modularité Atomique UI & Registre de Paramètres
1. Zéro page ou écran codé en dur : chaque bouton/contrôle de paramètre est une entité composant isolée (1 fichier = 1 responsabilité).
2. Paramètres universels (tirages `⚏ 1`–`4`, prompt) injectés automatiquement dans tous les groupes.
3. Contrôles spécifiques montés dynamiquement selon les capacités (`capabilities`) du modèle actif : Mode Ingrédients (Dataset Bible, vidéo précédente), Frame Chaining (First/Last Frame avec règle de subsomption), durée (intervalle continu ou paliers discrets), résolutions et audio natif.

### 3.4. Alignement Architectural Google Flow Pro
1. **Fiches Personnages & Acteurs récurrents** :
   - 6 archétypes dramatiques fondamentaux (`The Eccentric`, `The Professional`, `The Wildcard`, `The Familiar`, `The Wicked`, `The Fantastical`).
   - Gestionnaire d'ancres visuelles multi-angles (`visualAnchors`) injectées automatiquement sous balise `[Visual Anchors for @Nom: ...]`.
   - Profil vocal persistant (Audio Weaver) et préférence moteur dédiée par acteur.
2. **Tiroir des Instructions Agentiques (`AgentInstructionsDrawer`)** :
   - Directives empilables réordonnables (priorité ordonnée) avec bascule individuelle ON/OFF sans altérer le prompt utilisateur.
   - Injection ordonnée dans le prompt système du TaskOrchestrator dès que le commutateur `Agent [ON/OFF]` de la barre centrale est activé.
3. **Menu Popover des Ingrédients (`IngredientsPopover`)** :
   - Déclenché instantanément à la saisie de `@` ou au clic sur le bouton `@ Ingrédients`.
   - 5 onglets dédiés : *Personnages*, *Images*, *Vidéos*, *Voix*, *Uploads & Brand Kits*.
   - Recherche en temps réel et injection directe du tag d'actif correspondant dans le prompt.
4. **Pilule de Sélection de Moteur Hybride (`EngineSelectorPill`)** :
   - Choix direct entre `⚡ Local (RTX 5000 Ada)` (0s latence, ComfyUI local), `☁️ Cloud API` (serveur distant Colab/RunPod) et `🔀 Hybride` (storyboard et découpage de plans sur LLM Cloud + rendu haute fidélité local).

### 3.5. Canevas Multi-Agents & Story Director (Storyboard & Chaînage Visuel)
1. **Endpoint de Découpage Narratif (`POST /api/story-director/breakdown`)** :
   - Analyse et décompose un scénario narratif complet en plans chronologiques successifs (`Plan 1`, `Plan 2`...).
   - Résolution sémantique des personnages récurrents balisés (`@Astrid`, etc.) via `characters.json`.
   - Injection automatique des ancres visuelles de continuité (`platinum braid`, `cyan glowing runes`, `silver winged armor`) et des règles temporelles inter-plans (*Shot 1: establishing shot*, *Shot 2+: camera motion cues & visual continuity*).
2. **Timeline de Storyboard (`StoryboardTimeline.tsx`)** :
   - Bandeau horizontal dynamique sous le canevas de composition `AgentsWorkspaceView`.
   - Cartes de plans consécutifs avec badges de durée (5s), type de prise de vue (`Cinematic`, etc.), indicateurs de statut (`En attente`, `En cours GPU`, `Prêt`, `Échec`).
   - Badges d'ancres visuelles par personnage pour contrôle de cohérence direct.
   - Déclencheurs de rendu individuels par plan ou globaux séquentiels (`Lancer la séquence complète`).
3. **Orchestration Hybride Swarm** :
   - Commande directe via la barre d'outils du canevas ou les slash-commands de discussion (`/story <prompt>`, `/script <prompt>`).
   - Journalisation et retour d'état en direct dans l'essaim multi-agents Hilo (Planner, Leader, Coder).

---

## 4. Contraintes Matérielles & Garde-fous d'Exécution

- **Machine Hôte** : Tout ordinateur personnel standard (PC / Mac / Linux), sans carte graphique dédiée requise.
- **Budget Mémoire Cible** : Backend FastAPI < 80 Mo RAM, Frontend statique servi par FastAPI < 50 Mo RAM.
- **Sobriété d'Exécution** : Optimisation des traitements légers en local, déport de toute l'inférence lourde sur le worker Colab.
