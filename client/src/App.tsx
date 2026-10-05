import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type Dashboard = { activeVoyages: number; berthMoves: number; yardUtilization: number; gateQueue: number; pendingTasks: number; blockedTasks: number; reeferAlerts: number; hazmatHolds: number; lateVessels: number };
type Voyage = { id: string; vessel: string; service: string; eta: string; etd: string; status: string; berth: string; movesPlanned: number; movesDone: number; lateRisk: string };
type Container = { id: string; voyageId: string; size: '20'|'40'|'45'; isoType: string; direction: 'import'|'export'|'transshipment'; status: string; weightT: number; reefer: boolean; temperature?: number; hazmatClass?: string; customs: 'released'|'inspection'|'hold'; priority: string; yardSlot: string; appointmentId?: string; lastEvent: string };
type Block = { id: string; zone: string; capacity: number; occupied: number; reeferPlugs: number; usedPlugs: number; hazmatAllowed: boolean; heat: number; utilization: number; freeSlots: number; pressure: string };
type Conflict = { severity: string; appointmentId: string; reason: string };
type Appointment = { id: string; containerId: string; truckNo: string; driver: string; type: 'pickup'|'dropoff'; windowStart: string; windowEnd: string; lane: 'north'|'south'|'rail'; status: string; exception?: string };
type Task = { id: string; kind: string; containerId: string; from: string; to: string; equipmentId?: string; priority: number; score: number; status: string; blockingReasons: string[]; estimatedMinutes: number; scheduledAt: string };
type Equipment = { id: string; name: string; kind: string; status: string; location: string; battery: number; queue: number; movesPerHour: number };
type Section = 'control'|'containers'|'gate'|'yard'|'tasks'|'replan';
type Editor = { entity: 'container'|'appointment'|'task'; mode: 'create'|'edit'; id?: string; values: Record<string, string|boolean> };

type ChangeReason = { shiftMinutes: number; direction: 'delayed'|'advanced'|'unchanged'; text: string };
type PlannedChange = { id: string; type: 'voyage-window'|'task-shift'|'task-equipment'|'appointment-shift'|'container-note'|'freeze-task'; entity: string; entityId: string; voyageId: string; before: Record<string, unknown>; after: Record<string, unknown>; risk: 'none'|'warning'|'critical'; frozen: boolean; frozenReason?: string; reason: ChangeReason };
type VoyageImpact = { voyageId: string; vessel: string; role: 'target'|'cascade'; before: { eta: string; etd: string; berth: string }; after: { eta: string; etd: string; berth: string }; shiftMinutes: number; conflictsWith?: { voyageId: string; reason: string }[]; lockedCranes?: { craneId: string; holderVoyageId: string; resolution: string }[] };
type ReplanMetrics = { affectedVoyages: number; delayedVoyages: number; advancedVoyages: number; movedTasks: number; frozenTasks: number; craneReassignments: number; shiftedAppointments: number; containerNotes: number; warnings: number; conflicts: number; craneDensity?: number };
type ReplanOption = { id: string; label: string; description: string; feasible: boolean; infeasibleReason?: string; recommended: boolean; score: number; scoreBreakdown: { label: string; points: number }[]; targetVoyage: VoyageImpact; cascadeVoyages: VoyageImpact[]; changes: PlannedChange[]; metrics: ReplanMetrics };
type ReplanSession = { id: string; voyageId: string; reason: string; actor: string; status: 'draft'|'confirmed'|'cancelled'|'failed'|'stale'; createdAt: string; updatedAt: string; originalEta: string; triggerEta: string; pendingEta?: string; etaNotice?: string; options: ReplanOption[]; selectedOptionId?: string; validationErrors?: { changeId: string; code: string; message: string }[]; failureReason?: string; applyResults?: { changeId: string; type: string; entityId: string; applied: boolean; skippedFrozen?: boolean; message?: string }[]; confirmedAt?: string; cancelledAt?: string; restoredChanges?: number };

const api = '/api';
const pct = (value: number) => `${Math.round(value * 100)}%`;
const time = (value: string) => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const shiftLabel = (minutes: number) => minutes === 0 ? '不变' : minutes > 0 ? `推迟 ${minutes} 分钟` : `提前 ${Math.abs(minutes)} 分钟`;
const windowText = (w: { eta: string; etd: string; berth: string }) => `${w.berth} · ${time(w.eta)}–${time(w.etd)}`;
const toLocalInput = (value?: string) => {
  const date = value ? new Date(value) : new Date(Date.now() + 30 * 60000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const defaultValues = (entity: Editor['entity']): Record<string, string|boolean> => {
  if (entity === 'container') return { id: '', voyageId: 'VOY-AX7', size: '40', isoType: '45G1', direction: 'import', status: 'in-yard', weightT: '20', reefer: false, temperature: '4', hazmatClass: '', customs: 'released', priority: 'normal', yardSlot: 'C03-R01-T1' };
  if (entity === 'appointment') return { containerId: '', truckNo: '', driver: '', type: 'pickup', windowStart: toLocalInput(), windowEnd: toLocalInput(new Date(Date.now() + 60 * 60000).toISOString()), lane: 'north' };
  return { kind: 'receive', containerId: '', from: '闸口', to: 'C03-R01-T1', equipmentId: '', priority: '50', scheduledAt: toLocalInput(), estimatedMinutes: '20', status: 'queued' };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `请求失败 (${response.status})`);
  return body as T;
}

export default function App() {
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [voyages, setVoyages] = useState<Voyage[]>([]);
  const [containers, setContainers] = useState<Container[]>([]);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [equipment, setEquipment] = useState<Equipment[]>([]);
  const [tab, setTab] = useState<Section>('control');
  const [selectedVoyage, setSelectedVoyage] = useState('VOY-AX7');
  const [editor, setEditor] = useState<Editor>();
  const [replanSession, setReplanSession] = useState<ReplanSession>();
  const [replanForm, setReplanForm] = useState({ voyageId: 'VOY-QF2', newEta: toLocalInput(), reason: '' });
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [d, v, ctn, b, cf, a, t, e] = await Promise.all([
      request<Dashboard>('/dashboard'), request<Voyage[]>('/voyages'), request<Container[]>('/containers'),
      request<Block[]>('/yard/heatmap'), request<Conflict[]>('/gate/conflicts'), request<Appointment[]>('/gate/appointments'),
      request<Task[]>('/tasks'), request<Equipment[]>('/equipment')
    ]);
    setDashboard(d); setVoyages(v); setContainers(ctn); setBlocks(b); setConflicts(cf); setAppointments(a); setTasks(t); setEquipment(e);
  }, []);
  useEffect(() => { void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }, [load]);

  const mutate = async (path: string, method: string, body?: unknown) => {
    setBusy(true); setError('');
    try {
      await request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      await load(); setEditor(undefined); setMessage('操作已保存，作业台数据已刷新');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败'); }
    finally { setBusy(false); }
  };
  const openCreate = (entity: Editor['entity']) => { setError(''); setEditor({ entity, mode: 'create', values: defaultValues(entity) }); };
  const openEdit = (entity: Editor['entity'], id: string, values: Record<string, string|boolean>) => { setError(''); setEditor({ entity, mode: 'edit', id, values: { ...values } }); };
  const updateField = (key: string, value: string|boolean) => setEditor(current => current ? { ...current, values: { ...current.values, [key]: value } } : current);
  const saveEditor = async (event: FormEvent) => {
    event.preventDefault(); if (!editor) return;
    const { entity, mode, id, values } = editor;
    const payload: Record<string, unknown> = entity === 'container' ? {
      ...(mode === 'create' ? { id: values.id } : {}), voyageId: values.voyageId, size: values.size, isoType: values.isoType,
      direction: values.direction, status: values.status, weightT: Number(values.weightT), reefer: Boolean(values.reefer),
      ...(values.reefer ? { temperature: Number(values.temperature) } : {}), ...(values.hazmatClass ? { hazmatClass: values.hazmatClass } : {}),
      customs: values.customs, priority: values.priority, yardSlot: values.yardSlot
    } : entity === 'appointment' ? {
      containerId: values.containerId, truckNo: values.truckNo, driver: values.driver, type: values.type,
      windowStart: new Date(String(values.windowStart)).toISOString(), windowEnd: new Date(String(values.windowEnd)).toISOString(), lane: values.lane
    } : {
      kind: values.kind, containerId: values.containerId, from: values.from, to: values.to, priority: Number(values.priority),
      scheduledAt: new Date(String(values.scheduledAt)).toISOString(), estimatedMinutes: Number(values.estimatedMinutes),
      ...(values.equipmentId ? { equipmentId: values.equipmentId } : {}), ...(mode === 'edit' ? { status: values.status } : {})
    };
    await mutate(entity === 'container' ? `/containers${mode === 'edit' ? `/${id}` : ''}` : entity === 'appointment' ? `/gate/appointments${mode === 'edit' ? `/${id}` : ''}` : `/tasks${mode === 'edit' ? `/${id}` : ''}`, mode === 'create' ? 'POST' : 'PATCH', payload);
  };
  const remove = async (entity: Editor['entity'], id: string) => {
    if (!window.confirm(`确认删除 ${id}？相关数据的联动处理会写入审计记录。`)) return;
    const path = entity === 'container' ? `/containers/${id}` : entity === 'appointment' ? `/gate/appointments/${id}` : `/tasks/${id}`;
    await mutate(path, 'DELETE');
  };
  const updateAppointmentStatus = async (id: string, status: string) => mutate(`/gate/appointments/${id}`, 'PATCH', { status });
  const assign = async (id: string, equipmentId: string) => equipmentId ? mutate(`/tasks/${id}/assign`, 'PATCH', { equipmentId }) : mutate(`/tasks/${id}`, 'PATCH', { equipmentId: '', status: 'queued' });

  const replanAction = async (path: string, body?: unknown, silent = false) => {
    setBusy(true);
    if (!silent) setError('');
    try {
      const result = await request<ReplanSession>(path, { method: 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) });
      setReplanSession(result);
      if (result.status === 'confirmed' || result.status === 'cancelled') await load();
      if (!silent) setMessage(result.status === 'confirmed' ? '重排方案已确认，关联航次/任务/预约/箱务已批量更新' : result.status === 'cancelled' ? '已取消重排，关联对象恢复到重排前状态' : '重排会话已更新');
    } catch (reason) {
      // STALE / CONFIRM_FAILED 时后端仍可能更新了会话状态，拉一次详情
      if (replanSession && path.endsWith('/confirm')) {
        try { const latest = await request<ReplanSession>(`/replan/sessions/${replanSession.id}`); setReplanSession(latest); } catch { /* ignore */ }
      }
      setError(reason instanceof Error ? reason.message : '重排操作失败');
    } finally { setBusy(false); }
  };
  const startNewReplan = async () => replanAction('/replan/sessions', { voyageId: replanForm.voyageId, newEta: new Date(replanForm.newEta).toISOString(), reason: replanForm.reason || undefined });
  const pushNewEta = async () => replanAction(`/replan/sessions/${replanSession!.id}/eta`, { newEta: new Date(replanForm.newEta).toISOString(), reason: replanForm.reason || '重排中船方再次更新 ETA' });
  const confirmSelected = async () => replanAction(`/replan/sessions/${replanSession!.id}/confirm`, {});
  const cancelSession = async () => replanAction(`/replan/sessions/${replanSession!.id}/cancel`, { reason: replanForm.reason || '调度员取消重排' });
  const selected = voyages.find(voyage => voyage.id === selectedVoyage);
  const remaining = selected ? selected.movesPlanned - selected.movesDone : 0;
  const maxHeat = useMemo(() => Math.max(...blocks.map(block => block.heat), 1), [blocks]);

  if (!dashboard && error) return <main className="connection-error"><div className="eyebrow">API CONNECTION ERROR</div><h1>无法连接港口作业服务</h1><p>{error}</p><p>请从项目根目录运行 <code>npm run dev</code>，确认前端 5178 和 API 4107 均已启动。</p><button onClick={() => { setError(''); void load().catch(reason => setError(reason instanceof Error ? reason.message : '无法连接服务端')); }}>重新连接</button></main>;
  if (!dashboard) return <div className="loading">正在连接码头实时作业中台…</div>;

  return <main>
    <header><div><div className="eyebrow">PORT OPS / YARD & GATE CONTROL</div><h1>HarborGrid <span>港口集装箱堆场协同与闸口调度</span></h1><p>把船期、箱务、堆场容量、危险品/冷藏约束、闸口预约与场内设备任务放在同一条作业链路上。</p></div><div className="header-right"><span className="live"><i/> TOS LINKED</span><span className="clock">LIVE · {new Date().toLocaleTimeString()}</span></div></header>
    {message && <div className="toast" onClick={() => setMessage('')}>{message} ×</div>}{error && <div className="form-error page-error">{error}<button onClick={() => setError('')}>关闭</button></div>}
    <section className="kpis"><div><small>ACTIVE VESSELS</small><b>{dashboard.activeVoyages}<em> 艘</em></b><span>{dashboard.lateVessels} 艘存在延误风险</span></div><div><small>YARD UTILIZATION</small><b>{pct(dashboard.yardUtilization)}</b><span>可用堆位 / 危险品隔离纳管</span></div><div><small>GATE QUEUE</small><b>{dashboard.gateQueue}<em> 车</em></b><span>预约、已进场与车道排队</span></div><div><small>EXCEPTIONS</small><b>{dashboard.blockedTasks + dashboard.reeferAlerts + dashboard.hazmatHolds}<em> 项</em></b><span>{dashboard.blockedTasks} 作业阻塞 · {dashboard.reeferAlerts} 冷藏告警</span></div></section>
    <nav className="tabs"><button className={tab==='control'?'active':''} onClick={() => setTab('control')}>作业驾驶舱</button><button className={tab==='containers'?'active':''} onClick={() => setTab('containers')}>箱务台账 / CRUD</button><button className={tab==='gate'?'active':''} onClick={() => setTab('gate')}>闸口预约</button><button className={tab==='yard'?'active':''} onClick={() => setTab('yard')}>堆场热区</button><button className={tab==='tasks'?'active':''} onClick={() => setTab('tasks')}>设备任务</button><button className={tab==='replan'?'active':''} onClick={() => setTab('replan')}>泊位窗口重排</button><span>最后同步 {new Date().toLocaleTimeString()}</span></nav>
    {tab === 'control' && <div className="layout"><section className="panel vessel-panel"><div className="panel-head"><div><div className="eyebrow">VESSEL WINDOW / 船期窗口</div><h2>泊位作业进度</h2></div><span className="muted">剩余作业动态计算</span></div>{voyages.map(voyage => <button key={voyage.id} className={`vessel ${selectedVoyage===voyage.id?'selected':''}`} onClick={() => setSelectedVoyage(voyage.id)}><span className={`vessel-dot ${voyage.status}`}/><span className="vessel-main"><b>{voyage.vessel}</b><small>{voyage.id} · {voyage.service} · {voyage.berth}</small><i><em style={{ width: `${Math.min(100, voyage.movesDone / voyage.movesPlanned * 100)}%` }}/></i></span><span className="vessel-move"><b>{voyage.movesDone.toLocaleString()}</b><small>/ {voyage.movesPlanned.toLocaleString()} moves</small></span><strong className={voyage.lateRisk}>{voyage.lateRisk==='high'?'HIGH':voyage.lateRisk==='medium'?'WATCH':'ON TIME'}</strong></button>)}</section><section className="panel focus-panel"><div className="panel-head"><div><div className="eyebrow">SELECTED VOYAGE / {selected?.id}</div><h2>{selected?.vessel}</h2></div><span className={`badge ${selected?.lateRisk}`}>{selected?.status}</span></div><div className="voyage-stats"><div><small>ETA</small><b>{selected&&time(selected.eta)}</b><span>预计靠泊</span></div><div><small>ETD</small><b>{selected&&time(selected.etd)}</b><span>计划离港</span></div><div><small>REMAINING</small><b>{remaining}</b><span>剩余翻箱</span></div></div><div className="berth-map"><div className="water"><span>岸线 / BERTH</span><i className="ship" style={{ left: `${selected?.berth==='B07'?50:24}%` }}>{selected?.vessel}</i><b>B01</b><b>B04</b><b>B07</b><b>B10</b></div></div><div className="callout"><strong>调度策略</strong><span>已把 {dashboard.blockedTasks} 个阻塞任务、{dashboard.gateQueue} 车闸口压力纳入当前窗口；优先保护冷藏与危险品安全约束。</span></div></section><section className="panel wide"><div className="panel-head"><h3>异常与联动信号</h3><span>{conflicts.length} gate conflicts detected</span></div><div className="signal-grid"><div><strong className="critical">{dashboard.blockedTasks}</strong><span>设备/约束阻塞</span><small>最高优先级：海关查验任务</small></div><div><strong className="warning">{conflicts.length}</strong><span>闸口预约冲突</span><small>同车重叠窗口需人工重排</small></div><div><strong className="warning">{dashboard.reeferAlerts}</strong><span>冷藏与温控风险</span><small>查验区电源余量接近阈值</small></div><div><strong className="ok">{equipment.filter(item => item.status==='available').length}</strong><span>可调度设备</span><small>场桥 / 正面吊 / 集卡</small></div></div></section></div>}
    {tab === 'containers' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">CONTAINER REGISTER / CRUD</div><h2>箱务台账</h2><span className="muted">新增、查询、编辑、删除；危险品与冷藏箱受堆场约束校验</span></div><button className="primary-action" onClick={() => openCreate('container')}>＋ 新增箱务</button></div><div className="table container-table"><div className="tr th"><span>箱号 / 航次</span><span>尺寸 / 流向</span><span>箱况 / 海关</span><span>堆位</span><span>重量 / 属性</span><span>操作</span></div>{containers.map(container => <div className="tr" key={container.id}><span><b>{container.id}</b><small>{container.voyageId} · {container.lastEvent}</small></span><span>{container.size}ft · {container.direction}<small>{container.isoType}</small></span><span><b>{container.status}</b><small>海关：{container.customs}</small></span><span>{container.yardSlot}</span><span>{container.weightT}t<small>{container.reefer?`冷藏 ${container.temperature}°C`:container.hazmatClass?`危险品 ${container.hazmatClass} 类`:'普通箱'}</small></span><span className="row-actions"><button onClick={() => openEdit('container', container.id, { ...container, weightT: String(container.weightT), temperature: String(container.temperature ?? 4), hazmatClass: container.hazmatClass ?? '' })}>编辑</button><button className="danger-action" onClick={() => void remove('container', container.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'gate' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">GATE APPOINTMENT / SLOT CONTROL</div><h2>闸口预约与车道状态</h2><span className="muted">支持新增预约、编辑时隙、签到/完成和删除</span></div><button className="primary-action" onClick={() => openCreate('appointment')}>＋ 新增预约</button></div>{conflicts.map(conflict => <div className="conflict" key={`${conflict.appointmentId}-${conflict.reason}`}><strong>{conflict.severity}</strong><b>{conflict.appointmentId}</b><span>{conflict.reason}</span></div>)}<div className="table"><div className="tr th"><span>预约</span><span>箱号 / 车辆</span><span>窗口</span><span>车道</span><span>状态</span><span>操作</span></div>{appointments.map(appointment => <div className="tr" key={appointment.id}><span><b>{appointment.id}</b><small>{appointment.type}</small></span><span><b>{appointment.containerId}</b><small>{appointment.truckNo} · {appointment.driver}</small></span><span>{time(appointment.windowStart)}—{time(appointment.windowEnd)}</span><span>{appointment.lane}</span><span className={`pill ${appointment.status}`}>{appointment.status}</span><span className="row-actions">{appointment.status==='booked'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'checked-in')}>签到</button>:appointment.status==='checked-in'?<button onClick={() => void updateAppointmentStatus(appointment.id, 'completed')}>完成</button>:null}<button onClick={() => openEdit('appointment', appointment.id, { ...appointment, windowStart: toLocalInput(appointment.windowStart), windowEnd: toLocalInput(appointment.windowEnd) })}>编辑</button><button className="danger-action" onClick={() => void remove('appointment', appointment.id)}>删除</button></span></div>)}</div></section>}
    {tab === 'yard' && <section className="panel wide"><div className="panel-head"><div><div className="eyebrow">YARD HEATMAP / STACK DENSITY</div><h2>堆场容量与安全约束</h2></div><span className="muted">实时区块压力</span></div><div className="yard-grid">{blocks.map(block => <div className={`block ${block.pressure}`} key={block.id}><div className="block-top"><b>{block.id}</b><strong>{pct(block.utilization)}</strong></div><span>{block.zone}</span><div className="heat"><i style={{ width: `${block.heat / maxHeat * 100}%` }}/></div><div className="block-stats"><span>空位 {block.freeSlots}</span><span>冷插 {block.usedPlugs}/{block.reeferPlugs}</span><span>{block.hazmatAllowed?'危险品可入':'普通区'}</span></div></div>)}</div><div className="yard-note"><span>堆位推荐会同时考虑容量、热区、危险品隔离、冷藏插座和设备可达性。</span><b>A01 → C03 重排建议可释放 21 个低热度堆位</b></div></section>}
    {tab === 'tasks' && <div className="layout"><section className="panel wide"><div className="panel-head"><div><div className="eyebrow">TASK DISPATCH / EQUIPMENT POOL</div><h2>场内任务优先级与设备指派</h2><span className="muted">支持新增、编辑、删除和设备指派</span></div><button className="primary-action" onClick={() => openCreate('task')}>＋ 新建任务</button></div><div className="table task-table"><div className="tr th"><span>任务</span><span>箱号</span><span>路径</span><span>优先级</span><span>状态</span><span>设备 / 操作</span></div>{tasks.map(task => <div className="tr" key={task.id}><span><b>{task.id}</b><small>{task.kind} · {task.estimatedMinutes}min</small></span><span>{task.containerId}</span><span>{task.from} → {task.to}</span><span className={task.score>95?'critical':''}>{task.score}</span><span><span className={`pill ${task.status}`}>{task.status}</span>{task.blockingReasons.length>0&&<small className="blocked-text">{task.blockingReasons[0]}</small>}</span><span className="task-actions"><select value={task.equipmentId??''} onChange={event => void assign(task.id, event.target.value)}><option value="">未指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button onClick={() => openEdit('task', task.id, { kind: task.kind, containerId: task.containerId, from: task.from, to: task.to, equipmentId: task.equipmentId ?? '', priority: String(task.priority), estimatedMinutes: String(task.estimatedMinutes), scheduledAt: toLocalInput(task.scheduledAt), status: task.status })}>编辑</button><button className="danger-action" onClick={() => void remove('task', task.id)}>删除</button></span></div>)}</div></section><section className="panel"><div className="panel-head"><h3>设备池</h3><span>{equipment.length} assets</span></div>{equipment.map(item => <div className="equipment" key={item.id}><i className={`equip-dot ${item.status}`}/><div><b>{item.name}</b><small>{item.location} · 队列 {item.queue}</small></div><strong>{item.battery}%</strong></div>)}</section></div>}
    {tab === 'replan' && <div className="layout">
      <section className="panel wide replan-launch">
        <div className="panel-head"><div><div className="eyebrow">BERTH WINDOW REPLAN / 泊位窗口重排</div><h2>发起窗口重排</h2><span className="muted">窗口、岸桥能力、装卸任务与未完成箱务一起重算，而不是只改 ETA</span></div></div>
        <div className="replan-form">
          <label>触发航次<select value={replanForm.voyageId} onChange={e => { setReplanForm(f => ({ ...f, voyageId: e.target.value })); const v = voyages.find(x => x.id === e.target.value); if (v) setReplanForm(f => ({ ...f, newEta: toLocalInput(new Date(new Date(v.eta).getTime() + 120 * 60000).toISOString()) })); }}>{voyages.filter(v => v.status !== 'departed').map(v => <option key={v.id} value={v.id}>{v.id} · {v.vessel} · {v.berth}（{time(v.eta)}）</option>)}</select></label>
          <label>船方最新 ETA<input type="datetime-local" value={replanForm.newEta} onChange={e => setReplanForm(f => ({ ...f, newEta: e.target.value }))}/></label>
          <label className="replan-reason">延误 / 提前原因<input placeholder="例如：台风航道管制，预计晚到 110 分钟" value={replanForm.reason} onChange={e => setReplanForm(f => ({ ...f, reason: e.target.value }))}/></label>
          <button className="primary-action" disabled={busy || (replanSession?.status === 'draft')} onClick={() => void startNewReplan()}>生成可比较方案</button>
        </div>
        {replanSession && <div className={`replan-status ${replanSession.status}`}><b>会话 {replanSession.id}</b><span>状态：{({ draft: '待确认', confirmed: '已确认生效', cancelled: '已取消', failed: '部分失败已回滚', stale: '依据失效需重算' } as Record<string, string>)[replanSession.status]}</span><span>触发航次：{replanSession.voyageId} · {new Date(replanSession.triggerEta).toLocaleString()}</span>{replanSession.failureReason && <small>失败原因：{replanSession.failureReason}</small>}{replanSession.restoredChanges !== undefined && <small>已恢复 {replanSession.restoredChanges} 项</small>}</div>}
      </section>

      {replanSession?.etaNotice && <section className="panel wide conflict"><strong>NEW ETA</strong><span>{replanSession.etaNotice}（{new Date(replanSession.triggerEta).toLocaleString()}）</span></section>}
      {replanSession?.status === 'stale' && replanSession.validationErrors && <section className="panel wide conflict"><strong>STALE</strong><div>{replanSession.validationErrors.slice(0, 4).map(e => <span key={e.changeId}>{e.message}</span>)}</div></section>}

      {replanSession && replanSession.options.map(option => {
        const selected = replanSession.selectedOptionId === option.id;
        const impacts = [option.targetVoyage, ...option.cascadeVoyages];
        return <section key={option.id} className={`panel wide option-card ${selected ? 'selected' : ''} ${!option.feasible ? 'infeasible' : ''}`}>
          <div className="option-head" onClick={() => replanSession.status === 'draft' && replanAction(`/replan/sessions/${replanSession.id}/select`, { optionId: option.id }, true)}>
            <div><div className="eyebrow">{option.recommended ? 'RECOMMENDED · 推荐方案' : `方案 ${option.id.toUpperCase()}`}</div><h3>{option.label}</h3><p>{option.description}</p>{!option.feasible && <div className="infeasible-tag">不可行：{option.infeasibleReason}</div>}</div>
            <div className="option-side"><b className={option.score >= 60 ? 'ok' : option.score >= 30 ? 'warning' : 'critical'}>{option.score}</b><small>综合评分</small>{selected && <span className="pill checked-in">已选</span>}</div>
          </div>
          <div className="option-metrics">{[
            ['受影响航次', option.metrics.affectedVoyages], ['任务平移', option.metrics.movedTasks], ['冻结(不可回滚)', option.metrics.frozenTasks],
            ['岸桥改派', option.metrics.craneReassignments], ['预约联动', option.metrics.shiftedAppointments], ['箱务标注', option.metrics.containerNotes], ['预警', option.metrics.warnings, 'warning'], ['冲突', option.metrics.conflicts, 'critical'],
          ].map((m, i) => <div key={i}><strong className={m[2] as string}>{m[1] as number}</strong><span>{m[0] as string}</span></div>)}</div>

          <div className="impact-voyages">
            {impacts.map(impact => {
              const changes = option.changes.filter(c => c.voyageId === impact.voyageId);
              const taskChanges = changes.filter(c => c.entity === 'task');
              const aptChanges = changes.filter(c => c.type === 'appointment-shift');
              const ctrChanges = changes.filter(c => c.type === 'container-note');
              return <div key={impact.voyageId} className={`impact-block ${impact.role}`}>
                <div className="impact-title"><span className={`pill ${impact.role === 'target' ? 'checked-in' : 'queued'}`}>{impact.role === 'target' ? '触发航次' : '级联航次'}</span><b>{impact.vessel}（{impact.voyageId}）</b><strong className={impact.shiftMinutes > 0 ? 'critical' : impact.shiftMinutes < 0 ? 'ok' : ''}>{shiftLabel(impact.shiftMinutes)}</strong></div>
                <div className="window-compare"><span><small>原窗口</small><i>{windowText(impact.before)}</i></span><b>→</b><span><small>重排窗口</small><i>{windowText(impact.after)}</i></span></div>
                {impact.conflictsWith?.map(c => <div key={c.voyageId} className="conflict-line critical">泊位冲突：{c.voyageId === '*' ? c.reason : `${c.voyageId} — ${c.reason}`}</div>)}
                {impact.lockedCranes?.map(l => <div key={l.craneId} className="conflict-line warning">岸桥锁定：{l.craneId} 已派给 {l.holderVoyageId}；{l.resolution}</div>)}
                <div className="impact-children">
                  <div className="child-col"><small>任务影响（{taskChanges.length}）</small>
                    {taskChanges.length === 0 ? <i className="muted">无关联任务</i> : taskChanges.map(c => <div key={c.id} className={`child-row ${c.frozen ? 'frozen' : ''}`}><b>{c.entityId}</b><span>{c.type === 'task-shift' ? `计划 ${time(String(c.before.scheduledAt))} → ${time(String(c.after.scheduledAt))}` : c.type === 'task-equipment' ? `岸桥 ${String(c.before.equipmentId ?? '未派')} → ${String(c.after.equipmentId ?? '未派')}${c.after.to ? `；目的地改 ${String(c.after.to)}` : ''}` : '作业冻结'}</span>{c.frozen && <em className="frozen-tag">不可回滚</em>}<small className="reason-text">{c.reason.text}</small></div>)}
                  </div>
                  <div className="child-col"><small>闸口预约（{aptChanges.length}）</small>
                    {aptChanges.length === 0 ? <i className="muted">预约无需联动</i> : aptChanges.map(c => <div key={c.id} className={`child-row ${c.frozen ? 'frozen' : ''}`}><b>{c.entityId}</b><span>{time(String(c.before.windowStart))} → {time(String(c.after.windowStart))}</span>{c.frozen && <em className="frozen-tag">已进场</em>}<small className="reason-text">{c.reason.text}</small></div>)}
                  </div>
                  <div className="child-col"><small>未完成箱务（{ctrChanges.length}）</small>
                    {ctrChanges.length === 0 ? <i className="muted">无箱务需标注</i> : ctrChanges.slice(0, 3).map(c => <div key={c.id} className="child-row"><b>{c.entityId}</b><small className="reason-text">{c.reason.text}</small></div>)}
                    {ctrChanges.length > 3 && <i className="muted">…另 {ctrChanges.length - 3} 箱同因标注</i>}
                  </div>
                </div>
              </div>;
            })}
          </div>
          <div className="score-breakdown">{option.scoreBreakdown.map((b, i) => <span key={i} className={b.points < 0 ? 'neg' : 'pos'}>{b.label}（{b.points > 0 ? `+${b.points}` : b.points}）</span>)}</div>
        </section>;
      })}

      {replanSession && (replanSession.status === 'draft' || replanSession.status === 'failed' || replanSession.status === 'stale') && <section className="panel wide replan-actions">
        <div className="panel-head"><h3>调度员操作</h3><span className="muted">确认 = 两阶段校验通过后批量提交；任何一项写入失败会整批回滚</span></div>
        <div className="replan-action-btns">
          <label>重排中收到更新 ETA？<input type="datetime-local" value={replanForm.newEta} onChange={e => setReplanForm(f => ({ ...f, newEta: e.target.value }))}/></label>
          <button disabled={busy || replanSession.status !== 'draft'} onClick={() => void pushNewEta()}>接收新 ETA 并重算</button>
          <button className="primary-action" disabled={busy || replanSession.status !== 'draft' || !replanSession.selectedOptionId} onClick={() => void confirmSelected()}>{busy ? '提交中…' : `确认方案${replanSession.selectedOptionId ? `（${replanSession.selectedOptionId}）` : ''}`}</button>
          <button className="danger-action" disabled={busy} onClick={() => void cancelSession()}>取消重排并恢复</button>
        </div>
      </section>}

      {replanSession?.status === 'confirmed' && replanSession.applyResults && <section className="panel wide">
        <div className="panel-head"><h3>确认结果</h3><span className="muted">确认时间 {new Date(replanSession.confirmedAt!).toLocaleString()}</span></div>
        <div className="apply-grid"><div><strong className="ok">{replanSession.applyResults.filter(r => r.applied).length}</strong><span>已批量更新</span></div><div><strong className="warning">{replanSession.applyResults.filter(r => r.skippedFrozen).length}</strong><span>冻结/跳过（已开始或已锁定）</span></div></div>
      </section>}
    </div>}
    <footer>HarborGrid · 内存种子数据 + REST API · 箱务台账、闸口预约、场内任务提供完整增删改查操作</footer>
    {editor && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setEditor(undefined); }}><form className="editor-modal" onSubmit={saveEditor}><div className="modal-head"><div><div className="eyebrow">{editor.mode.toUpperCase()} / {editor.entity.toUpperCase()}</div><h2>{editor.mode==='create'?'创建':'编辑'}{editor.entity==='container'?'箱务记录':editor.entity==='appointment'?'闸口预约':'作业任务'}</h2></div><button type="button" className="icon-button" onClick={() => setEditor(undefined)}>×</button></div>
      {editor.entity === 'container' && <div className="form-grid">
        <label>集装箱号<input required disabled={editor.mode==='edit'} value={String(editor.values.id)} onChange={event => updateField('id', event.target.value.toUpperCase())}/></label>
        <label>关联航次<select value={String(editor.values.voyageId)} onChange={event => updateField('voyageId', event.target.value)}>{voyages.filter(voyage => voyage.status!=='departed').map(voyage => <option key={voyage.id} value={voyage.id}>{voyage.id} · {voyage.vessel}</option>)}</select></label>
        <label>尺寸<select value={String(editor.values.size)} onChange={event => updateField('size', event.target.value)}><option value="20">20 ft</option><option value="40">40 ft</option><option value="45">45 ft</option></select></label>
        <label>ISO 箱型<input required value={String(editor.values.isoType)} onChange={event => updateField('isoType', event.target.value)}/></label>
        <label>作业流向<select value={String(editor.values.direction)} onChange={event => updateField('direction', event.target.value)}><option value="import">进口</option><option value="export">出口</option><option value="transshipment">中转</option></select></label>
        <label>箱状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['in-transit','at-gate','in-yard','on-quay','released','hold'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>重量 (吨)<input type="number" min="0.1" step="0.1" required value={String(editor.values.weightT)} onChange={event => updateField('weightT', event.target.value)}/></label>
        <label>海关状态<select value={String(editor.values.customs)} onChange={event => updateField('customs', event.target.value)}><option value="released">已放行</option><option value="inspection">查验中</option><option value="hold">扣留</option></select></label>
        <label>优先级<select value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}><option value="normal">普通</option><option value="hot">急箱</option><option value="reefer">冷藏</option><option value="hazmat">危险品</option></select></label>
        <label>堆位<input required placeholder="例如 B07-R03-T2" value={String(editor.values.yardSlot)} onChange={event => updateField('yardSlot', event.target.value.toUpperCase())}/></label>
        <label>危险品类别<input placeholder="非危险品留空" value={String(editor.values.hazmatClass)} onChange={event => updateField('hazmatClass', event.target.value)}/></label>
        <label className="check-label"><input type="checkbox" checked={Boolean(editor.values.reefer)} onChange={event => updateField('reefer', event.target.checked)}/>冷藏箱</label>
        {Boolean(editor.values.reefer) && <label>目标温度 (°C)<input type="number" step="0.1" value={String(editor.values.temperature)} onChange={event => updateField('temperature', event.target.value)}/></label>}
      </div>}
      {editor.entity === 'appointment' && <div className="form-grid">
        <label>集装箱<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id} · {container.status}</option>)}</select></label>
        <label>预约类型<select value={String(editor.values.type)} onChange={event => updateField('type', event.target.value)}><option value="pickup">提箱</option><option value="dropoff">进场</option></select></label>
        <label>车牌号<input required value={String(editor.values.truckNo)} onChange={event => updateField('truckNo', event.target.value)}/></label><label>司机<input required value={String(editor.values.driver)} onChange={event => updateField('driver', event.target.value)}/></label>
        <label>窗口开始<input type="datetime-local" required value={String(editor.values.windowStart)} onChange={event => updateField('windowStart', event.target.value)}/></label><label>窗口结束<input type="datetime-local" required value={String(editor.values.windowEnd)} onChange={event => updateField('windowEnd', event.target.value)}/></label>
        <label>闸口车道<select value={String(editor.values.lane)} onChange={event => updateField('lane', event.target.value)}><option value="north">北闸口</option><option value="south">南闸口</option><option value="rail">铁路闸口</option></select></label>
      </div>}
      {editor.entity === 'task' && <div className="form-grid">
        <label>任务类型<select value={String(editor.values.kind)} onChange={event => updateField('kind', event.target.value)}>{['receive','deliver','rehandle','load','discharge','inspect'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
        <label>关联箱号<select required value={String(editor.values.containerId)} onChange={event => updateField('containerId', event.target.value)}><option value="">选择箱号</option>{containers.map(container => <option key={container.id} value={container.id}>{container.id}</option>)}</select></label>
        <label>起点<input required value={String(editor.values.from)} onChange={event => updateField('from', event.target.value)}/></label><label>终点<input required value={String(editor.values.to)} onChange={event => updateField('to', event.target.value)}/></label>
        <label>优先级 (1–100)<input type="number" min="1" max="100" required value={String(editor.values.priority)} onChange={event => updateField('priority', event.target.value)}/></label><label>预计时长 (分钟)<input type="number" min="1" required value={String(editor.values.estimatedMinutes)} onChange={event => updateField('estimatedMinutes', event.target.value)}/></label>
        <label>计划时间<input type="datetime-local" required value={String(editor.values.scheduledAt)} onChange={event => updateField('scheduledAt', event.target.value)}/></label><label>指派设备<select value={String(editor.values.equipmentId)} onChange={event => updateField('equipmentId', event.target.value)}><option value="">暂不指派</option>{equipment.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label>
        {editor.mode==='edit' && <label>任务状态<select value={String(editor.values.status)} onChange={event => updateField('status', event.target.value)}>{['queued','assigned','executing','blocked','done'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
      </div>}
      {error && <div className="form-error">{error}</div>}<div className="modal-actions"><button type="button" onClick={() => setEditor(undefined)}>取消</button><button className="primary-action" disabled={busy}>{busy?'保存中…':'保存'}</button></div>
    </form></div>}
  </main>;
}
