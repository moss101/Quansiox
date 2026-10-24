import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * The Projects surface.
 *
 * A project is a persistent workspace: a **master instruction** the agent
 * follows for every task inside it, plus a **knowledge base** of files the
 * task can read. The two propagate differently, and the UI says so:
 *
 *   - the instruction is live — an edit applies from your next message;
 *   - the files are frozen per task — a later upload only reaches new tasks.
 *
 * The panel also carries the sidebar task filters (All / Non-project /
 * Favorites / Scheduled) and the project list with pinning and drag-to-
 * reorder, which is how Manus organises its workspace.
 */
const FILTERS = [
  { id: 'all', label: 'All tasks' },
  { id: 'standalone', label: 'Non-project tasks' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'scheduled', label: 'Scheduled' },
];

function fmtBytes(n) {
  const bytes = Number(n) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ProjectsPanel({ onToast }) {
  const [projects, setProjects] = useState([]);
  const [selected, setSelected] = useState(null);
  const [filter, setFilter] = useState('all');
  const [filtered, setFiltered] = useState({ counts: {}, tasks: [] });
  const [instruction, setInstruction] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [dragId, setDragId] = useState(null);
  const [showTasks, setShowTasks] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.projects.list();
      setProjects(list ?? []);
      setSelected((current) => {
        if (current && list?.some((p) => p.id === current)) return current;
        return list?.[0]?.id ?? null;
      });
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    }
  }, []);

  const refreshTasks = useCallback(async (which) => {
    try {
      const result = await api.projects.filters({ filter: which });
      setFiltered({ counts: result?.counts ?? {}, tasks: result?.tasks ?? [] });
    } catch {
      setFiltered({ counts: {}, tasks: [] });
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { refreshTasks(filter); }, [filter, refreshTasks]);

  const current = useMemo(
    () => projects.find((p) => p.id === selected) ?? null,
    [projects, selected]
  );

  useEffect(() => {
    setInstruction(current?.masterInstruction ?? '');
  }, [current?.id, current?.masterInstruction]);

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const project = await api.projects.create({ name });
      setNewName('');
      await refresh();
      setSelected(project?.id ?? null);
      onToast?.(`Project “${project?.name}” created`, 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const saveInstruction = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await api.projects.update({ id: current.id, masterInstruction: instruction });
      await refresh();
      onToast?.('Master instruction saved — it applies from your next message', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const togglePin = async (project) => {
    try {
      await api.projects.setPinned({ id: project.id, pinned: !project.pinned });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  /** Drag and drop: the drop target's id moves to the end of the new order. */
  const onDrop = async (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ids = projects.map((p) => p.id).filter((id) => id !== dragId);
    const index = ids.indexOf(targetId);
    ids.splice(index < 0 ? ids.length : index, 0, dragId);
    setDragId(null);
    try {
      setProjects(await api.projects.reorder({ ids }));
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
      await refresh();
    }
  };

  const addFiles = async () => {
    if (!current) return;
    setBusy(true);
    try {
      const result = await api.projects.pickFiles({ id: current.id });
      if (result) {
        await refresh();
        onToast?.(`Added ${result.added?.length ?? 0} file(s) — new tasks only`, 'ok');
      }
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async (file) => {
    if (!current) return;
    try {
      await api.projects.removeFile({ id: current.id, fileId: file.id });
      await refresh();
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const remove = async (project) => {
    if (!project) return;
    try {
      await api.projects.remove({ id: project.id });
      await refresh();
      onToast?.(`Project “${project.name}” deleted`, 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const moveTask = async (task, projectId) => {
    try {
      await api.projects.assignTask({ sessionId: task.id, projectId });
      await refreshTasks(filter);
      onToast?.(projectId ? 'Task moved into the project' : 'Task removed from the project', 'ok');
    } catch (failure) {
      onToast?.(failure?.message ?? String(failure), 'err');
    }
  };

  const counts = filtered.counts ?? {};

  return (
    <section className="projects-panel" data-surface="projects-panel" aria-label="Projects">
      <header className="projects-panel-head">
        <span className="surface-label">Projects</span>
        <button type="button" className="ibtn" title="Reload" onClick={refresh}><Icon.Refresh /></button>
      </header>

      {error ? <p className="projects-error" role="alert">{error}</p> : null}

      <div className="projects-create">
        <input
          className="projects-name-input"
          aria-label="New project name"
          placeholder="New project…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
        />
        <button type="button" className="btn btn-primary btn-mini" disabled={busy || !newName.trim()} onClick={create}>
          <Icon.Plus /> Create
        </button>
      </div>

      <ul className="projects-list" role="listbox" aria-label="Projects">
        {projects.map((project) => (
          <li
            key={project.id}
            className={`projects-row${project.id === selected ? ' is-active' : ''}`}
            data-project={project.id}
            draggable
            onDragStart={() => setDragId(project.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(project.id)}
          >
            <button
              type="button"
              className="projects-row-name"
              aria-selected={project.id === selected}
              onClick={() => setSelected(project.id)}
            >
              <Icon.Folder />
              <span className="ellipsis">{project.name}</span>
              {project.files?.length ? <span className="projects-badge">{project.files.length}</span> : null}
            </button>
            <button
              type="button"
              className="ibtn"
              title={project.pinned ? 'Unpin' : 'Pin to top'}
              aria-label={project.pinned ? `Unpin ${project.name}` : `Pin ${project.name}`}
              onClick={() => togglePin(project)}
            >
              <Icon.Pin />
            </button>
            <button
              type="button"
              className="ibtn"
              title="Delete project"
              aria-label={`Delete ${project.name}`}
              onClick={() => remove(project)}
            >
              <Icon.Trash />
            </button>
          </li>
        ))}
        {!projects.length ? <li className="projects-empty">No projects yet.</li> : null}
      </ul>

      {current ? (
        <div className="projects-detail" data-project-detail={current.id}>
          <h4 className="surface-label">{current.name}</h4>

          <label className="projects-field">
            <span>Master instruction</span>
            <textarea
              className="projects-instruction"
              data-surface="project-master-instruction"
              rows={6}
              placeholder="What should every task in this project do?"
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
            />
            <small>Applies from your next message in any task of this project.</small>
          </label>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={saveInstruction}>
            Save instruction
          </button>

          <div className="projects-kb-head">
            <span className="surface-label">Knowledge base</span>
            <button type="button" className="btn btn-secondary btn-mini" disabled={busy} onClick={addFiles}>
              Add files
            </button>
          </div>
          <ul className="projects-files">
            {current.files?.map((file) => (
              <li key={file.id} className="projects-file" data-file={file.id}>
                <Icon.File />
                <span className="ellipsis">{file.name}</span>
                <span className="projects-file-size">{fmtBytes(file.size)}</span>
                <button
                  type="button"
                  className="ibtn"
                  title="Remove from the project"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFile(file)}
                >
                  <Icon.X />
                </button>
              </li>
            ))}
            {!current.files?.length ? <li className="projects-empty">No files yet.</li> : null}
          </ul>
          <small className="projects-note">
            File changes reach new tasks only. Tasks already running keep the file set they started with.
          </small>
        </div>
      ) : null}

      <div className="projects-filters" data-surface="task-filters">
        {FILTERS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`projects-filter${filter === entry.id ? ' is-active' : ''}`}
            data-filter={entry.id}
            aria-pressed={filter === entry.id}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
            {counts[entry.id] != null ? <span className="projects-filter-count">{counts[entry.id]}</span> : null}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="btn btn-secondary btn-mini projects-tasks-toggle"
        onClick={() => setShowTasks((v) => !v)}
      >
        {showTasks ? 'Hide tasks' : 'Show filtered tasks'}
      </button>

      {showTasks ? (
        <ul className="projects-tasks" data-surface="filtered-tasks">
          {filtered.tasks?.map((task) => (
            <li key={task.id} className="projects-task" data-task={task.id}>
              <span className="ellipsis">{task.title ?? task.id}</span>
              <select
                aria-label="Move task into project"
                value={task.projectId ?? ''}
                onChange={(e) => moveTask(task, e.target.value || null)}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </li>
          ))}
          {!filtered.tasks?.length ? <li className="projects-empty">No tasks match.</li> : null}
        </ul>
      ) : null}
    </section>
  );
}

export default ProjectsPanel;
