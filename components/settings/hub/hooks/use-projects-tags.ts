"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, type Project, type Tag } from "@/lib/api-client";
import { useSettingsContext } from "../settings-context";
import { cacheRead, cacheWrite } from "./settings-cache";

export type ProjectsTagsState = {
  projects: Project[];
  tags: Tag[];
  loadingProjects: boolean;
  loadingTags: boolean;
  upsertProject: (project: Project) => void;
  upsertTag: (tag: Tag) => void;
  deleteProject: (project: Project) => Promise<void>;
  deleteTag: (tag: Tag) => Promise<void>;
};

export function useProjectsTags(): ProjectsTagsState {
  const { revision, organizationId } = useSettingsContext();
  const projectsKey = organizationId ? `projects:${organizationId}` : null;
  const tagsKey = organizationId ? `tags:${organizationId}` : null;
  const [projects, setProjects] = useState<Project[]>(
    () => cacheRead<Project[]>(projectsKey) ?? []
  );
  const [tags, setTags] = useState<Tag[]>(() => cacheRead<Tag[]>(tagsKey) ?? []);
  const [loadingProjects, setLoadingProjects] = useState(
    () => cacheRead(projectsKey) === undefined
  );
  const [loadingTags, setLoadingTags] = useState(
    () => cacheRead(tagsKey) === undefined
  );

  const load = useCallback(async (): Promise<void> => {
    try {
      const nextProjects = await api.project.getAll();
      setProjects(nextProjects);
      cacheWrite(projectsKey, nextProjects);
    } catch {
      toast.error("Failed to load projects");
    } finally {
      setLoadingProjects(false);
    }
    try {
      const nextTags = await api.tag.getAll();
      setTags(nextTags);
      cacheWrite(tagsKey, nextTags);
    } catch {
      toast.error("Failed to load tags");
    } finally {
      setLoadingTags(false);
    }
  }, [projectsKey, tagsKey]);

  useEffect(() => {
    load().catch(() => undefined);
  }, [load, revision]);

  const upsertProject = useCallback((project: Project): void => {
    setProjects((prev) =>
      prev.some((p) => p.id === project.id)
        ? prev.map((p) => (p.id === project.id ? { ...p, ...project } : p))
        : [...prev, project]
    );
  }, []);

  const upsertTag = useCallback((tag: Tag): void => {
    setTags((prev) =>
      prev.some((t) => t.id === tag.id)
        ? prev.map((t) => (t.id === tag.id ? { ...t, ...tag } : t))
        : [...prev, tag]
    );
  }, []);

  const deleteProject = useCallback(async (project: Project): Promise<void> => {
    try {
      await api.project.delete(project.id);
      setProjects((prev) => prev.filter((p) => p.id !== project.id));
      toast.success(`Deleted ${project.name}`);
    } catch {
      toast.error("Failed to delete project");
    }
  }, []);

  const deleteTag = useCallback(async (tag: Tag): Promise<void> => {
    try {
      await api.tag.delete(tag.id);
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      toast.success(`Deleted ${tag.name}`);
    } catch {
      toast.error("Failed to delete tag");
    }
  }, []);

  return {
    deleteProject,
    deleteTag,
    loadingProjects,
    loadingTags,
    projects,
    tags,
    upsertProject,
    upsertTag,
  };
}
