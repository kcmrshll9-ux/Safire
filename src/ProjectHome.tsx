import React from 'react';
import { GraphView, type GraphData } from './GraphView';
import { OverflowMenu } from './OverflowMenu';
import { projectGraphLoadReducer, type ProjectGraphLoadState } from './projectGraphState';
import { projectEntries, projectSummaries, type ProjectNote, type ProjectTreeNode } from './projectModel';

type ProjectHomeProps = {
  hidden: boolean;
  tree: ProjectTreeNode[];
  notes: ProjectNote[];
  activePath: string;
  selectedProjectPath: string | null;
  projectView: 'entries' | 'graph';
  graphRefreshRevision: number;
  showGraphPrompt: boolean;
  projectIndexComplete: boolean;
  dailyNotesFolder?: string;
  onSelectProject: (projectPath: string | null) => void;
  onSetProjectView: (view: 'entries' | 'graph') => void;
  onCreateProject: () => Promise<string | null>;
  onCreateEntry: (projectPath: string, suggestedName?: string) => Promise<void>;
  onDeleteEntry: (path: string) => Promise<boolean>;
  onOpenEntry: (path: string, mode: 'preview' | 'edit') => void | Promise<void>;
  loadProjectGraph: (projectPath: string, activePath: string) => Promise<GraphData>;
};

function entryLabel(path: string, projectPath: string) {
  const relative = path.slice(projectPath.length + 1);
  return relative.replace(/\.md$/i, '');
}

function updatedLabel(timestamp: number | null) {
  if (!timestamp) return 'No entries yet';
  return `Updated ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(timestamp))}`;
}

export function ProjectHome({ hidden, tree, notes, activePath, selectedProjectPath, projectView, graphRefreshRevision, showGraphPrompt, projectIndexComplete, dailyNotesFolder, onSelectProject, onSetProjectView, onCreateProject, onCreateEntry, onDeleteEntry, onOpenEntry, loadProjectGraph }: ProjectHomeProps) {
  const [graphState, dispatchGraphState] = React.useReducer(projectGraphLoadReducer<GraphData>, { status: 'idle' } as ProjectGraphLoadState<GraphData>);
  const [graphRetry, setGraphRetry] = React.useState(0);
  const graphRequestIdRef = React.useRef(0);
  const [deleteFocusRevision, setDeleteFocusRevision] = React.useState(0);
  const projectBackRef = React.useRef<HTMLButtonElement | null>(null);
  const projectHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const homeHeadingRef = React.useRef<HTMLHeadingElement | null>(null);
  const graphPromptRef = React.useRef<HTMLParagraphElement | null>(null);
  const projectHomeRef = React.useRef<HTMLDivElement | null>(null);
  const graphReturnFocusRef = React.useRef<{ nodeId: string; element: Element | null } | null>(null);
  const wasHiddenRef = React.useRef(hidden);
  const createFirstEntryRef = React.useRef<HTMLButtonElement | null>(null);
  const projectCardRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const entryRefs = React.useRef(new Map<string, HTMLButtonElement>());
  const returnFocusProjectRef = React.useRef<string | null>(null);
  const deleteFocusRef = React.useRef<{ projectPath: string; preferredPath: string | null } | null>(null);
  const projects = React.useMemo(() => projectSummaries(tree, notes, dailyNotesFolder), [dailyNotesFolder, notes, tree]);
  const activeProject = projects.find(project => project.path === selectedProjectPath) || null;
  const resolvedActiveProjectPath = activeProject?.path || null;
  const entries = React.useMemo(
    () => activeProject ? projectEntries(notes, activeProject.path) : [],
    [activeProject, notes],
  );
  const projectGraphData = graphState.status !== 'idle' && graphState.projectPath === resolvedActiveProjectPath
    ? graphState.graph || null
    : null;
  const projectGraphActivePath = projectGraphData?.nodes.some(node => node.id === activePath)
    ? activePath
    : '';

  React.useLayoutEffect(() => {
    if (resolvedActiveProjectPath) {
      projectBackRef.current?.focus();
      return;
    }
    const returnPath = returnFocusProjectRef.current;
    if (!returnPath) return;
    (projectCardRefs.current.get(returnPath) || homeHeadingRef.current)?.focus();
    returnFocusProjectRef.current = null;
  }, [resolvedActiveProjectPath]);

  React.useLayoutEffect(() => {
    const becameVisible = wasHiddenRef.current && !hidden;
    wasHiddenRef.current = hidden;
    if (!becameVisible) return;
    const pendingGraphFocus = graphReturnFocusRef.current;
    if (pendingGraphFocus) {
      const graphNode = [...(projectHomeRef.current?.querySelectorAll<SVGElement>('[data-graph-node-id]') || [])]
        .find(node => node.dataset.graphNodeId === pendingGraphFocus.nodeId);
      const priorElement = pendingGraphFocus.element;
      const connectedPriorElement = (priorElement instanceof HTMLElement || priorElement instanceof SVGElement) && priorElement.isConnected
        ? priorElement
        : null;
      const focusTarget = graphNode
        || connectedPriorElement
        || projectHomeRef.current?.querySelector<HTMLElement>('.graph-3d-stage')
        || projectHeadingRef.current;
      focusTarget?.focus();
      graphReturnFocusRef.current = null;
      return;
    }
    if (showGraphPrompt) graphPromptRef.current?.focus();
  }, [hidden, showGraphPrompt]);

  React.useLayoutEffect(() => {
    if (!hidden && showGraphPrompt) graphPromptRef.current?.focus();
  }, [hidden, showGraphPrompt]);

  React.useLayoutEffect(() => {
    if (!deleteFocusRevision) return;
    const pending = deleteFocusRef.current;
    if (!pending || pending.projectPath !== resolvedActiveProjectPath) {
      deleteFocusRef.current = null;
      return;
    }
    const preferredEntry = pending.preferredPath ? entryRefs.current.get(pending.preferredPath) : null;
    const firstEntry = entries[0] ? entryRefs.current.get(entries[0].path) : null;
    (preferredEntry || firstEntry || createFirstEntryRef.current || projectHeadingRef.current)?.focus();
    deleteFocusRef.current = null;
  }, [deleteFocusRevision]);

  React.useEffect(() => {
    if (projectView !== 'graph' || !resolvedActiveProjectPath) return;
    const requestId = ++graphRequestIdRef.current;
    dispatchGraphState({ type: 'load', projectPath: resolvedActiveProjectPath, requestId });
    loadProjectGraph(resolvedActiveProjectPath, activePath).then(projectGraph => {
      dispatchGraphState({ type: 'ready', projectPath: resolvedActiveProjectPath, requestId, graph: projectGraph });
    }).catch(error => {
      dispatchGraphState({
        type: 'error',
        projectPath: resolvedActiveProjectPath,
        requestId,
        message: error instanceof Error ? error.message : 'Could not load the project graph.',
      });
    });
  }, [graphRefreshRevision, graphRetry, loadProjectGraph, projectView, resolvedActiveProjectPath]);

  const openGraphEntry = (path: string, mode: 'preview' | 'edit') => {
    graphReturnFocusRef.current = { nodeId: path, element: document.activeElement };
    return onOpenEntry(path, mode);
  };

  const createProject = async () => {
    const path = await onCreateProject();
    if (path) {
      onSetProjectView('entries');
      onSelectProject(path);
    }
  };

  const deleteEntry = async (entryPath: string, entryIndex: number) => {
    const pending = {
      projectPath: activeProject?.path || '',
      preferredPath: entries[entryIndex + 1]?.path || entries[entryIndex - 1]?.path || null,
    };
    deleteFocusRef.current = pending;
    const deleted = await onDeleteEntry(entryPath);
    if (!deleted) {
      if (deleteFocusRef.current === pending) deleteFocusRef.current = null;
      return;
    }
    setDeleteFocusRevision(value => value + 1);
  };

  if (activeProject) {
    return <div ref={projectHomeRef} hidden={hidden} className="home-view project-home project-detail-view">
      <header className="project-detail-header">
        <button ref={projectBackRef} type="button" className="project-back" onClick={() => { returnFocusProjectRef.current = activeProject.path; onSetProjectView('entries'); onSelectProject(null); }}>← All projects</button>
        <div>
          <span>Project</span>
          <h2 ref={projectHeadingRef} tabIndex={-1}>{activeProject.name}</h2>
          <p>{activeProject.entryCount} {activeProject.entryCount === 1 ? 'entry' : 'entries'}{projectIndexComplete ? '' : ' shown from the partial index'} inside <code>{activeProject.path}/</code></p>
        </div>
        <button type="button" className="primary-action" onClick={() => void onCreateEntry(activeProject.path)}>New entry</button>
      </header>
      {!projectIndexComplete && <p className="project-index-warning" role="status"><b>Partial project index.</b> Some entries and counts may be missing from this view.</p>}
      <div className="project-view-switch" role="group" aria-label={`${activeProject.name} view`}>
        <button type="button" aria-pressed={projectView === 'entries'} className={projectView === 'entries' ? 'on' : ''} onClick={() => onSetProjectView('entries')}>Entries</button>
        <button type="button" aria-pressed={projectView === 'graph'} className={projectView === 'graph' ? 'on' : ''} onClick={() => onSetProjectView('graph')}>Project graph</button>
      </div>
      {projectView === 'entries' ? <section className="project-entry-panel" aria-labelledby="project-entries-heading">
        <div className="project-section-heading">
          <div><span>Contents</span><h3 id="project-entries-heading">Project entries</h3></div>
          <p>{projectIndexComplete ? 'Newest activity first' : 'Partial entry list'}</p>
        </div>
        {entries.length ? <ul className="project-entry-list">
          {entries.map((entry, entryIndex) => <li key={entry.path} className="project-entry-row">
            <button ref={node => { if (node) entryRefs.current.set(entry.path, node); else entryRefs.current.delete(entry.path); }} type="button" className="project-entry-open" onClick={() => onOpenEntry(entry.path, 'edit')}>
              <span><b>{entry.title}</b><small>{entryLabel(entry.path, activeProject.path)}</small></span>
              <span className="project-entry-meta"><time dateTime={new Date(entry.mtime).toISOString()}>{updatedLabel(entry.mtime)}</time><b>Edit →</b></span>
            </button>
            <OverflowMenu label={`More actions for ${entry.title}`} items={[
              { label: 'Delete entry', hint: 'Creates a backup before removal', danger: true, onSelect: () => deleteEntry(entry.path, entryIndex) },
            ]} />
          </li>)}
        </ul> : <div className="project-empty">
          <h3>{projectIndexComplete ? 'This project is ready for its first entry' : 'No indexed entries are visible'}</h3>
          <p>{projectIndexComplete ? <>Entries are ordinary Markdown notes stored inside <code>{activeProject.path}/</code>.</> : <>The partial index may have omitted existing entries inside <code>{activeProject.path}/</code>. You can still create a new entry.</>}</p>
          <button ref={createFirstEntryRef} type="button" onClick={() => void onCreateEntry(activeProject.path)}>{projectIndexComplete ? 'Create first entry' : 'Create new entry'}</button>
        </div>}
      </section> : <section className="project-graph-panel" aria-label={`${activeProject.name} project graph`}>
        {projectGraphData?.nodes.length ? <div className="project-graph-content"><GraphView
          graph={projectGraphData}
          activePath={projectGraphActivePath}
          onPreview={path => openGraphEntry(path, 'preview')}
          onEdit={path => openGraphEntry(path, 'edit')}
          onCreateMissing={name => void onCreateEntry(activeProject.path, name)}
          eyebrow="Project graph"
          title={`${activeProject.name} connections`}
          description={`Only entries and links inside ${activeProject.path}/ appear here.`}
          scopeLabel="Project"
          projectPath={activeProject.path}
        />
        {graphState.status === 'loading' && <p className="project-graph-refresh-status" role="status">Refreshing this project’s graph…</p>}
        {graphState.status === 'error' && <p className="project-index-warning" role="alert">Could not refresh this project’s graph. The last loaded graph remains available.</p>}
        </div> : (graphState.status === 'idle' || graphState.projectPath !== activeProject.path || graphState.status === 'loading') ? <div className="project-empty project-graph-empty" role="status">
          <h3>Loading this project’s graph…</h3>
          <p>Safire is indexing only the entries and internal links inside <code>{activeProject.path}/</code>.</p>
        </div> : graphState.status === 'error' && graphState.projectPath === activeProject.path ? <div className="project-empty project-graph-empty" role="alert">
          <h3>Could not load this project’s graph</h3>
          <p>{graphState.message}</p>
          <button type="button" onClick={() => setGraphRetry(value => value + 1)}>Try again</button>
        </div> : <div className="project-empty project-graph-empty">
          <h3>{projectGraphData?.meta?.truncated ? 'No graph entries were returned' : 'No entries to graph yet'}</h3>
          <p>{projectGraphData?.meta?.truncated ? 'Safire reached an indexing safety limit, so this project graph may be incomplete.' : 'Create project entries and connect them with wikilinks. Cross-project links are excluded so every project keeps its own graph.'}</p>
          <button type="button" onClick={() => void onCreateEntry(activeProject.path)}>Create first entry</button>
        </div>}
      </section>}
    </div>;
  }

  return <div ref={projectHomeRef} hidden={hidden} className="home-view project-home">
    <header className="home-header project-home-header">
      <div>
        <span>Project workspace</span>
        <h2 ref={homeHeadingRef} tabIndex={-1}>Home</h2>
        <p>{projects.length ? `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}${projectIndexComplete ? ' in this vault.' : ' shown from the partial vault index.'}` : projectIndexComplete ? 'Create or select a vault that contains project folders.' : 'No project folders are visible in the partial vault index.'}</p>
      </div>
      <button type="button" className="primary-action" onClick={() => void createProject()}>New project</button>
    </header>
    {showGraphPrompt && <p ref={graphPromptRef} className="project-index-warning" role="status" tabIndex={-1}><b>Choose a project for its graph.</b> Each project has a separate graph; Safire never combines projects into one map.</p>}
    {!projectIndexComplete && <p className="project-index-warning" role="status"><b>Partial project index.</b> Some project cards and entry counts may be missing from Home.</p>}
    {projects.length ? <ul className="project-grid" aria-label="Projects">
      {projects.map(project => <li key={project.path}>
        <button ref={node => { if (node) projectCardRefs.current.set(project.path, node); else projectCardRefs.current.delete(project.path); }} type="button" className="project-card" onClick={() => { onSetProjectView('entries'); onSelectProject(project.path); }}>
          <span className="project-card-kind">Project</span>
          <span className="project-card-title">{project.name}</span>
          <span className="project-card-count">{project.entryCount} {project.entryCount === 1 ? 'entry' : 'entries'}{projectIndexComplete ? '' : ' shown'}</span>
          <span className="project-card-footer"><span>{updatedLabel(project.lastUpdated)}</span><b>Open →</b></span>
        </button>
      </li>)}
    </ul> : <section className="project-home-empty" aria-labelledby="project-empty-heading">
      <span>Projects live in your vault</span>
      <h3 id="project-empty-heading">{projectIndexComplete ? 'No project folders found' : 'No project folders shown'}</h3>
      <p>Home turns each top-level user folder into one project card. Notes inside that folder appear only after you open the project.</p>
      <p>If the selected vault is already one project folder, use <strong>Safire → Change Vault Location…</strong> and choose its parent folder. Safire will not move or rewrite either folder.</p>
    </section>}
  </div>;
}
