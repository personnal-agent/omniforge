"""Orchestrateur de tâches asynchrones et flux SSE (app/services/task_orchestrator.py)."""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import json
import logging
import time
import uuid
from collections import defaultdict
from collections.abc import AsyncGenerator
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.config import (
    AGENT_INSTRUCTIONS_FILE,
    BRAND_KITS_FILE,
    CHARACTERS_FILE,
    CONFIG_FILE,
    DATA_DIR,
    GENERATIONS_FILE,
    OUTPUTS_DIR,
    PROJECTS_FILE,
    UPLOADS_DIR,
)
from app.models.domain import (
    BrandKit,
    Generation,
    GenerationParameters,
    GenerationReferences,
    Project,
    StudioConfig,
    TaskStatus,
)
from app.services.brand_compiler import BrandContextCompiler
from app.services.worker_gateway import WorkerGateway
from app.storage.json_store import JSONDocumentStore
from app.storage.media_file_store_64k import MediaFileStore64k
from app.storage.media_store import MediaFileStore

logger = logging.getLogger(__name__)


class GenerationCreateRequest(BaseModel):
    prompt: str
    negativePrompt: str | None = None
    modelId: str
    modelName: str | None = None
    type: str = "video"
    parameters: GenerationParameters = Field(default_factory=lambda: GenerationParameters(seed=0))
    references: GenerationReferences = Field(default_factory=GenerationReferences)
    brandKitId: str | None = None
    projectId: str | None = None
    tags: list[str] = Field(default_factory=list)
    cameraAngleLabel: str | None = None
    loras: list[dict[str, Any]] = Field(default_factory=list)


class TaskOrchestrator:
    """Service d'orchestration asynchrone des générations et diffusion SSE."""

    def __init__(
        self,
        json_store: JSONDocumentStore | None = None,
        media_store: MediaFileStore | None = None,
        worker_gateway: WorkerGateway | None = None,
        brand_compiler: BrandContextCompiler | None = None,
        poll_interval: float = 1.0,
        task_timeout: float = 1200.0,
    ) -> None:
        self._json_store = json_store or JSONDocumentStore(DATA_DIR)
        self._media_store = media_store or MediaFileStore(OUTPUTS_DIR)
        self._gateway = worker_gateway or WorkerGateway(self._json_store)
        self._compiler = brand_compiler or BrandContextCompiler()
        self._poll_interval = poll_interval
        self._task_timeout = task_timeout
        self.coordination_lock: asyncio.Lock = asyncio.Lock()

        self._active_tasks: dict[str, asyncio.Task[None]] = {}
        self._listeners: dict[str, list[asyncio.Queue[dict[str, Any]]]] = defaultdict(list)
        self._cancel_events: dict[str, asyncio.Event] = {}

    async def get_task(self, task_id: str) -> Generation | None:
        """Récupère une génération par son identifiant."""
        gens = await self._json_store.read_list(GENERATIONS_FILE.name)
        match = next((g for g in gens if g.get("id") == task_id), None)
        return Generation.model_validate(match) if match else None

    async def submit_generation(self, req: GenerationCreateRequest) -> Generation:
        """Crée une tâche de génération, compile la marque si demandée et lance le worker."""
        async with self.coordination_lock:
            cfg_dict = await self._json_store.read_dict(
                CONFIG_FILE.name, default=StudioConfig().model_dump()
            )
            cfg = StudioConfig.model_validate(cfg_dict)

            worker_url = None
            if hasattr(self._gateway, "get_active_worker_url"):
                try:
                    _, worker_url = await self._gateway.get_active_worker_url()
                except Exception:
                    worker_url = None
            else:
                worker_url = getattr(self._gateway, "base_url", "http://127.0.0.1:8190")

            kit: BrandKit | None = None
            if req.brandKitId:
                kits = await self._json_store.read_list(BRAND_KITS_FILE.name)
                match = next((k for k in kits if k.get("id") == req.brandKitId), None)
                if match:
                    kit = BrandKit.model_validate(match)

            max_image_refs = 4
            if req.type == "text":
                max_image_refs = 0
            else:
                found_in_catalog = False
                try:
                    models = await self._gateway.list_models()
                    m_info = next((m for m in models if m.get("id") == req.modelId), None)
                    if m_info:
                        found_in_catalog = True
                        if m_info.get("type") == "text":
                            max_image_refs = 0
                        else:
                            caps = m_info.get("capabilities", {})
                            max_image_refs = (
                                caps.get("maxImageRefs", 4)
                                if caps.get("supportsImageRef", True)
                                else 0
                            )
                except Exception as e:
                    logger.debug("Échec détection capacités modèle %s : %s", req.modelId, e)

                if not found_in_catalog and (
                    "text" in req.modelId.lower() or "llm" in req.modelId.lower()
                ):
                    max_image_refs = 0

            # Compilation des Fiches Personnages (@Nom) (Module B)
            from app.api.routes_characters import compile_character_mentions

            chars_raw = await self._json_store.read_list(CHARACTERS_FILE.name)
            char_prompt, matched_char_ids, matched_char_imgs, char_seed = (
                compile_character_mentions(req.prompt, chars_raw)
            )
            if char_seed and (req.parameters.seed is None or req.parameters.seed <= 0):
                req.parameters.seed = char_seed

            # Compilation du Brand Kit avec llm_config
            compiled = await self._compiler.compile(
                prompt=char_prompt,
                brand_kit=kit,
                user_refs=req.references.imageRefs,
                max_image_refs=max_image_refs,
                llm_config=cfg.compilerLlm,
            )

            # Injection des Directives Agent actives (Module Google Flow Pro)
            if getattr(req.parameters, "agentEnabled", False):
                inst_raw = await self._json_store.read_list(AGENT_INSTRUCTIONS_FILE.name)
                active_ids = getattr(req.parameters, "activeInstructionIds", None)
                active_inst = [
                    i
                    for i in inst_raw
                    if i.get("isActive", True)
                    and (not active_ids or i.get("id") in active_ids)
                ]
                active_inst.sort(key=lambda x: int(x.get("order", 0)))
                if active_inst:
                    directives_lines = [
                        f"- {i.get('title')}: {i.get('description')}"
                        for i in active_inst
                    ]
                    directives_block = (
                        f"[Active Agent Directives:\n{chr(10).join(directives_lines)}]"
                    )
                    compiled = dataclasses.replace(
                        compiled, prompt=f"{directives_block} {compiled.prompt}"
                    )

            # Routage Moteur Hybride (Local GPU RTX 5000 Ada vs Cloud API)
            pref = getattr(req.parameters, "enginePreference", None)
            if pref == "local":
                worker_url = getattr(self._gateway, "local_url", "http://127.0.0.1:8190")
            elif pref == "cloud" and hasattr(self._gateway, "get_colab_worker_url"):
                with contextlib.suppress(Exception):
                    c_url = await self._gateway.get_colab_worker_url()
                    if c_url:
                        worker_url = c_url

            from app.services.story_director import StoryDirector, parse_explicit_script_segments

            _, explicit_segs = parse_explicit_script_segments(char_prompt)
            has_explicit_script = len(explicit_segs) >= 2

            is_auto_timeline = (
                (req.parameters.duration or "").strip().lower() == "auto"
                or getattr(req.parameters, "chaining", False) is True
                or has_explicit_script
            )
            script_plan = None
            if is_auto_timeline:
                director = StoryDirector()
                script_plan = await director.plan_timeline(char_prompt, max_segment_sec=10.0)
                if matched_char_ids and script_plan.segments:
                    for seg_obj in script_plan.segments:
                        seg_compiled, _, _, _ = compile_character_mentions(
                            seg_obj.action_prompt, chars_raw
                        )
                        seg_obj.action_prompt = seg_compiled
                req.parameters.duration = f"{script_plan.total_duration_sec:.0f}s"
                req.parameters.scriptPlan = script_plan.model_dump()
                req.parameters.chaining = True

            gen_id = f"gen_{uuid.uuid4().hex[:10]}"
            refs = req.references.model_copy()
            # Remplacement systématique de refs.imageRefs par le résultat compilé (même vide)
            refs.imageRefs = compiled.image_refs
            for c_img in matched_char_imgs:
                if c_img and c_img not in refs.imageRefs and len(refs.imageRefs) < max_image_refs:
                    refs.imageRefs.append(c_img)
                if c_img and not refs.startFrame and req.type == "video":
                    refs.startFrame = c_img

            # Résolution de la source d'upscaling
            if refs.upscaleSource:
                src = refs.upscaleSource.strip()
                gen_match_id = None
                if "/api/generations/" in src and "/file" in src:
                    gen_match_id = src.split("/api/generations/")[1].split("/")[0]
                elif src.startswith("gen_") and len(src) <= 20:
                    gen_match_id = src

                if gen_match_id:
                    all_gens = await self._json_store.read_list(GENERATIONS_FILE.name)
                    found_gen = next((g for g in all_gens if g.get("id") == gen_match_id), None)
                    if found_gen and found_gen.get("filePath"):
                        refs.upscaleSource = found_gen["filePath"]
                elif "/api/uploads/" in src:
                    fn = src.split("/api/uploads/")[1]
                    up_p = UPLOADS_DIR / fn
                    is_f = await asyncio.to_thread(up_p.is_file)
                    if is_f:
                        refs.upscaleSource = str(up_p.resolve())

            seq_total = script_plan.num_segments if script_plan else None
            seq_idx = 1 if (seq_total and seq_total > 1) else None
            seq_id = gen_id if (seq_total and seq_total > 1) else None
            initial_prompt = (
                script_plan.segments[0].action_prompt
                if (script_plan and seq_total and seq_total > 1)
                else req.prompt
            )

            auto_tags = list(req.tags or [])
            if seq_total and seq_total > 1 and "chained-series" not in auto_tags:
                auto_tags.append("chained-series")

            gen = Generation(
                id=gen_id,
                status=TaskStatus.PENDING,
                mediaType=req.type,
                prompt=initial_prompt,
                negativePrompt=req.negativePrompt or compiled.negative_prompt,
                compiledPrompt=initial_prompt if (seq_total and seq_total > 1) else compiled.prompt,
                modelId=req.modelId,
                modelName=req.modelName or req.modelId,
                parameters=req.parameters,
                references=refs,
                brandKitSnapshot=compiled.snapshot,
                tags=auto_tags,
                characterIds=matched_char_ids,
                cameraAngleLabel=req.cameraAngleLabel,
                projectId=req.projectId,
                progress=0,
                workerUrl=worker_url,
                sequenceId=seq_id,
                sequenceIndex=seq_idx,
                sequenceTotal=seq_total,
            )

            async with self._json_store.lock_for(GENERATIONS_FILE.name):
                gens = await self._json_store.read_list_unlocked(GENERATIONS_FILE.name)
                gens.insert(0, gen.model_dump())
                await self._json_store.write_list_unlocked(GENERATIONS_FILE.name, gens)

            self._cancel_events[gen_id] = asyncio.Event()
            bg_task = asyncio.create_task(self._run_task(gen_id, req, gen))
            self._active_tasks[gen_id] = bg_task

            return gen

    async def wait_task(self, task_id: str, timeout: float = 10.0) -> None:
        """Attente de fin d'une tâche de fond (utilitaire de synchronisation)."""
        task = self._active_tasks.get(task_id)
        if task:
            with contextlib.suppress(asyncio.TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(task), timeout=timeout)

    async def _emit_event(self, task_id: str, event: dict[str, Any]) -> None:
        """Diffuse un événement à tous les clients abonnés au flux SSE de cette tâche."""
        for queue in list(self._listeners.get(task_id, [])):
            await queue.put(event)

    async def _update_generation(
        self, gen_id: str, allow_from_terminal: bool = False, **kwargs: Any
    ) -> Generation | None:
        """Met à jour atomiquement une génération en sanctuarisant les états terminaux."""
        async with self._json_store.lock_for(GENERATIONS_FILE.name):
            gens = await self._json_store.read_list_unlocked(GENERATIONS_FILE.name)
            for idx, g in enumerate(gens):
                if g.get("id") == gen_id:
                    old_status = g.get("status")
                    terminal_statuses = {
                        TaskStatus.COMPLETED.value,
                        TaskStatus.CANCELLED.value,
                        TaskStatus.FAILED.value,
                    }
                    if not allow_from_terminal and old_status in terminal_statuses:
                        logger.warning(
                            "Tâche %s déjà dans l'état terminal '%s'. Rejet écrasement vers '%s'.",
                            gen_id,
                            old_status,
                            kwargs.get("status"),
                        )
                        return Generation.model_validate(g)

                    clean_kwargs: dict[str, Any] = {}
                    for k, v in kwargs.items():
                        if hasattr(v, "model_dump"):
                            clean_kwargs[k] = v.model_dump()
                        else:
                            clean_kwargs[k] = v
                    g.update(clean_kwargs)
                    gens[idx] = g
                    await self._json_store.write_list_unlocked(GENERATIONS_FILE.name, gens)
                    return Generation.model_validate(g)
        return None

    async def _run_task(self, gen_id: str, req: GenerationCreateRequest, gen: Generation) -> None:
        """Cycle de vie asynchrone d'exécution de la tâche."""
        cancel_evt = self._cancel_events.get(gen_id) or asyncio.Event()
        start_time = time.monotonic()
        target_worker_url = gen.workerUrl

        try:
            # 1. Passage à RUNNING
            await self._update_generation(gen_id, status=TaskStatus.RUNNING.value, progress=5)
            await self._emit_event(gen_id, {"type": "running", "status": "running", "progress": 5})

            # 2. Soumission au worker
            task_spec = {
                "taskId": gen_id,
                "prompt": gen.compiledPrompt or gen.prompt,
                "negativePrompt": gen.negativePrompt,
                "modelId": gen.modelId,
                "type": gen.mediaType,
                "parameters": gen.parameters.model_dump(),
                "references": gen.references.model_dump(),
                "loras": req.loras,
            }
            await self._gateway.infer(task_spec, base_url=target_worker_url)

            # Résolution préalable du projet
            project: Project | None = None
            if gen.projectId:
                projects = await self._json_store.read_list(PROJECTS_FILE.name)
                p_dict = next((p for p in projects if p.get("id") == gen.projectId), None)
                if p_dict:
                    project = Project.model_validate(p_dict)

            # 3. Boucle de suivi d'avancement
            synced_segments: set[int] = set()
            last_progress_time = time.monotonic()
            last_seen_progress = 0
            total_segs_planned = 1
            consecutive_status_errors = 0
            if gen.parameters and gen.parameters.scriptPlan:
                total_segs_planned = int(gen.parameters.scriptPlan.get("num_segments", 1))

            # Timeout dynamique par segment (1200s par défaut sur GPU local)
            segment_timeout = self._task_timeout
            overall_timeout = segment_timeout * max(1, total_segs_planned)

            while True:
                if cancel_evt.is_set():
                    logger.info("Tâche %s interrompue par annulation utilisateur", gen_id)
                    break

                now = time.monotonic()
                if (now - last_progress_time) > segment_timeout or (
                    now - start_time
                ) > overall_timeout:
                    with contextlib.suppress(Exception):
                        await self._gateway.cancel_task(gen_id, base_url=target_worker_url)
                    raise TimeoutError(
                        f"Timeout d'exécution dépassé (inactivité="
                        f"{now - last_progress_time:.0f}s, total={now - start_time:.0f}s)"
                    )

                try:
                    status_resp = await self._gateway.get_task_status(
                        gen_id, base_url=target_worker_url
                    )
                    consecutive_status_errors = 0
                except Exception as we:
                    consecutive_status_errors += 1
                    logger.warning(
                        "Glitch temporaire get_task_status pour %s (%d/5) : %s",
                        gen_id,
                        consecutive_status_errors,
                        we,
                    )
                    if consecutive_status_errors >= 5:
                        raise
                    await asyncio.sleep(self._poll_interval)
                    continue
                remote_status = status_resp.get("status")
                progress_pct = status_resp.get("progress", 0)
                if progress_pct != last_seen_progress:
                    last_seen_progress = progress_pct
                    last_progress_time = now

                # Traitement incrémental des segments complétés (chaînage)
                remote_anchors = status_resp.get("characterAnchors")
                if remote_anchors and not getattr(gen.parameters, "characterAnchors", None):
                    gen.parameters.characterAnchors = remote_anchors
                    await self._update_generation(
                        gen_id,
                        allow_from_terminal=True,
                        parameters=gen.parameters.model_dump(),
                    )

                completed_segs = status_resp.get("completedSegments") or []
                for seg in completed_segs:
                    idx = seg.get("index")
                    if idx and idx not in synced_segments:
                        synced_segments.add(idx)
                        last_progress_time = (
                            time.monotonic()
                        )  # Réinitialise le watchdog pour le plan suivant
                        total_segs = seg.get("total", 1)
                        seg_dur = seg.get("duration", "10s")
                        seg_prompt = seg.get("prompt", gen.prompt)
                        seg_file_path = seg.get("filePath")
                        part_filename = seg.get("filename") or f"{gen_id}_p{idx:02d}.mp4"

                        # Résolution du fichier sur disque ou rapatriement
                        def _check_local_file(p_str: str) -> str | None:
                            p_obj = Path(p_str).resolve()
                            return str(p_obj) if p_obj.is_file() else None

                        dest_file_path = seg_file_path
                        if seg_file_path:
                            local_resolved = await asyncio.to_thread(
                                _check_local_file, seg_file_path
                            )
                            if local_resolved:
                                dest_file_path = local_resolved
                            else:
                                with contextlib.suppress(Exception):
                                    part_bytes = await self._gateway.download_file(
                                        part_filename, base_url=target_worker_url
                                    )
                                    dest_file_path, _ = await self._media_store.save_media(
                                        filename=part_filename,
                                        content=part_bytes,
                                        project=project,
                                    )
                        else:
                            with contextlib.suppress(Exception):
                                part_bytes = await self._gateway.download_file(
                                    part_filename, base_url=target_worker_url
                                )
                                dest_file_path, _ = await self._media_store.save_media(
                                    filename=part_filename,
                                    content=part_bytes,
                                    project=project,
                                )

                        if idx == 1 and total_segs > 1:
                            await self._update_generation(
                                gen_id,
                                allow_from_terminal=True,
                                status=TaskStatus.RUNNING.value,
                                progress=int(round(idx / total_segs * 100)),
                                filePath=dest_file_path,
                            )
                        elif idx > 1:
                            sub_gen_id = f"{gen_id}_p{idx:02d}"
                            sub_params = gen.parameters.model_copy()
                            sub_params.duration = seg_dur
                            sub_gen = Generation(
                                id=sub_gen_id,
                                status=TaskStatus.COMPLETED,
                                mediaType=gen.mediaType,
                                prompt=seg_prompt,
                                compiledPrompt=seg_prompt,
                                modelId=gen.modelId,
                                modelName=gen.modelName,
                                parameters=sub_params,
                                references=gen.references,
                                brandKitSnapshot=gen.brandKitSnapshot,
                                tags=list(gen.tags or []),
                                characterIds=list(gen.characterIds or []),
                                projectId=gen.projectId,
                                progress=100,
                                filePath=dest_file_path,
                                workerUrl=gen.workerUrl,
                                sequenceId=gen_id,
                                sequenceIndex=idx,
                                sequenceTotal=total_segs,
                            )
                            async with self._json_store.lock_for(GENERATIONS_FILE.name):
                                cur_gens = await self._json_store.read_list_unlocked(
                                    GENERATIONS_FILE.name
                                )
                                if not any(g.get("id") == sub_gen_id for g in cur_gens):
                                    cur_gens.insert(0, sub_gen.model_dump())
                                    await self._json_store.write_list_unlocked(
                                        GENERATIONS_FILE.name, cur_gens
                                    )

                        step_msg = f"Plan {idx}/{total_segs} généré avec succès"
                        await self._emit_event(
                            gen_id,
                            {
                                "type": "segment_completed",
                                "status": "running" if idx < total_segs else "completed",
                                "progress": progress_pct,
                                "step": step_msg,
                                "segment": seg,
                                "taskId": gen_id,
                            },
                        )

                if remote_status == "running":
                    await self._update_generation(
                        gen_id,
                        allow_from_terminal=True,
                        status=TaskStatus.RUNNING.value,
                        progress=progress_pct,
                    )
                    await self._emit_event(
                        gen_id,
                        {
                            "type": "running",
                            "status": "running",
                            "progress": progress_pct,
                            "step": status_resp.get("step"),
                        },
                    )
                elif remote_status == "cancelled":
                    up = await self._update_generation(
                        gen_id,
                        status=TaskStatus.CANCELLED.value,
                        errorMessage="Annulée sur le worker distant",
                    )
                    if up and up.status == TaskStatus.CANCELLED:
                        await self._emit_event(
                            gen_id, {"type": "cancelled", "status": "cancelled", "taskId": gen_id}
                        )
                    break
                elif remote_status == "completed":
                    if cancel_evt.is_set():
                        up = await self._update_generation(
                            gen_id,
                            status=TaskStatus.CANCELLED.value,
                            errorMessage="Annulée par l'utilisateur",
                        )
                        if up and up.status == TaskStatus.CANCELLED:
                            await self._emit_event(
                                gen_id,
                                {"type": "cancelled", "status": "cancelled", "taskId": gen_id},
                            )
                        break

                    # En mode chaînage multi-plans, tous les segments ont déjà été persistés
                    if len(synced_segments) > 1:
                        final_anchors = status_resp.get("characterAnchors") or getattr(
                            gen.parameters, "characterAnchors", None
                        )
                        if final_anchors:
                            gen.parameters.characterAnchors = final_anchors
                        await self._update_generation(
                            gen_id,
                            allow_from_terminal=True,
                            status=TaskStatus.COMPLETED.value,
                            progress=100,
                            parameters=gen.parameters.model_dump(),
                        )
                        await self._emit_event(
                            gen_id,
                            {
                                "type": "completed",
                                "status": "completed",
                                "progress": 100,
                                "taskId": gen_id,
                            },
                        )
                        break

                    # Rapatriement du binaire standard (mode simple)
                    artifact_uri = status_resp.get("artifactUri")
                    if not artifact_uri:
                        output_url = status_resp.get("outputUrl", "")
                        if output_url.startswith("/files/"):
                            artifact_uri = output_url[len("/files/") :]
                        else:
                            ext = "png" if gen.mediaType == "image" else "mp4"
                            artifact_uri = f"{gen_id}.{ext}"
                    media_bytes = await self._gateway.download_file(
                        artifact_uri, base_url=target_worker_url
                    )

                    if cancel_evt.is_set():
                        await self._update_generation(
                            gen_id,
                            status=TaskStatus.CANCELLED.value,
                            errorMessage="Annulée par l'utilisateur",
                        )
                        await self._emit_event(
                            gen_id,
                            {"type": "cancelled", "status": "cancelled", "taskId": gen_id},
                        )
                        break

                    # Résolution du projet et sauvegarde
                    project: Project | None = None
                    if gen.projectId:
                        projects = await self._json_store.read_list(PROJECTS_FILE.name)
                        p_dict = next((p for p in projects if p.get("id") == gen.projectId), None)
                        if p_dict:
                            project = Project.model_validate(p_dict)

                    if artifact_uri and "." in artifact_uri:
                        ext = artifact_uri.split(".")[-1].lower()
                    else:
                        is_v = (
                            gen.mediaType in {"video", "lipsync"}
                            or gen.references.upscaleSourceType == "video"
                        )
                        ext = "mp4" if is_v else "png"
                    filename = f"{gen_id}.{ext}"
                    op_id = f"op_{gen_id}"
                    if isinstance(self._media_store, MediaFileStore64k):
                        temp_path, digest, size = await self._media_store.stream_write_temp(
                            filename, [media_bytes], project=project
                        )
                        resource_key = f"{gen.projectId or 'default'}::{gen_id}::primary"
                        await self._media_store.stage_operation(
                            operation_id=op_id,
                            resource_key=resource_key,
                            temp_path=temp_path,
                            final_filename=filename,
                            sha256_digest=digest,
                            byte_size=size,
                            project=project,
                        )
                        published_str = await self._media_store.publish_no_replace(op_id)
                        dest_file = Path(published_str)
                        await self._media_store.commit_operation(op_id)
                        thumb_file = None
                    else:
                        dest_file, thumb_file = await self._media_store.save_media(
                            filename, media_bytes, project=project
                        )

                    if cancel_evt.is_set():
                        if isinstance(self._media_store, MediaFileStore64k):
                            await self._media_store.abort_and_compensate(op_id)
                        else:
                            dest_file.unlink(missing_ok=True)
                            if thumb_file:
                                thumb_file.unlink(missing_ok=True)
                        await self._update_generation(
                            gen_id,
                            status=TaskStatus.CANCELLED.value,
                            errorMessage="Annulée par l'utilisateur",
                        )
                        await self._emit_event(
                            gen_id,
                            {"type": "cancelled", "status": "cancelled", "taskId": gen_id},
                        )
                        break

                    saved_gen = await self._update_generation(
                        gen_id,
                        status=TaskStatus.COMPLETED.value,
                        filePath=str(dest_file),
                        thumbnailPath=str(thumb_file) if thumb_file else None,
                        progress=100,
                    )
                    # Si l'annulation a gagné entre-temps sous le verrou
                    if saved_gen and saved_gen.status == TaskStatus.CANCELLED:
                        if isinstance(self._media_store, MediaFileStore64k):
                            await self._media_store.abort_and_compensate(op_id)
                        else:
                            dest_file.unlink(missing_ok=True)
                            if thumb_file:
                                thumb_file.unlink(missing_ok=True)
                        break

                    await self._emit_event(
                        gen_id,
                        {
                            "type": "completed",
                            "status": "completed",
                            "progress": 100,
                            "filePath": str(dest_file),
                            "generation": (saved_gen.model_dump() if saved_gen else None),
                        },
                    )
                    break
                elif remote_status == "failed":
                    err_msg = (
                        status_resp.get("error")
                        or status_resp.get("errorMessage")
                        or "Erreur distante inconnue"
                    )
                    with contextlib.suppress(Exception):
                        await self._gateway.cancel_task(gen_id, base_url=target_worker_url)
                    up = await self._update_generation(
                        gen_id, status=TaskStatus.FAILED.value, errorMessage=err_msg
                    )
                    if up and up.status == TaskStatus.FAILED:
                        await self._emit_event(
                            gen_id, {"type": "failed", "status": "failed", "error": err_msg}
                        )
                    break

                await asyncio.sleep(self._poll_interval)

        except Exception as e:
            if not cancel_evt.is_set():
                logger.exception("Échec exécution tâche %s : %s", gen_id, e)
                with contextlib.suppress(Exception):
                    await self._gateway.cancel_task(gen_id, base_url=target_worker_url)
                if len(synced_segments) > 0:
                    logger.info(
                        "Tâche %s interrompue mais %d segments ont été sauvés.",
                        gen_id,
                        len(synced_segments),
                    )
                    await self._emit_event(
                        gen_id,
                        {
                            "type": "completed",
                            "status": "completed",
                            "progress": 100,
                            "taskId": gen_id,
                        },
                    )
                else:
                    up = await self._update_generation(
                        gen_id,
                        allow_from_terminal=True,
                        status=TaskStatus.FAILED.value,
                        errorMessage=str(e),
                    )
                    if up and up.status == TaskStatus.FAILED:
                        await self._emit_event(
                            gen_id, {"type": "failed", "status": "failed", "error": str(e)}
                        )
        finally:
            self._active_tasks.pop(gen_id, None)
            if not self._listeners.get(gen_id):
                self._cancel_events.pop(gen_id, None)

    async def subscribe_task(
        self, task_id: str, keepalive_timeout: float = 15.0
    ) -> AsyncGenerator[str, None]:
        """Générateur SSE pour streamer les événements d'une tâche avec keep-alive."""
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._listeners[task_id].append(queue)

        def _sse_event(g: dict[str, Any]) -> str:
            st = g.get("status")
            p = {
                "type": st,
                "status": st,
                "progress": g.get("progress", 0),
                "filePath": g.get("filePath"),
                "error": g.get("errorMessage"),
                "generation": g,
            }
            return f"event: {st}\ndata: {json.dumps(p)}\n\n"

        try:
            gens = await self._json_store.read_list(GENERATIONS_FILE.name)
            current = next((g for g in gens if g.get("id") == task_id), None)
            if current:
                cur_status = current.get("status")
                yield _sse_event(current)
                if cur_status in {
                    TaskStatus.COMPLETED.value,
                    TaskStatus.FAILED.value,
                    TaskStatus.CANCELLED.value,
                }:
                    return

            while True:
                # Dépiler d'abord tous les événements disponibles dans la file
                while not queue.empty():
                    event = queue.get_nowait()
                    ev_type = event.get("type", "message")
                    yield f"event: {ev_type}\ndata: {json.dumps(event)}\n\n"
                    if ev_type in {"completed", "failed", "cancelled"}:
                        return

                # Si la tâche n'est plus active en arrière-plan, vérifier l'état persistant final
                if task_id not in self._active_tasks:
                    gens = await self._json_store.read_list(GENERATIONS_FILE.name)
                    latest = next((g for g in gens if g.get("id") == task_id), None)
                    if latest and latest.get("status") in {
                        TaskStatus.COMPLETED.value,
                        TaskStatus.FAILED.value,
                        TaskStatus.CANCELLED.value,
                    }:
                        yield _sse_event(latest)
                    return

                try:
                    event = await asyncio.wait_for(queue.get(), timeout=keepalive_timeout)
                    ev_type = event.get("type", "message")
                    yield f"event: {ev_type}\ndata: {json.dumps(event)}\n\n"
                    if ev_type in {"completed", "failed", "cancelled"}:
                        break
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            if task_id in self._listeners:
                if queue in self._listeners[task_id]:
                    self._listeners[task_id].remove(queue)
                if not self._listeners[task_id]:
                    self._listeners.pop(task_id, None)
                    if task_id not in self._active_tasks:
                        self._cancel_events.pop(task_id, None)

    async def cancel_task(self, task_id: str) -> dict[str, Any]:
        """Annule une tâche de façon idempotente et atomique."""
        evt = self._cancel_events.get(task_id)
        if evt:
            evt.set()

        worker_url = None
        async with self._json_store.lock_for(GENERATIONS_FILE.name):
            gens = await self._json_store.read_list_unlocked(GENERATIONS_FILE.name)
            target = next((g for g in gens if g.get("id") == task_id), None)
            if not target:
                return {"status": "not_found", "taskId": task_id}

            cur_status = target.get("status")
            if cur_status in {
                TaskStatus.COMPLETED.value,
                TaskStatus.CANCELLED.value,
                TaskStatus.FAILED.value,
            }:
                return {
                    "status": cur_status,
                    "taskId": task_id,
                    "detail": f"Tâche déjà dans l'état terminal '{cur_status}'",
                }

            worker_url = target.get("workerUrl")
            target["status"] = TaskStatus.CANCELLED.value
            target["errorMessage"] = "Annulée par l'utilisateur"
            await self._json_store.write_list_unlocked(GENERATIONS_FILE.name, gens)

        # Notification au worker en dehors du verrou
        if worker_url:
            await self._gateway.cancel_task(task_id, base_url=worker_url)
        else:
            await self._gateway.cancel_task(task_id)

        await self._emit_event(
            task_id,
            {
                "type": "cancelled",
                "status": "cancelled",
                "taskId": task_id,
            },
        )

        return {"status": "cancelled", "taskId": task_id}

    async def aclose(self) -> None:
        """Ferme proprement l'orchestrateur, annule les tâches actives et ferme la passerelle."""
        for _tid, task in list(self._active_tasks.items()):
            task.cancel()
        if self._active_tasks:
            await asyncio.gather(*self._active_tasks.values(), return_exceptions=True)
        self._active_tasks.clear()
        self._listeners.clear()
        self._cancel_events.clear()
        await self._gateway.aclose()
