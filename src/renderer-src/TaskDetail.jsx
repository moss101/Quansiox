import { useEffect, useState } from 'react';
import { api, toast, renderMarkdown } from './lib.js';
const ACTIVE = ['queued', 'running', 'stopping'];
export default function TaskDetail({ sessionId, taskId, onClose }) {
  const [task, setTask] = useState(null);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    let timer;
    const refresh = async () => {
      try {
        const record = await api.tasks.get({ sessionId, id: taskId });
        if (!current) return;
        setTask(record);
        setModel((value) => value || record.model || '');
        if (ACTIVE.includes(record.status)) timer = setTimeout(refresh, 500);
      } catch (failure) { if (current) setError(failure.message); }
    };
    refresh();
    return () => { current = false; clearTimeout(timer); };
  }, [sessionId, taskId, busy]);
  const action = async (name) => {
    setBusy(true); setError('');
    try {
      await api.tasks[name]({ sessionId, id: taskId, prompt: prompt.trim() || undefined, model: model.trim() || undefined });
      setPrompt('');
      if (name === 'fork') { toast('Forked child started', 'ok'); onClose(); }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };
  return <div className="task-detail-backdrop" onClick={onClose}>
    <section className="task-detail" role="dialog" aria-modal="true" aria-label="Child task" onClick={(event) => event.stopPropagation()}>
      <header><strong>{task?.title || 'Child task'}</strong><button className="ibtn" aria-label="Close child task" onClick={onClose}>×</button></header>
      {error && <p role="alert" className="task-error">{error}</p>}
      {task ? <>
        <div className="task-meta"><span>{task.status}</span><span>{task.type}</span><span>{task.model}</span><span>{task.environment === 'isolated' ? 'Separate workspace' : 'Parent workspace'}</span></div>
        <div className="task-transcript" data-task-transcript>
          {task.messages.map((turn, index) => <article key={index} className={`task-turn ${turn.role}`}>
            <span className="surface-label">{turn.role === 'tool' ? turn.name || 'Tool' : turn.role}</span>
            {turn.content && <div dangerouslySetInnerHTML={{ __html: renderMarkdown(turn.content) }} />}
            {turn.tool_calls?.map((call) => <pre key={call.id}>{call.function.name} {call.function.arguments}</pre>)}
          </article>)}
        </div>
        {task.fileResults?.length > 0 && <details><summary>Created files ({task.fileResults.length})</summary>{task.fileResults.map((file) => <button className="btn btn-secondary" key={file} onClick={async () => {
          try { const content = await api.tasks.artifact({ sessionId, id: taskId, path: file }); await navigator.clipboard.writeText(content); toast('File contents copied', 'ok'); }
          catch (failure) { setError(failure.message); }
        }}>{file} · Copy contents</button>)}</details>}
        <footer>
          {task.type === 'browser' && <button className="btn btn-secondary" onClick={() => api.browser.openWindow({ sessionId: task.browserSessionId }).catch((failure) => setError(failure.message))}>Watch browser</button>}
          {ACTIVE.includes(task.status) ? <button className="btn btn-danger" disabled={busy || task.status === 'stopping'} onClick={() => action('interrupt')}>{task.status === 'stopping' ? 'Stopping…' : 'Stop this child'}</button> : <>
            <input aria-label="Child model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model" />
            <textarea aria-label="Child continuation" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Follow-up instructions (optional)" />
            <button className="btn btn-primary" disabled={busy} onClick={() => action('resume')}>Resume</button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => action('fork')}>Fork</button>
          </>}
        </footer>
      </> : <p>Loading child transcript…</p>}
    </section>
  </div>;
}
