import { createContext, useContext } from 'react';
import type { Project, ProjectMemberInfo } from '../api';

export interface ProjectContextValue {
  project: Project;
  members: ProjectMemberInfo[];
  reload: () => Promise<void>;
}

export const ProjectContext = createContext<ProjectContextValue | null>(null);

export function useProject(): ProjectContextValue {
  const value = useContext(ProjectContext);
  if (!value) throw new Error('项目上下文尚未加载');
  return value;
}
