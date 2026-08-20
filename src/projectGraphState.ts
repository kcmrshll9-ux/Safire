export type ProjectGraphLoadState<Graph> =
  | { status: 'idle' }
  | { status: 'loading'; projectPath: string; requestId: number; graph?: Graph }
  | { status: 'ready'; projectPath: string; requestId: number; graph: Graph }
  | { status: 'error'; projectPath: string; requestId: number; message: string; graph?: Graph };

export type ProjectGraphLoadAction<Graph> =
  | { type: 'load'; projectPath: string; requestId: number }
  | { type: 'ready'; projectPath: string; requestId: number; graph: Graph }
  | { type: 'error'; projectPath: string; requestId: number; message: string };

export function projectGraphLoadReducer<Graph>(state: ProjectGraphLoadState<Graph>, action: ProjectGraphLoadAction<Graph>): ProjectGraphLoadState<Graph> {
  if (action.type === 'load') {
    const graph = state.status !== 'idle' && state.projectPath === action.projectPath ? state.graph : undefined;
    return { status: 'loading', projectPath: action.projectPath, requestId: action.requestId, ...(graph ? { graph } : {}) };
  }
  if (state.status === 'idle' || state.projectPath !== action.projectPath || state.requestId !== action.requestId) {
    return state;
  }
  if (action.type === 'ready') {
    return { status: 'ready', projectPath: action.projectPath, requestId: action.requestId, graph: action.graph };
  }
  return {
    status: 'error',
    projectPath: action.projectPath,
    requestId: action.requestId,
    message: action.message,
    ...(state.graph ? { graph: state.graph } : {}),
  };
}
