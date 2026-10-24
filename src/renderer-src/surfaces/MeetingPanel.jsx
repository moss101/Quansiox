import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, toast } from '../lib.js';
import { Icon } from '../Icons.jsx';

/**
 * MeetingPanel — the meeting copilot surface.
 *
 * A meeting is a local transcript plus the analysis the model produced from
 * it: a summary, the decisions that were made, the action items with their
 * owners, and the questions still open. Everything stays on this machine.
 *
 * Props:
 *   - active?: boolean — when false the panel stops polling (default true).
 *   - onToast?: (message: string, kind?: 'ok' | 'err' | 'warn' | 'info') => void
 *     — the notification sink. Falls back to the global toast in lib.js.
 */

/** One line of the analysis list (decisions, questions, topics). */
function AnalysisList({ title, items }) {
  if (!items?.length) return null;
  return (
    <div className="sfx-block" data-surface="meeting-analysis">
      <span className="surface-label">{title}</span>
      <ul className="sfx-list">
        {items.map((item, index) => (
          <li key={`${title}-${index}`} className="sfx-list-item">
            <span>{item?.text ?? String(item)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Format a timestamp the way the rest of the app does. */
function when(ms) {
  if (!ms) return '—';
  try {
    return new Date(Number(ms)).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

export function MeetingPanel({ active = true, onToast }) {
  const notify = useCallback((message, kind = 'info') => {
    if (onToast) onToast(message, kind);
    else toast(message, kind);
  }, [onToast]);

  const [meetings, setMeetings] = useState([]);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [turn, setTurn] = useState({ speaker: '', text: '' });

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const rows = await api.meeting.list();
      const list = Array.isArray(rows) ? rows : [];
      setMeetings(list);
      setSelected((prev) => (
        prev && list.some((row) => row.id === prev) ? prev : (list[0]?.id ?? null)
      ));
    } catch (failure) {
      setError(failure?.message ?? String(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (meetingId) => {
    if (!meetingId) { setDetail(null); return; }
    setDetailLoading(true);
    try {
      const record = await api.meeting.get({ meetingId });
      setDetail(record ?? null);
      setError(null);
    } catch (failure) {
      setDetail(null);
      setError(failure?.message ?? String(failure));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    refresh();
    const timer = setInterval(refresh, 8000);
    return () => clearInterval(timer);
  }, [active, refresh]);

  useEffect(() => {
    loadDetail(selected);
  }, [selected, loadDetail]);

  const startMeeting = async (event) => {
    event.preventDefault();
    const title = newTitle.trim() || 'Untitled meeting';
    setBusy(true);
    try {
      const created = await api.meeting.start({ title });
      setNewTitle('');
      await refresh();
      if (created?.id) setSelected(created.id);
      notify('Meeting started', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const appendTurn = async (event) => {
    event.preventDefault();
    const text = turn.text.trim();
    if (!selected || !text) return;
    setBusy(true);
    try {
      await api.meeting.append({ meetingId: selected, speaker: turn.speaker.trim() || 'Speaker', text });
      setTurn({ speaker: turn.speaker, text: '' });
      await loadDetail(selected);
      await refresh();
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const removeMeeting = async (meetingId) => {
    setBusy(true);
    try {
      await api.meeting.remove({ meetingId });
      if (selected === meetingId) setSelected(null);
      await refresh();
      notify('Meeting removed', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    } finally {
      setBusy(false);
    }
  };

  const copyTranscript = async () => {
    if (!selected) return;
    try {
      const text = await api.meeting.transcript({ meetingId: selected });
      await navigator.clipboard.writeText(String(text ?? ''));
      notify('Transcript copied', 'ok');
    } catch (failure) {
      notify(failure?.message ?? String(failure), 'err');
    }
  };

  const analysis = detail?.analysis ?? null;
  const turns = Array.isArray(detail?.turns) ? detail.turns : [];

  const summary = useMemo(() => {
    if (!analysis) return null;
    return {
      summary: String(analysis.summary ?? ''),
      decisions: Array.isArray(analysis.decisions) ? analysis.decisions : [],
      actions: Array.isArray(analysis.actions) ? analysis.actions : [],
      questions: Array.isArray(analysis.questions) ? analysis.questions : [],
      topics: Array.isArray(analysis.topics) ? analysis.topics : [],
    };
  }, [analysis]);

  return (
    <section className="sfx-panel" data-surface="meeting">
      <header className="sfx-head">
        <span className="surface-label">Meetings</span>
        <div className="sfx-head-actions">
          <button type="button" className="ibtn" title="Copy the transcript" disabled={!selected || busy} onClick={copyTranscript}>
            <Icon.Copy />
          </button>
          <button type="button" className="ibtn" title="Refresh" disabled={busy} onClick={refresh}>
            <Icon.Refresh />
          </button>
        </div>
      </header>

      <div className="sfx-body">
        {error ? (
          <div className="sfx-error" data-surface="meeting-error">
            <Icon.Info />
            <span>{error}</span>
            <button type="button" className="btn btn-secondary btn-mini" onClick={refresh}>Retry</button>
          </div>
        ) : null}

        {loading && meetings.length === 0 ? <div className="sfx-loading">Loading the meetings…</div> : null}

        {!loading && meetings.length === 0 && !error ? (
          <div className="sfx-empty" data-surface="meeting-empty">
            <p>No meetings recorded yet.</p>
            <p className="sfx-hint">
              Start one below and add what was said — the copilot then writes the summary,
              the decisions and the open questions.
            </p>
          </div>
        ) : null}

        {meetings.length ? (
          <div className="sfx-list" data-surface="meeting-list">
            {meetings.map((row) => (
              <button
                key={row.id}
                type="button"
                className={`sfx-select${selected === row.id ? ' is-active' : ''}`}
                data-meeting={row.id}
                onClick={() => setSelected(row.id)}
              >
                <span className="sfx-title">{row.title}</span>
                <span className="sfx-meta">
                  <span className="sfx-tag">{row.turns} turns</span>
                  <span className="sfx-tag">{when(row.startedAt)}</span>
                  {row.analyzed ? <span className="sfx-tag" data-status="ready">analysed</span> : null}
                </span>
              </button>
            ))}
          </div>
        ) : null}

        <form className="sfx-form" onSubmit={startMeeting}>
          <input
            aria-label="New meeting title"
            placeholder="new meeting title"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <button className="btn btn-secondary btn-mini" type="submit" disabled={busy}>Start</button>
        </form>

        {selected ? (
          <article className="sfx-card" data-surface="meeting-detail" data-meeting={selected}>
            <div className="sfx-card-head">
              <span className="sfx-title">{detail?.title ?? 'Meeting'}</span>
              <span className="sfx-mono sfx-muted">{selected}</span>
              <button type="button" className="ibtn danger" title="Delete this meeting" disabled={busy}
                onClick={() => removeMeeting(selected)}>
                <Icon.Trash />
              </button>
            </div>

            {detailLoading ? <div className="sfx-loading">Loading the transcript…</div> : null}

            {!detailLoading && turns.length === 0 ? (
              <p className="sfx-hint">Nothing was said yet — add the first turn below.</p>
            ) : null}

            {turns.length ? (
              <div className="sfx-transcript" data-surface="meeting-transcript">
                {turns.map((entry, index) => (
                  <div key={`${entry.at}-${index}`} className="sfx-turn" data-speaker={entry.speaker}>
                    <span className="sfx-speaker">{entry.speaker}</span>
                    <span className="sfx-turn-text">{entry.text}</span>
                    <span className="sfx-tag">{when(entry.at)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <form className="sfx-form" onSubmit={appendTurn}>
              <input
                aria-label="Speaker"
                placeholder="speaker"
                value={turn.speaker}
                onChange={(event) => setTurn({ ...turn, speaker: event.target.value })}
              />
              <input
                aria-label="What was said"
                placeholder="what was said"
                value={turn.text}
                onChange={(event) => setTurn({ ...turn, text: event.target.value })}
              />
              <button className="btn btn-secondary btn-mini" type="submit" disabled={busy}>Add</button>
            </form>

            <div className="sfx-block" data-surface="meeting-copilot">
              <span className="surface-label">Copilot</span>
              {!summary ? (
                <p className="sfx-hint">
                  No analysis yet. Ask the agent to analyse this meeting and it will write the
                  summary, the decisions, the action items and the open questions here.
                </p>
              ) : (
                <>
                  {summary.summary ? <p className="sfx-summary">{summary.summary}</p> : null}
                  <AnalysisList title="Decisions" items={summary.decisions} />
                  {summary.actions.length ? (
                    <div className="sfx-block" data-surface="meeting-actions">
                      <span className="surface-label">Actions</span>
                      <ul className="sfx-list">
                        {summary.actions.map((item, index) => (
                          <li key={`action-${index}`} className="sfx-list-item">
                            <span>{item?.text ?? String(item)}</span>
                            {item?.owner ? <span className="sfx-tag">{item.owner}</span> : null}
                            {item?.due ? <span className="sfx-tag">{item.due}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <AnalysisList title="Open questions" items={summary.questions} />
                  <AnalysisList title="Topics" items={summary.topics} />
                </>
              )}
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}

export default MeetingPanel;
