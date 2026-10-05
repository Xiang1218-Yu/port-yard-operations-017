import { useEffect, useMemo, useState } from 'react';

type ShiftDirection = 'earlier' | 'later' | 'unchanged';
type Feasibility = 'feasible' | 'warning' | 'blocked';
type ReplanMode = 'shift-window' | 'compress-turnaround' | 'swap-berth';

type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string; etaVersion: number; shiftReason?: string };

interface TimeChange { from: string; to: string; deltaMinutes: number; direction: ShiftDirection }
interface VoyageChange {
  voyageId: string; vessel: string; mode: ReplanMode;
  berth: { from: string; to: string; changed: boolean };
  eta: TimeChange; etd: TimeChange;
  lateRisk: { from: string; to: string };
  etaVersionBefore: number; etaVersionAfter: number; reason: string;
}
interface TaskImpact {
  taskId: string; kind: string; containerId: string; description: string; status: string;
  scheduledFrom: string; scheduledTo: string; deltaMinutes: number;
  decision: 'shift' | 'hold' | 'unassign' | 'keep';
  equipmentId?: string; equipmentName?: string; reasons: string[];
}
interface AppointmentImpact {
  appointmentId: string; containerId: string; truckNo: string; status: string;
  windowFrom: { start: string; end: string }; windowTo: { start: string; end: string };
  deltaMinutes: number; decision: 'shift' | 'hold' | 'keep'; reasons: string[];
}
interface EquipmentLock {
  equipmentId: string; equipmentName: string; kind: string;
  ownerVoyageId: string; ownerVessel: string; ownerTaskId: string;
  windowStart: string; windowEnd: string; reason: string;
}
interface ScorePart { label: string; points: number }
interface ReplanOption {
  id: string; mode: ReplanMode; targetBerth: string; label: string; summary: string;
  feasibility: Feasibility; blockers: string[]; warnings: string[];
  voyageChange: VoyageChange;
  taskImpacts: TaskImpact[]; appointmentImpacts: AppointmentImpact[];
  equipmentLocks: EquipmentLock[];
  craneCapacity: { requiredMovesPerHour: number; availableMovesPerHour: number; quayCranes: string[] };
  score: number; scoreBreakdown: ScorePart[];
}
interface ContainerImpact { containerId: string; voyageId: string; status: string; priority: string; yardSlot: string; note: string }
interface ReplanSession {
  id: string; status: 'draft' | 'confirmed' | 'failed' | 'stale' | 'cancelled';
  voyageId: string; trigger: string; reason: string; actor: string;
  baseEtaVersion: number; currentEtaVersion: number; preferredOptionId: string;
  options: ReplanOption[]; equipmentLocks: EquipmentLock[]; unfinishedContainers: ContainerImpact[];
  createdAt: string; expiresAt: string; note?: string; confirmedOptionId?: string; appliedAt?: string;
  failure?: { atStep: string; message: string };
}
interface AppliedResponse { session: ReplanSession; changes: {
  voyage: Voyage;
  tasks: { taskId: string; scheduledAt: string; status: string; equipmentId?: string; shiftReason?: string }[];
  appointments: { appointmentId: string; windowStart: string; windowEnd: string; shiftReason?: string }[];
  containers: { containerId: string; lastEvent: string }[];
  summary: { shiftedTasks: number; heldTasks: number; unassignedTasks: number; shiftedAppointments: number };
} }

const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (value: string) => new Date(value).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const toLocalInput = (value: string) => new Date(new Date(value).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const MINUTE = 60000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.message || `请求失败 (${response.status})`), { code: body.code });
  return body as T;
}

const DECISION_TEXT: Record<string, { text: string; cls: string }> = {
  shift: { text: '随窗口平移', cls: 'ok' },
  hold: { text: '保持不动', cls: 'critical' },
  unassign: { text: '解除设备指派', cls: 'warning' },
  keep: { text: '无需变化', cls: 'ok' },
};
const STATUS_TEXT: Record<ReplanSession['status'], { text: string; cls: string }> = {
  draft: { text: '待确认', cls: 'booked' },
  confirmed: { text: '已确认应用', cls: 'done' },
  failed: { text: '部分失败已回滚', cls: 'blocked' },
  stale: { text: '已被新 ETA 顶掉', cls: 'exception' },
  cancelled: { text: '已取消/恢复', cls: 'checked-in' },
};

export default function ReplanPanel({ voyages, initialVoyageId, onApplied }: { voyages: Voyage[]; initialVoyageId?: string; onApplied: () => void }) {
  const [voyageId, setVoyageId] = useState(initialVoyageId ?? 'VOY-QF2');
  const [targetEta, setTargetEta] = useState('');
  const [targetEtd, setTargetEtd] = useState('');
  const [reason, setReason] = useState('');
  const [session, setSession] = useState<ReplanSession>();
  const [history, setHistory] = useState<ReplanSession[]>([]);
  const [selectedOption, setSelectedOption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; code?: string }>();
  const [result, setResult] = useState<AppliedResponse['changes']>();

  const voyage = voyages.find(v => v.id === voyageId) ?? voyages[0];

  useEffect(() => { void refreshHistory(); }, []);
  useEffect(() => {
    if (voyage) { setTargetEta(toLocalInput(voyage.eta)); setTargetEtd(toLocalInput(voyage.etd)); }
    setSession(undefined); setResult(undefined); setError(undefined); setSelectedOption('');
  }, [voyageId, voyages]);

  const refreshHistory = async () => {
    try { setHistory(await request<ReplanSession[]>('/replan/sessions')); } catch { /* 历史非关键 */ }
  };
  const loadSession = async (id: string) => {
    setError(undefined); setResult(undefined);
    try { const s = await request<ReplanSession>(`/replan/sessions/${id}`); setSession(s); setSelectedOption(s.preferredOptionId); setVoyageId(s.voyageId); }
    catch (e) { setError({ message: (e as Error).message, code: (e as { code?: string }).code }); }
  };

  const quickShift = (etaMin: number, etdMin = etaMin, text = '') => {
    if (!voyage) return;
    setTargetEta(toLocalInput(new Date(new Date(voyage.eta).getTime() + etaMin * MINUTE).toISOString()));
    setTargetEtd(toLocalInput(new Date(new Date(voyage.etd).getTime() + etdMin * MINUTE).toISOString()));
    if (text) setReason(text);
  };

  const start = async () => {
    if (!voyage) return;
    setBusy(true); setError(undefined); setResult(undefined);
    try {
      const s = await request<ReplanSession>('/replan/sessions', {
        method: 'POST',
        body: JSON.stringify({ voyageId: voyage.id, targetEta: new Date(targetEta).toISOString(), targetEtd: new Date(targetEtd).toISOString(), reason }),
      });
      setSession(s); setSelectedOption(s.preferredOptionId);
      await refreshHistory();
    } catch (e) { setError({ message: (e as Error).message, code: (e as { code?: string }).code }); }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!session) return;
    if (!window.confirm(`确认执行方案「${option?.label}」？将批量更新航次窗口、任务、闸口预约与箱务，并记录调整原因。`)) return;
    setBusy(true); setError(undefined);
    try {
      const res = await request<AppliedResponse>(`/replan/sessions/${session.id}/confirm`, { method: 'POST', body: JSON.stringify({ optionId: selectedOption }) });
      setSession(res.session); setResult(res.changes);
      await refreshHistory(); onApplied();
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError({ message: (e as Error).message, code });
      if (code === 'SESSION_STALE' || code === 'PARTIAL_UPDATE_FAILED') {
        try { setSession(await request<ReplanSession>(`/replan/sessions/${session.id}`)); } catch { /* ignore */ }
      }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!session) return;
    const wording = session.status === 'failed' ? '该会话此前批量更新失败，确认按快照恢复到重排前状态？' : '确认取消本次重排？任何方案都不会写入，计划保持原样。';
    if (!window.confirm(wording)) return;
    setBusy(true); setError(undefined);
    try {
      const s = await request<ReplanSession>(`/replan/sessions/${session.id}/cancel`, { method: 'POST', body: '{}' });
      setSession(s); await refreshHistory(); onApplied();
    } catch (e) { setError({ message: (e as Error).message, code: (e as { code?: string }).code }); }
    finally { setBusy(false); }
  };

  const newEtaArrives = async (etaMin: number) => {
    if (!voyage) return;
    if (!window.confirm(`模拟重排进行中船方又推送新 ETA（${etaMin > 0 ? '推迟' : '提前'} ${Math.abs(etaMin)} 分钟）？当前草稿方案将被标记为 stale。`)) return;
    setBusy(true); setError(undefined);
    try {
      const next = new Date(new Date(voyage.eta).getTime() + etaMin * MINUTE).toISOString();
      const res = await request<{ session: ReplanSession }>(`/voyages/${voyage.id}/eta`, {
        method: 'POST', body: JSON.stringify({ eta: next, etd: new Date(new Date(voyage.etd).getTime() + etaMin * MINUTE).toISOString(), reason: `重排中新 ETA：${etaMin > 0 ? '推迟' : '提前'} ${Math.abs(etaMin)} 分钟` }),
      });
      setSession(res.session); setSelectedOption(res.session.preferredOptionId);
      await refreshHistory(); onApplied();
    } catch (e) { setError({ message: (e as Error).message, code: (e as { code?: string }).code }); }
    finally { setBusy(false); }
  };

  const option = useMemo(() => session?.options.find(o => o.id === selectedOption), [session, selectedOption]);
  const sessionBadge = session ? STATUS_TEXT[session.status] : undefined;

  return <div className="replan-layout">
    <section className="panel">
      <div className="panel-head"><div><div className="eyebrow">BERTH WINDOW REPLAN / 泊位窗口重排</div><h2>发起窗口重排</h2><span className="muted">延误或提前靠泊时，窗口、岸桥能力与装卸任务联动生成可比方案</span></div></div>

      <label className="replan-field">目标航次
        <select value={voyageId} onChange={e => setVoyageId(e.target.value)}>
          {voyages.filter(v => v.status !== 'departed').map(v => <option key={v.id} value={v.id}>{v.id} · {v.vessel}（{v.berth} · ETA {time(v.eta)} · v{v.etaVersion}）</option>)}
        </select>
      </label>
      {voyage?.shiftReason && <div className="replan-lastreason">上次调整原因：{voyage.shiftReason}</div>}

      <div className="replan-quick">
        <button onClick={() => quickShift(120, 120, '船方报延误 2 小时')} type="button">延误 +2h</button>
        <button onClick={() => quickShift(-30, -30, '船方报提前 30 分钟')} type="button">提前 -30min</button>
        <button onClick={() => quickShift(0, 120, '在港作业延长，ETD 推迟 2 小时')} type="button">ETD +2h</button>
        <button onClick={() => quickShift(0, -90, '港方要求压缩周转 90 分钟')} type="button">压缩周转</button>
      </div>

      <div className="replan-time-grid">
        <label className="replan-field">新 ETA（预计靠泊）<input type="datetime-local" value={targetEta} onChange={e => setTargetEta(e.target.value)} /></label>
        <label className="replan-field">新 ETD（计划离泊）<input type="datetime-local" value={targetEtd} onChange={e => setTargetEtd(e.target.value)} /></label>
      </div>
      <label className="replan-field">推迟 / 提前原因<textarea rows={2} placeholder="例如：前序港口拥堵、航道管制、船方加速…" value={reason} onChange={e => setReason(e.target.value)} /></label>
      <div className="replan-actions"><button className="primary-action" disabled={busy} onClick={start}>{busy ? '计算中…' : '生成可比方案'}</button></div>

      {error && <div className={`replan-alert ${error.code === 'PARTIAL_UPDATE_FAILED' || error.code === 'SESSION_STALE' ? 'critical' : 'warning'}`}>
        <strong>{error.code === 'PARTIAL_UPDATE_FAILED' ? '部分更新失败' : error.code === 'SESSION_STALE' ? '方案已过期' : '无法生成方案'}</strong>
        <span>{error.message}</span>
      </div>}

      <div className="replan-history">
        <div className="eyebrow">重排记录 / SESSIONS</div>
        {history.slice(0, 8).map(s => <button key={s.id} type="button" className={`history-item ${session?.id === s.id ? 'active' : ''}`} onClick={() => void loadSession(s.id)}>
          <span className={`pill ${STATUS_TEXT[s.status].cls}`}>{STATUS_TEXT[s.status].text}</span>
          <b>{s.voyageId}</b><small>{dateTime(s.createdAt)} · {s.reason}</small>
        </button>)}
      </div>
    </section>

    <section className="panel wide">
      {!session && <div className="replan-empty">选择航次并给定新 ETA / ETD 后，系统将读取航次窗口、设备池锁定、任务计划与未完成箱务，生成平移窗口、压缩周转、更换泊位等方案供横向比较。</div>}

      {session && <>
        <div className="panel-head">
          <div><div className="eyebrow">SESSION / {session.id} · 基于 ETA v{session.baseEtaVersion}{session.currentEtaVersion !== session.baseEtaVersion && <> → v{session.currentEtaVersion}</>}</div>
            <h2>{session.voyageId} 窗口重排方案对比</h2><span className="muted">{session.reason}</span></div>
          <span className={`pill ${sessionBadge?.cls}`}>{sessionBadge?.text}</span>
        </div>

        {session.status === 'stale' && <div className="replan-alert critical"><strong>方案基线已失效</strong><span>{session.note ?? '重排进行中航次收到新 ETA，请基于最新时间重新生成方案。'}</span></div>}
        {session.status === 'failed' && <div className="replan-alert critical"><strong>批量更新部分失败，已回滚</strong><span>失败步骤：{session.failure?.atStep} — {session.failure?.message}。可点「恢复到重排前」再次确认快照还原，或重新发起重排。</span></div>}
        {session.status === 'cancelled' && <div className="replan-alert warning"><strong>重排已取消</strong><span>{session.note}</span></div>}

        <div className="option-grid">
          {session.options.map(o => {
            const etaArrow = `${o.voyageChange.eta.direction === 'earlier' ? '提前' : o.voyageChange.eta.direction === 'later' ? '推迟' : 'ETA不变'} ${Math.abs(o.voyageChange.eta.deltaMinutes)}′`;
            return <button type="button" key={o.id} disabled={o.feasibility === 'blocked' || session.status !== 'draft'}
              className={`option-card ${o.feasibility} ${selectedOption === o.id ? 'selected' : ''}`}
              onClick={() => setSelectedOption(o.id)}>
              <div className="option-top"><b>{o.label}</b><strong className={`score ${o.feasibility}`}>{o.score}</strong></div>
              <small>{etaArrow}{o.voyageChange.berth.changed ? ` · ${o.voyageChange.berth.from}→${o.voyageChange.berth.to}` : ''}</small>
              <span className={`feas ${o.feasibility}`}>{o.feasibility === 'feasible' ? '可执行' : o.feasibility === 'warning' ? `${o.warnings.length} 项预警` : `${o.blockers.length} 项冲突`}</span>
              <div className="option-tasks"><i>平移 {o.taskImpacts.filter(t => t.decision === 'shift').length}</i><i className="critical">保持 {o.taskImpacts.filter(t => t.decision === 'hold').length}</i><i className="warning">解派 {o.taskImpacts.filter(t => t.decision === 'unassign').length}</i></div>
            </button>;
          })}
        </div>

        {option && <OptionDetail option={option} session={session} />}

        {session.status === 'draft' && <div className="replan-actions sticky-actions">
          <button className="primary-action" disabled={busy || option?.feasibility === 'blocked'} onClick={confirm}>{busy ? '批量更新中…' : `确认执行「${option?.label}」并批量更新`}</button>
          <button disabled={busy} onClick={cancel}>取消重排（不写入）</button>
          <button className="danger-action-outline" disabled={busy} onClick={() => void newEtaArrives(45)}>模拟重排中又收到新 ETA +45′</button>
        </div>}
        {(session.status === 'failed') && <div className="replan-actions"><button className="primary-action" disabled={busy} onClick={cancel}>恢复到重排前（快照回滚）</button></div>}
      </>}

      {result && <ResultPanel changes={result} />}
    </section>
  </div>;
}

function OptionDetail({ option, session }: { option: ReplanOption; session: ReplanSession }) {
  const vc = option.voyageChange;
  return <div className="option-detail">
    <div className="voyage-change-banner">
      <div className="eyebrow">VOYAGE CHANGE / 航次级变化</div>
      <div className="change-grid">
        <ChangeCell label="ETA 靠泊" from={time(vc.eta.from)} to={time(vc.eta.to)} dir={vc.eta.direction} delta={vc.eta.deltaMinutes} />
        <ChangeCell label="ETD 离泊" from={time(vc.etd.from)} to={time(vc.etd.to)} dir={vc.etd.direction} delta={vc.etd.deltaMinutes} />
        <ChangeCell label="泊位" from={vc.berth.from} to={vc.berth.to} dir={vc.berth.changed ? (vc.eta.direction) : 'unchanged'} delta={vc.berth.changed ? 1 : 0} text />
        <div className="change-cell"><small>延误风险</small><b><span className={`risk ${vc.lateRisk.from}`}>{vc.lateRisk.from}</span> → <span className={`risk ${vc.lateRisk.to}`}>{vc.lateRisk.to}</span></b><em>ETA 版本 v{vc.etaVersionBefore} → v{vc.etaVersionAfter}</em></div>
        <div className="change-cell wide"><small>记录原因</small><b>{vc.reason}</b></div>
        <div className="change-cell"><small>岸桥能力</small><b className={option.craneCapacity.requiredMovesPerHour > option.craneCapacity.availableMovesPerHour ? 'critical' : ''}>{option.craneCapacity.requiredMovesPerHour} / {option.craneCapacity.availableMovesPerHour} moves/h</b><em>需要 / 可用（{option.craneCapacity.quayCranes.join('、') || '无可用岸桥'}）</em></div>
      </div>
    </div>

    {option.blockers.length > 0 && <div className="impact-group"><h4>硬性冲突（方案不可执行）</h4>{option.blockers.map((b, i) => <div key={i} className="impact-row critical"><span>⛔ {b}</span></div>)}</div>}
    {option.warnings.length > 0 && <div className="impact-group"><h4>预警（可执行但需调度员关注）</h4>{option.warnings.map((w, i) => <div key={i} className="impact-row warning"><span>⚠ {w}</span></div>)}</div>}
    {option.scoreBreakdown.length > 0 && <div className="impact-group"><h4>评分扣减构成（越低越扰动）</h4><div className="score-parts">{option.scoreBreakdown.map((p, i) => <span key={i} className="score-chip">-{p.points} {p.label}</span>)}</div></div>}

    <div className="impact-group">
      <h4>装卸任务影响（{option.taskImpacts.length} 个未完成任务）</h4>
      <div className="impact-table">
        <div className="itr th"><span>任务 / 箱</span><span>计划时间</span><span>决策</span><span>设备</span><span>原因</span></div>
        {option.taskImpacts.map(t => <div className="itr" key={t.taskId}>
          <span><b>{t.taskId}</b><small>{t.description} · {t.containerId} · {t.status}</small></span>
          <span>{time(t.scheduledFrom)}<i>→</i>{time(t.scheduledTo)}{t.decision === 'shift' && <small className={t.deltaMinutes < 0 ? 'ok' : 'warning'}>{t.deltaMinutes < 0 ? '提前' : '推迟'} {Math.abs(t.deltaMinutes)}′</small>}</span>
          <span><span className={`pill ${DECISION_TEXT[t.decision].cls === 'ok' ? 'completed' : DECISION_TEXT[t.decision].cls === 'warning' ? 'booked' : 'blocked'}`}>{DECISION_TEXT[t.decision].text}</span></span>
          <span>{t.equipmentName ?? '—'}{t.decision === 'unassign' && <small className="critical">退回队列重派</small>}</span>
          <span className="impact-reasons">{t.reasons.length ? t.reasons.map((r, i) => <small key={i}>{r}</small>) : <small className="dim">随航次窗口联动</small>}</span>
        </div>)}
      </div>
    </div>

    <div className="impact-group">
      <h4>闸口预约影响（{option.appointmentImpacts.length} 个关联预约）</h4>
      {option.appointmentImpacts.length === 0 && <div className="impact-row"><span className="dim">该航次无关联的未完成闸口预约</span></div>}
      {option.appointmentImpacts.map(a => <div key={a.appointmentId} className="impact-row">
        <span><b>{a.appointmentId}</b> · {a.truckNo} · {a.containerId} · <span className="pill">{a.status}</span></span>
        <span>{time(a.windowFrom.start)} <i>→</i> {a.decision === 'shift' ? time(a.windowTo.start) : time(a.windowFrom.start)}　{DECISION_TEXT[a.decision].text}{a.decision === 'shift' && `（${a.deltaMinutes < 0 ? '提前' : '推迟'} ${Math.abs(a.deltaMinutes)}′）`}</span>
        {a.reasons.map((r, i) => <small key={i} className="warning">{r}</small>)}
      </div>)}
    </div>

    <div className="impact-group">
      <h4>设备锁定 & 未完成箱务基线</h4>
      <div className="two-col">
        <div>{session.equipmentLocks.length === 0 && <div className="dim impact-row">当前没有跨航次设备占用</div>}
          {session.equipmentLocks.map(l => <div key={l.ownerTaskId + l.equipmentId} className="impact-row warning"><span>🔒 {l.reason}</span><small>{time(l.windowStart)}–{time(l.windowEnd)}</small></div>)}</div>
        <div>{session.unfinishedContainers.map(c => <div key={c.containerId} className="impact-row mini"><span><b>{c.containerId}</b> · {c.status} · {c.yardSlot}</span><small>{c.note}</small></div>)}</div>
      </div>
    </div>
  </div>;
}

function ChangeCell({ label, from, to, dir, delta, text }: { label: string; from: string; to: string; dir: ShiftDirection; delta: number; text?: boolean }) {
  const cls = dir === 'earlier' ? 'ok' : dir === 'later' ? 'warning' : '';
  return <div className="change-cell"><small>{label}</small><b>{from} <i>→</i> <span className={cls}>{to}</span></b>
    <em className={cls}>{dir === 'unchanged' ? '保持不变' : text ? '泊位调整' : `${dir === 'earlier' ? '提前' : '推迟'} ${Math.abs(delta)} 分钟`}</em></div>;
}

function ResultPanel({ changes }: { changes: AppliedResponse['changes'] }) {
  return <div className="applied-result">
    <div className="eyebrow">APPLIED / 本次批量更新结果（航次变化与具体任务联动留痕）</div>
    <div className="applied-kpis">
      <div><b>{changes.voyage.vessel}</b><small>{changes.voyage.id} · ETA v{changes.voyage.etaVersion} · {changes.voyage.berth}</small></div>
      <div><b className="warning">+{changes.summary.shiftedTasks}</b><small>任务已平移</small></div>
      <div><b className="critical">{changes.summary.heldTasks}</b><small>已开工任务未动</small></div>
      <div><b className="warning">{changes.summary.unassignedTasks}</b><small>退回队列重派</small></div>
      <div><b className="warning">{changes.summary.shiftedAppointments}</b><small>预约已平移</small></div>
    </div>
    <div className="impact-table">
      {changes.tasks.map(t => <div className="itr" key={t.taskId}><span><b>{t.taskId}</b><small>{t.status}</small></span><span>{time(t.scheduledAt)}</span><span>{t.equipmentId ?? '未指派'}</span><span className="impact-reasons"><small>{t.shiftReason}</small></span></div>)}
      {changes.containers.map(c => <div className="itr" key={c.containerId}><span><b>{c.containerId}</b><small>箱务留痕</small></span><span className="impact-reasons" style={{ gridColumn: 'span 3' }}><small>{c.lastEvent}</small></span></div>)}
    </div>
  </div>;
}
