import { useCallback, useEffect, useState } from 'react';
import { api, toast } from '../lib.js';

/**
 * The settings context.
 *
 * The settings area is one bounded context: it owns the state of the
 * things you configure — the secrets, the skills, the addons, the
 * templates, the automations, the memories, the marketplace — and it
 * publishes nothing that the rest of the app has to know about.
 *
 * Extracting it from the app shell is what makes the shell readable: the
 * shell is about the conversation, and the settings area is about
 * configuration, and they do not share state.
 *
 * The hook returns the state and the actions; the JSX stays where it is.
 */
export function useSettingsContext({ sessionId = null } = {}) {
  /* ---- the vault ---- */
  const [secrets, setSecrets] = useState([]);
  const [secretDraft, setSecretDraft] = useState({ name: '', field: 'value', value: '', note: '' });
  const refreshSecrets = useCallback(
    () => api.secrets.list().then(setSecrets).catch(() => setSecrets([])),
    [],
  );

  /* ---- automations ---- */
  const [automations, setAutomations] = useState([]);
  const [autoDraft, setAutoDraft] = useState({ name: '', prompt: '', intervalMin: '15', cron: '' });
  const [editAuto, setEditAuto] = useState(null);
  const [autoHistory, setAutoHistory] = useState({});
  const refreshAutomations = useCallback(
    () => api.automations.list({}).then(setAutomations).catch(() => setAutomations([])),
    [],
  );
  const toggleAutoHistory = useCallback(async (id) => {
    if (autoHistory[id]) {
      setAutoHistory((prev) => { const next = { ...prev }; delete next[id]; return next; });
      return;
    }
    try {
      const runs = await api.automations.history({ id, limit: 10 });
      setAutoHistory((prev) => ({ ...prev, [id]: Array.isArray(runs) ? runs : [] }));
    } catch (failure) { toast(failure.message, 'err'); }
  }, [autoHistory]);

  /* ---- the marketplace ---- */
  const [market, setMarket] = useState([]);
  const [marketKind, setMarketKind] = useState('');
  const refreshMarket = useCallback(
    () => api.marketplace.list({ kind: marketKind || undefined }).then(setMarket).catch(() => setMarket([])),
    [marketKind],
  );

  /* ---- skills and addons ---- */
  const [skills, setSkills] = useState([]);
  const [skillDraft, setSkillDraft] = useState({ name: '', body: '' });
  const refreshSkills = useCallback(
    () => api.skills.list({}).then(setSkills).catch(() => setSkills([])),
    [],
  );
  const [addons, setAddons] = useState([]);
  const [trustDraft, setTrustDraft] = useState({ publisher: '', key: '' });
  const refreshAddons = useCallback(
    () => api.addons.list().then(setAddons).catch(() => setAddons([])),
    [],
  );

  /* ---- templates ---- */
  const [templates, setTemplates] = useState([]);
  const [templateDraft, setTemplateDraft] = useState(null);
  const refreshTemplates = useCallback(
    () => api.templates.list({}).then(setTemplates).catch(() => setTemplates([])),
    [],
  );

  /* ---- integrations ---- */
  const [integ, setInteg] = useState({});
  const checkIntegration = useCallback(async (kind) => {
    try { const st = await api[kind].status(); setInteg((m) => ({ ...m, [kind]: st })); }
    catch (e) { setInteg((m) => ({ ...m, [kind]: { error: e.message } })); }
  }, []);

  /* ---- memory ---- */
  const [memories, setMemories] = useState([]);
  const [memQuery, setMemQuery] = useState('');
  const [memDraft, setMemDraft] = useState({ text: '', tags: '' });
  const [memScope, setMemScope] = useState('session');
  const memScopeArg = memScope === 'session' ? { scope: sessionId } : {};
  const refreshMemories = useCallback(
    () => api.memory.list(memScopeArg).then(setMemories).catch(() => setMemories([])),
    [memScope, sessionId],
  );

  /* ---- the lifecycle ---- */
  useEffect(() => { refreshSecrets(); }, [refreshSecrets]);
  useEffect(() => { refreshSkills(); }, [refreshSkills]);
  useEffect(() => { refreshAddons(); }, [refreshAddons]);
  useEffect(() => { refreshTemplates(); }, [refreshTemplates]);
  useEffect(() => { refreshAutomations(); }, [refreshAutomations]);
  useEffect(() => { refreshMarket(); }, [refreshMarket]);
  useEffect(() => { refreshMemories(); }, [refreshMemories]);

  return {
    secrets, secretDraft, setSecretDraft, refreshSecrets,
    automations, autoDraft, setAutoDraft, editAuto, setEditAuto, autoHistory, refreshAutomations, toggleAutoHistory,
    market, marketKind, setMarketKind, refreshMarket,
    skills, skillDraft, setSkillDraft, refreshSkills,
    addons, trustDraft, setTrustDraft, refreshAddons,
    templates, templateDraft, setTemplateDraft, refreshTemplates,
    integ, checkIntegration,
    memories, memQuery, setMemQuery, memDraft, setMemDraft, memScope, setMemScope, refreshMemories,
  };
}

export default useSettingsContext;
