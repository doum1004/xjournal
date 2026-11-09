import { useQuery } from '@tanstack/react-query';
import type { ProjectView } from '@xjournal/core';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { api, type Me } from './api';

// The project the timeline and day views show. Remembered per browser.

const KEY = 'xjournal.project';

interface ProjectState {
  me: Me | undefined;
  projects: ProjectView[];
  project: ProjectView | undefined;
  setProjectId: (id: string) => void;
}

const Ctx = createContext<ProjectState | null>(null);

export function ProjectProvider({ children }: { children: ReactNode }) {
  const me = useQuery({ queryKey: ['me'], queryFn: api.me });
  const [projectId, setProjectId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null;
    }
  });
  const projects = me.data?.projects ?? [];
  const project = projects.find((p) => p.id === projectId) ?? projects[0];

  useEffect(() => {
    if (!project) return;
    try {
      localStorage.setItem(KEY, project.id);
    } catch {}
  }, [project]);

  return (
    <Ctx.Provider value={{ me: me.data, projects, project, setProjectId }}>{children}</Ctx.Provider>
  );
}

export function useProject(): ProjectState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useProject outside ProjectProvider');
  return v;
}
