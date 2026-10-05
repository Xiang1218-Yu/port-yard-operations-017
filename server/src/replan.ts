import { appointments, auditEvents, containers, equipment, recordAudit, tasks, voyages, type GateAppointment, type Voyage, type YardTask } from './domain.js';

/* ------------------------------------------------------------------ */
/* 类型定义                                                            */
/* ------------------------------------------------------------------ */

export type ReplanStrategy = 'sequence' | 'berth-switch' | 'compress' | 'anchorage-hold' | 'eta-only';
export type SessionStatus = 'draft' | 'confirmed' | 'cancelled' | 'failed' | 'stale';
export type ChangeType = 'voyage-window' | 'task-shift' | 'task-equipment' | 'appointment-shift' | 'container-note' | 'freeze-task';
export type ChangeRisk = 'none' | 'warning' | 'critical';

export interface ReplanRequest {
  voyageId: string;
  /** 船方/港调最新报告的 ETA（ISO） */
  newEta: string;
  /** 可选：强制要求离泊时间；缺省按作业量与窗口推算 */
  requestedEtd?: string;
  reason?: string;
  actor?: string;
}

export interface ChangeReason {
  /** 提前为负、推迟为正（分钟） */
  shiftMinutes: number;
  direction: 'delayed' | 'advanced' | 'unchanged';
  text: string;
}

export interface PlannedChange {
  id: string;
  type: ChangeType;
  entity: 'voyage' | 'task' | 'appointment' | 'container' | 'equipment';
  entityId: string;
  voyageId: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  risk: ChangeRisk;
  frozen: boolean;
  frozenReason?: string;
  reason: ChangeReason;
  preconditions?: { type: 'task-not-started' | 'berth-free' | 'equipment-usable'; detail: string }[];
}

export interface VoyageImpact {
  voyageId: string;
  vessel: string;
  role: 'target' | 'cascade';
  before: { eta: string; etd: string; berth: string };
  after: { eta: string; etd: string; berth: string };
  shiftMinutes: number;
  conflictsWith?: { voyageId: string; reason: string }[];
  lockedCranes?: { craneId: string; holderVoyageId: string; resolution: string }[];
}

export interface ReplanMetrics {
  affectedVoyages: number;
  delayedVoyages: number;
  advancedVoyages: number;
  movedTasks: number;
  frozenTasks: number;
  craneReassignments: number;
  shiftedAppointments: number;
  containerNotes: number;
  warnings: number;
  conflicts: number;
  /** 岸桥峰值负载（moves/hour），压缩方案用 */
  craneDensity?: number;
}

export interface ReplanOption {
  id: ReplanStrategy;
  label: string;
  description: string;
  feasible: boolean;
  infeasibleReason?: string;
  recommended: boolean;
  score: number;
  scoreBreakdown: { label: string; points: number }[];
  targetVoyage: VoyageImpact;
  cascadeVoyages: VoyageImpact[];
  changes: PlannedChange[];
  metrics: ReplanMetrics;
}

export interface ReplanSession {
  id: string;
  voyageId: string;
  reason: string;
  actor: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  /** 建会话时的现状快照（航次窗口 + 任务 + 预约），取消时按此恢复 */
  baseline: Snapshot;
  /** 建会话时航次原计划 ETA */
  originalEta: string;
  /** 本次重排的触发 ETA */
  triggerEta: string;
  /** 重排中又收到的新 ETA */
  pendingEta?: string;
  options: ReplanOption[];
  selectedOptionId?: ReplanStrategy;
  etaNotice?: string;
  stateVersion: number;
  confirmedAt?: string;
  applyResults?: ApplyItemResult[];
  validationErrors?: { changeId: string; code: string; message: string }[];
  failureReason?: string;
  cancelledAt?: string;
  restoredChanges?: number;
}

export interface ApplyItemResult {
  changeId: string;
  type: ChangeType;
  entityId: string;
  applied: boolean;
  skippedFrozen?: boolean;
  message?: string;
}

interface Snapshot {
  voyages: Record<string, Voyage>;
  tasks: Record<string, YardTask>;
  appointments: Record<string, GateAppointment>;
  containers: Record<string, string>;
}

export class ReplanError extends Error {
  constructor(public code: 'NOT_FOUND' | 'INVALID_STATE' | 'CONFLICT' | 'STALE' | 'CONFIRM_FAILED', message: string, public details?: unknown) {
    super(message);
  }
}

/* ------------------------------------------------------------------ */
/* 会话存储与状态版本                                                  */
/* ------------------------------------------------------------------ */

const sessions = new Map<string, ReplanSession>();
let stateVersion = 0;
let sequence = 0;

/** 领域数据发生可能影响重排校验的变化时（任务状态变更等）调用 */
export function bumpStateVersion() { stateVersion += 1; }
export function currentStateVersion() { return stateVersion; }
export function listReplanSessions() { return [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
export function getReplanSession(id: string) { return sessions.get(id); }

const MIN = 60_000;
const isoNow = () => new Date().toISOString();
const t = (value: string) => new Date(value).getTime();
const shiftIso = (value: string, minutes: number) => new Date(t(value) + minutes * MIN).toISOString();
const minutesBetween = (a: string, b: string) => Math.round((t(b) - t(a)) / MIN);
const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
const isFinished = (status: string) => status === 'done';
const isStarted = (status: string) => status === 'executing' || isFinished(status);
const isMutableTask = (task: YardTask) => !isStarted(task.status);
const dir = (minutes: number): ChangeReason['direction'] => (minutes > 0 ? 'delayed' : minutes < 0 ? 'advanced' : 'unchanged');
const reasonOf = (minutes: number, text: string): ChangeReason => ({ shiftMinutes: minutes, direction: dir(minutes), text });
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`;

/* ---------- 快照 ---------- */

function takeSnapshot(): Snapshot {
  return {
    voyages: Object.fromEntries(voyages.map(v => [v.id, { ...v, windowHistory: v.windowHistory?.map(h => ({ ...h })) }])),
    tasks: Object.fromEntries(tasks.map(item => [item.id, { ...item, blockingReasons: [...item.blockingReasons] }])),
    appointments: Object.fromEntries(appointments.map(a => [a.id, { ...a }])),
    containers: Object.fromEntries(containers.map(c => [c.id, c.lastEvent])),
  };
}

function cloneSnapshot(snapshot: Snapshot): Snapshot {
  return {
    voyages: Object.fromEntries(Object.entries(snapshot.voyages).map(([k, v]) => [k, { ...v, windowHistory: v.windowHistory?.map(h => ({ ...h })) }])),
    tasks: Object.fromEntries(Object.entries(snapshot.tasks).map(([k, v]) => [k, { ...v, blockingReasons: [...v.blockingReasons] }])),
    appointments: Object.fromEntries(Object.entries(snapshot.appointments).map(([k, v]) => [k, { ...v }])),
    containers: { ...snapshot.containers },
  };
}

/* ---------- 关联对象查询 ---------- */

const activeVoyages = () => voyages.filter(v => v.status !== 'departed');
const voyageContainers = (voyageId: string) => containers.filter(c => c.voyageId === voyageId);
const voyageTasks = (voyageId: string) => {
  const ids = new Set(voyageContainers(voyageId).map(c => c.id));
  return tasks.filter(task => ids.has(task.containerId));
};
const voyageAppointments = (voyageId: string) => {
  const ids = new Set(voyageContainers(voyageId).map(c => c.id));
  return appointments.filter(a => ids.has(a.containerId));
};
const quayCranes = () => equipment.filter(e => e.kind === 'quay-crane');

/** 岸桥当前锁定在哪条航次（任务指派或驻位描述） */
function craneHolder(craneId: string): string | undefined {
  const owner = tasks.find(task => task.equipmentId === craneId && !isFinished(task.status) && /\/\s*VOY-/.test(task.to) && voyageIdFromTarget(task.to));
  if (owner) return voyageIdFromTarget(owner.to);
  const machine = equipment.find(e => e.id === craneId);
  const atVoyage = machine?.location.match(/VOY-[A-Z0-9]+/);
  return atVoyage?.[0];
}
function voyageIdFromTarget(target: string) { return target.match(/VOY-[A-Z0-9]+/)?.[0]; }

/* ------------------------------------------------------------------ */
/* 方案生成                                                            */
/* ------------------------------------------------------------------ */

export function startReplan(input: ReplanRequest): ReplanSession {
  const voyage = voyages.find(v => v.id === input.voyageId);
  if (!voyage) throw new ReplanError('NOT_FOUND', `航次 ${input.voyageId} 不存在`);
  if (voyage.status === 'departed') throw new ReplanError('INVALID_STATE', '已离港航次不能重排泊位窗口');
  if (!input.newEta || Number.isNaN(t(input.newEta))) throw new ReplanError('INVALID_STATE', '新 ETA 格式不合法');

  // 同一航次存在未关闭会话时直接顶替，并把旧会话标记为取消（恢复基线由其自身快照保证）
  const existing = [...sessions.values()].find(s => s.voyageId === voyage.id && (s.status === 'draft' || s.status === 'stale' || s.status === 'failed'));
  if (existing) {
    existing.restoredChanges = restoreBaseline(existing);
    existing.status = 'cancelled';
    existing.cancelledAt = isoNow();
    existing.failureReason = '同航次发起了新的重排会话，原草稿作废';
  }

  const baseline = takeSnapshot();
  voyage.reportedEta = input.newEta;
  const session: ReplanSession = {
    id: newId('RPL'),
    voyageId: voyage.id,
    reason: input.reason?.trim() || (t(input.newEta) > t(voyage.eta) ? '船方报告延误靠泊' : '船方报告提前抵港'),
    actor: input.actor?.trim() || '中控调度员',
    status: 'draft',
    createdAt: isoNow(), updatedAt: isoNow(),
    baseline,
    originalEta: voyage.eta,
    triggerEta: input.newEta,
    options: [],
    stateVersion,
  };
  session.options = buildOptions(session, input.requestedEtd ? t(input.requestedEtd) : undefined);
  sessions.set(session.id, session);
  bumpStateVersion();
  return session;
}

/** 重排中又收到新 ETA：作废已选方案并重新生成可比较方案 */
export function receiveNewEta(sessionId: string, newEta: string, reason?: string): ReplanSession {
  const session = mustGet(sessionId);
  if (session.status === 'confirmed') throw new ReplanError('CONFLICT', '方案已确认生效，新 ETA 请发起新一轮重排');
  if (session.status === 'cancelled') throw new ReplanError('CONFLICT', '重排已取消，不能再接收新 ETA');
  if (!newEta || Number.isNaN(t(newEta))) throw new ReplanError('INVALID_STATE', '新 ETA 格式不合法');
  const voyage = mustVoyage(session.voyageId);
  voyage.reportedEta = newEta;
  session.pendingEta = newEta;
  session.triggerEta = newEta;
  session.selectedOptionId = undefined;
  session.etaNotice = `重排过程中收到更新的 ETA（${reason || '船方更新'}），原方案已作废，请重新比选`;
  session.validationErrors = undefined;
  session.options = buildOptions(session, undefined);
  session.status = 'draft';
  session.updatedAt = isoNow();
  return session;
}

export function selectOption(sessionId: string, optionId: ReplanStrategy): ReplanSession {
  const session = mustGet(sessionId);
  assertOpen(session);
  if (!session.options.some(o => o.id === optionId)) throw new ReplanError('NOT_FOUND', `方案 ${optionId} 不存在`);
  session.selectedOptionId = optionId;
  session.updatedAt = isoNow();
  return session;
}

/* ---------- 方案构造 ---------- */

interface Context {
  voyage: Voyage;
  deltaMinutes: number;
  early: boolean;
  berthed: boolean;
}

function buildOptions(session: ReplanSession, requestedEtdMs?: number): ReplanOption[] {
  const voyage = mustVoyage(session.voyageId);
  const delta = minutesBetween(voyage.eta, session.triggerEta);
  const ctx: Context = { voyage, deltaMinutes: delta, early: delta < 0, berthed: voyage.status === 'berthed' || voyage.status === 'loading' };
  const options: ReplanOption[] = [];

  const sequence = buildSequence(session, ctx, requestedEtdMs);
  if (sequence) options.push(sequence);
  if (!ctx.berthed) options.push(buildBerthSwitch(session, ctx));
  options.push(buildCompress(session, ctx));
  if (ctx.early && !ctx.berthed) options.push(buildAnchorageHold(session, ctx));
  options.push(buildEtaOnly(session, ctx));

  // 推荐：可行方案中得分最高
  const feasible = options.filter(o => o.feasible);
  if (feasible.length) {
    const best = feasible.reduce((a, b) => (b.score > a.score ? b : a));
    best.recommended = true;
  }
  return options;
}

function windowImpact(session: ReplanSession, role: VoyageImpact['role'], voyage: Voyage, nextEta: string, nextEtd: string, nextBerth: string, changes: PlannedChange[]): VoyageImpact {
  const shift = minutesBetween(voyage.eta, nextEta);
  const conflicts: VoyageImpact['conflictsWith'] = [];
  for (const other of activeVoyages()) {
    if (other.id === voyage.id || other.berth !== nextBerth) continue;
    if (overlap(t(nextEta), t(nextEtd), t(other.eta), t(other.etd))) {
      conflicts.push({ voyageId: other.id, reason: `${other.vessel} 占用 ${nextBerth} 至 ${clock(other.etd)}，窗口仍然重叠` });
    }
  }
  const lockedCranes: NonNullable<VoyageImpact['lockedCranes']> = [];
  for (const crane of quayCranes()) {
    const holder = craneHolder(crane.id);
    if (holder && holder !== voyage.id && crane.location.includes(voyage.berth)) {
      lockedCranes.push({ craneId: crane.id, holderVoyageId: holder, resolution: '顺延方案保留该桥给原航次，本航次改派空闲岸桥' });
    }
  }
  const impact: VoyageImpact = {
    voyageId: voyage.id, vessel: voyage.vessel, role,
    before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
    after: { eta: nextEta, etd: nextEtd, berth: nextBerth },
    shiftMinutes: shift,
  };
  if (conflicts.length) impact.conflictsWith = conflicts;
  if (lockedCranes.length) impact.lockedCranes = lockedCranes;

  changes.push({
    id: newId('CHG'), type: 'voyage-window', entity: 'voyage', entityId: voyage.id, voyageId: voyage.id,
    before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
    after: { eta: nextEta, etd: nextEtd, berth: nextBerth },
    risk: conflicts.length ? 'critical' : 'none',
    frozen: false,
    reason: reasonOf(shift, role === 'target'
      ? session.reason
      : `前序航次 ${session.voyageId} 窗口调整，为消除 ${voyage.berth} 泊位冲突联动顺延`),
    preconditions: [{ type: 'berth-free', detail: `确认时 ${nextBerth} 在该时段不得被其他航次占用` }],
  });
  return impact;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** 方案一：顺延同泊位，连带平移后续冲突航次、任务、预约 */
function buildSequence(session: ReplanSession, ctx: Context, requestedEtdMs?: number): ReplanOption | null {
  const { voyage, deltaMinutes: delta, berthed } = ctx;
  if (berthed) return null; // 在泊航次不存在"顺延靠泊"
  const nextEta = session.triggerEta;
  const nextEtd = requestedEtdMs ? new Date(requestedEtdMs).toISOString() : shiftIso(voyage.etd, delta);
  const changes: PlannedChange[] = [];
  const targetImpact = windowImpact(session, 'target', voyage, nextEta, nextEtd, voyage.berth, changes);

  // 同泊位后续航次级联顺延：按靠泊时间排序，逐条消除与"前一条窗口"的重叠
  const cascade: VoyageImpact[] = [];
  let lastEnd = t(nextEtd);
  for (const other of activeVoyages().filter(v => v.berth === voyage.berth && v.id !== voyage.id).sort((a, b) => t(a.eta) - t(b.eta))) {
    if (t(other.eta) >= lastEnd) { lastEnd = t(other.etd); continue; }
    const push = Math.round((lastEnd - t(other.eta)) / MIN);
    const cEta = shiftIso(other.eta, push);
    const cEtd = shiftIso(other.etd, push);
    cascade.push(windowImpact(session, 'cascade', other, cEta, cEtd, other.berth, changes));
    shiftTasksOfVoyage(session, other, push, changes);
    shiftAppointmentsOfVoyage(other, push, changes);
    addContainerNotes(session, other, push, changes);
    lastEnd = t(cEtd);
  }

  shiftTasksOfVoyage(session, voyage, delta, changes);
  shiftAppointmentsOfVoyage(voyage, delta, changes);
  addContainerNotes(session, voyage, delta, changes);
  applyCraneLockAdvisories(session, voyage, changes, targetImpact);

  const remainingConflict = targetImpact.conflictsWith?.some(c => !cascade.some(im => im.voyageId === c.voyageId)) ?? false;
  if (!remainingConflict && targetImpact.conflictsWith?.length) {
    // 冲突已通过级联顺延消除：保留"曾与谁冲突"的信息，但不再按 critical 呈现
    const windowChange = changes.find(c => c.type === 'voyage-window' && c.entityId === voyage.id);
    if (windowChange) windowChange.risk = 'none';
  }
  const metrics = computeMetrics([targetImpact, ...cascade], changes);
  const scoreBreakdown = [
    { label: '保持原泊位与岸桥动线', points: 30 },
    { label: metrics.cascadeVoyageCount ? `级联 ${metrics.cascadeVoyageCount} 条后续航次` : '无级联航次', points: metrics.cascadeVoyageCount ? -8 * metrics.cascadeVoyageCount : 8 },
    { label: metrics.shiftedAppointments ? `平移 ${metrics.shiftedAppointments} 个闸口预约` : '闸口预约无需调整', points: metrics.shiftedAppointments ? -4 * metrics.shiftedAppointments : 6 },
    { label: metrics.frozenTasks ? `${metrics.frozenTasks} 个已开始作业保持不动` : '无在执行作业', points: metrics.frozenTasks ? -6 : 4 },
    { label: remainingConflict ? '仍存在泊位冲突' : '泊位冲突全部消除', points: remainingConflict ? -40 : 18 },
  ];
  return {
    id: 'sequence', label: '顺延同泊位窗口', description: `按新 ETA 整体平移 ${voyage.berth} 窗口，同泊位后续航次与未开始任务、闸口预约联动顺延；已开始作业不动。`,
    feasible: !remainingConflict,
    infeasibleReason: remainingConflict ? '顺延后仍有航次窗口冲突，需要换泊或与船方重新协商' : undefined,
    recommended: false, score: clampScore(60 + scoreBreakdown.reduce((s, i) => s + i.points, 0)), scoreBreakdown,
    targetVoyage: targetImpact, cascadeVoyages: cascade, changes, metrics,
  };
}

/** 方案二：改靠空闲泊位，无级联 */
function buildBerthSwitch(session: ReplanSession, ctx: Context): ReplanOption {
  const { voyage, deltaMinutes: delta } = ctx;
  const nextEta = session.triggerEta;
  const nextEtd = shiftIso(voyage.etd, delta);
  const candidate = findFreeBerth(nextEta, nextEtd);
  const changes: PlannedChange[] = [];

  if (!candidate) {
    const impact: VoyageImpact = {
      voyageId: voyage.id, vessel: voyage.vessel, role: 'target',
      before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
      after: { eta: nextEta, etd: nextEtd, berth: voyage.berth }, shiftMinutes: delta,
      conflictsWith: [{ voyageId: '*', reason: '新 ETA 时段没有空闲泊位与岸桥' }],
    };
    return {
      id: 'berth-switch', label: '改靠空闲泊位', description: '将航次调整到窗口空闲的泊位，避免顺延后续航次。',
      feasible: false, infeasibleReason: '新 ETA 时段所有备选泊位均被占用或无可用岸桥', recommended: false,
      score: 0, scoreBreakdown: [], targetVoyage: impact, cascadeVoyages: [], changes, metrics: computeMetrics([impact], []),
    };
  }

  const impact = windowImpact(session, 'target', voyage, nextEta, nextEtd, candidate.berth, changes);
  // 任务改泊 + 换桥
  for (const task of voyageTasks(voyage.id)) {
    if (task.to.includes(voyage.berth) && /VOY-/.test(task.to)) {
      if (isStarted(task.status)) {
        changes.push(freezeChange(task, voyage.id, '任务已开始作业，船边目的地不能改泊'));
        continue;
      }
      const newTo = task.to.replace(voyage.berth, candidate.berth);
      const before: Record<string, unknown> = { to: task.to };
      const after: Record<string, unknown> = { to: newTo };
      let risk: ChangeRisk = 'none';
      if (task.equipmentId) {
        const holder = craneHolder(task.equipmentId);
        if (holder && holder !== voyage.id) {
          before.equipmentId = task.equipmentId;
          after.equipmentId = candidate.crane.id;
          risk = 'warning';
          impact.lockedCranes ??= [];
          impact.lockedCranes.push({ craneId: task.equipmentId, holderVoyageId: holder, resolution: `换泊后改派 ${candidate.crane.id}` });
        }
      }
      changes.push({
        id: newId('CHG'), type: 'task-equipment', entity: 'task', entityId: task.id, voyageId: voyage.id,
        before, after, risk, frozen: false,
        reason: reasonOf(0, `航次改靠 ${candidate.berth}，船边作业目的地${'equipmentId' in after ? '与岸桥指派' : ''}同步切换`),
        preconditions: [{ type: 'task-not-started', detail: '任务确认时必须仍处于 queued/assigned/blocked' }, { type: 'equipment-usable', detail: `${candidate.crane.id} 确认时必须可用` }],
      });
    }
  }
  addContainerNotes(session, voyage, 0, changes, `改靠 ${candidate.berth}，箱务船边交接点变更`);

  const metrics = computeMetrics([impact], changes);
  return {
    id: 'berth-switch', label: `改靠 ${candidate.berth}（空闲泊位）`, description: `靠泊 ${candidate.berth}、使用 ${candidate.crane.name}，不挤占后续航次窗口；堆场水平运输距离可能增加。`,
    feasible: true, recommended: false,
    score: clampScore(58 + (metrics.frozenTasks ? -8 : 6) - (metrics.warnings * 4) + 12),
    scoreBreakdown: [
      { label: '不级联后续航次', points: 20 }, { label: `改派 ${candidate.crane.id}`, points: 8 },
      { label: '水平运输距离增加', points: -8 }, { label: metrics.frozenTasks ? '存在不能改泊的在执行任务' : '在执行任务无牵连', points: metrics.frozenTasks ? -10 : 4 },
    ],
    targetVoyage: impact, cascadeVoyages: [], changes, metrics,
  };
}

/** 方案三：压缩在泊作业窗口（加班/加密岸桥） */
function buildCompress(session: ReplanSession, ctx: Context): ReplanOption {
  const { voyage, early } = ctx;
  const windowLen = minutesBetween(voyage.eta, voyage.etd);
  // 目标：新窗口起点用触发 ETA，但靠泊起点不能早于当前时间之前（在泊航次）
  const baseEta = ctx.berthed ? voyage.eta : session.triggerEta;
  const nextEta = baseEta;
  const cut = Math.max(60, Math.round(windowLen * 0.2));
  const naturalEtd = shiftIso(voyage.etd, early ? minutesBetween(voyage.eta, session.triggerEta) : 0);
  const nextEtd = shiftIso(naturalEtd, -cut);
  const changes: PlannedChange[] = [];
  const impact = windowImpact(session, 'target', voyage, nextEta, nextEtd, voyage.berth, changes);

  const usableCranes = quayCranes().filter(c => c.status !== 'offline' && c.status !== 'maintenance');
  const freeCranes = usableCranes.filter(c => { const h = craneHolder(c.id); return !h || h === voyage.id; });
  // 已开始的船边作业不可回滚：压缩窗口只能调度尚未开始的任务
  for (const task of voyageTasks(voyage.id)) {
    if (isStarted(task.status)) changes.push(freezeChange(task, voyage.id, '作业已开始，压缩窗口不能回滚或重派该任务'));
  }
  // 给未派桥的装卸任务加密派工
  let reassigned = 0;
  for (const task of voyageTasks(voyage.id)) {
    if (!['load', 'discharge'].includes(task.kind)) continue;
    if (!task.equipmentId && task.status !== 'done') {
      const crane = freeCranes[reassigned % Math.max(freeCranes.length, 1)];
      if (crane) {
        changes.push({
          id: newId('CHG'), type: 'task-equipment', entity: 'task', entityId: task.id, voyageId: voyage.id,
          before: { equipmentId: task.equipmentId ?? null }, after: { equipmentId: crane.id }, risk: 'none', frozen: false,
          reason: reasonOf(0, `压缩窗口加班作业，加密岸桥 ${crane.id} 派工`),
          preconditions: [{ type: 'task-not-started', detail: '已开始的任务不能改派' }, { type: 'equipment-usable', detail: `${crane.id} 确认时可用` }],
        });
        reassigned += 1;
      }
    }
  }
  const density = usableCranes.length ? Math.round(voyage.movesPlanned / Math.max(1, minutesBetween(nextEta, nextEtd) / 60) * 1.0) : 0;
  const feasible = nextEtd > nextEta && usableCranes.length >= 1 && (!ctx.berthed || cut > 0);
  if (reassigned === 0 && freeCranes.length === 0) {
    impact.lockedCranes ??= [];
    for (const c of usableCranes) { const h = craneHolder(c.id); if (h && h !== voyage.id) impact.lockedCranes.push({ craneId: c.id, holderVoyageId: h, resolution: '无空闲岸桥可加密，压缩不可行' }); }
  }
  const metrics = { ...computeMetrics([impact], changes), craneDensity: density };
  return {
    id: 'compress', label: '压缩在泊作业窗口', description: `窗口收窄 ${cut} 分钟，加班加桥按新节奏完成 ${voyage.movesPlanned - voyage.movesDone} 个剩余 move；不改动后续航次。`,
    feasible, infeasibleReason: feasible ? undefined : '没有可加密的岸桥或窗口已无法压缩', recommended: false,
    score: clampScore(feasible ? 66 - (density > 45 ? 14 : 0) + 6 : 20),
    scoreBreakdown: [{ label: '不影响后续航次', points: 18 }, { label: `窗口收窄 ${cut} 分钟`, points: 6 }, { label: `加密 ${reassigned} 项岸桥派工`, points: 4 }, { label: density > 45 ? '岸桥负载接近极限' : '岸桥负载可控', points: density > 45 ? -16 : 4 }],
    targetVoyage: impact, cascadeVoyages: [], changes, metrics,
  };
}

/** 方案四：锚地等待（仅提前抵港） */
function buildAnchorageHold(session: ReplanSession, ctx: Context): ReplanOption {
  const { voyage } = ctx;
  // 实际靠泊仍按原 ETA：窗口不动，仅记录提前到港
  const changes: PlannedChange[] = [];
  const impact: VoyageImpact = {
    voyageId: voyage.id, vessel: voyage.vessel, role: 'target',
    before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
    after: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth }, shiftMinutes: 0,
  };
  changes.push({
    id: newId('CHG'), type: 'voyage-window', entity: 'voyage', entityId: voyage.id, voyageId: voyage.id,
    before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth, reportedEta: voyage.reportedEta ?? null },
    after: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth, reportedEta: session.triggerEta },
    risk: 'warning', frozen: false,
    reason: { shiftMinutes: 0, direction: 'unchanged', text: `提前 ${Math.abs(ctx.deltaMinutes)} 分钟抵港，安排锚地等待，泊位与岸桥计划不变（产生锚地/燃油成本）` },
  });
  addContainerNotes(session, voyage, 0, changes, '提前抵港锚地等待，箱务计划不变');
  return {
    id: 'anchorage-hold', label: '锚地等待，维持原窗口', description: `船提前 ${Math.abs(ctx.deltaMinutes)} 分钟到港但不提前靠泊，锚地等待原窗口，避免打乱岸桥与闸口节奏。`,
    feasible: true, recommended: false, score: clampScore(64 + (ctx.deltaMinutes < -120 ? -10 : 0)),
    scoreBreakdown: [{ label: '泊位/任务/预约零改动', points: 16 }, { label: '锚地等待成本', points: -8 }, { label: ctx.deltaMinutes < -120 ? '等待过长，船方可能拒受' : '等待时长可接受', points: ctx.deltaMinutes < -120 ? -8 : 4 }],
    targetVoyage: impact, cascadeVoyages: [], changes, metrics: computeMetrics([impact], changes),
  };
}

/** 方案五（基线反例）：只改 ETA 字段 */
function buildEtaOnly(session: ReplanSession, ctx: Context): ReplanOption {
  const { voyage, deltaMinutes: delta } = ctx;
  const changes: PlannedChange[] = [];
  const impact: VoyageImpact = {
    voyageId: voyage.id, vessel: voyage.vessel, role: 'target',
    before: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
    after: { eta: session.triggerEta, etd: voyage.etd, berth: voyage.berth }, shiftMinutes: delta,
  };
  changes.push({
    id: newId('CHG'), type: 'voyage-window', entity: 'voyage', entityId: voyage.id, voyageId: voyage.id,
    before: { eta: voyage.eta }, after: { eta: session.triggerEta }, risk: 'critical', frozen: false,
    reason: reasonOf(delta, '仅修改航次 ETA 字段（基线对照）'),
  });
  // 风险说明：不变的对象
  const frozenTaskCount = voyageTasks(voyage.id).filter(t => !isFinished(t.status)).length;
  return {
    id: 'eta-only', label: '仅更新 ETA（不推荐）', description: '只改航次 ETA，泊位、岸桥、任务和预约全部不动——用于展示"只改字段"的后果。',
    feasible: true, recommended: false, score: 12,
    scoreBreakdown: [{ label: '泊位冲突不处理', points: -30 }, { label: '岸桥/任务不同步', points: -20 }, { label: '闸口预约不联动', points: -10 }],
    targetVoyage: impact, cascadeVoyages: [], changes,
    metrics: { ...computeMetrics([impact], changes), conflicts: frozenTaskCount, warnings: 2 },
  };
}

/* ---------- 变更构造辅助 ---------- */

function shiftTasksOfVoyage(session: ReplanSession, voyage: Voyage, shift: number, changes: PlannedChange[]) {
  for (const task of voyageTasks(voyage.id)) {
    if (isFinished(task.status)) continue;
    if (isStarted(task.status)) {
      changes.push(freezeChange(task, voyage.id, '作业已开始，不允许回滚重排，保持当前岸桥与节拍'));
      continue;
    }
    const after = shiftIso(task.scheduledAt, shift);
    const before: Record<string, unknown> = { scheduledAt: task.scheduledAt };
    const afterPatch: Record<string, unknown> = { scheduledAt: after };
    let risk: ChangeRisk = 'none';
    // 设备锁定：该任务指派的岸桥被其他航次持有
    if (task.equipmentId) {
      const holder = craneHolder(task.equipmentId);
      if (holder && holder !== voyage.id) {
        const alt = quayCranes().find(c => c.status === 'available' && craneHolder(c.id) === undefined);
        before.equipmentId = task.equipmentId;
        afterPatch.equipmentId = alt?.id ?? task.equipmentId;
        risk = alt ? 'warning' : 'critical';
        changes.push({
          id: newId('CHG'), type: 'task-equipment', entity: 'task', entityId: task.id, voyageId: voyage.id,
          before: { equipmentId: task.equipmentId }, after: { equipmentId: afterPatch.equipmentId },
          risk, frozen: false,
          reason: reasonOf(0, `原岸桥 ${task.equipmentId} 已锁定给 ${holder}，${alt ? `改派空闲岸桥 ${alt.id}` : '无可用替代岸桥，需值班长协调'}`),
          preconditions: alt ? [{ type: 'equipment-usable', detail: `${alt.id} 确认时必须仍可用` }] : undefined,
        });
      }
    }
    changes.push({
      id: newId('CHG'), type: 'task-shift', entity: 'task', entityId: task.id, voyageId: voyage.id,
      before, after: afterPatch, risk, frozen: false,
      reason: reasonOf(shift, shift > 0 ? `航次窗口推迟 ${shift} 分钟，未开始作业同步顺延` : `航次窗口提前 ${Math.abs(shift)} 分钟，作业相应提前`),
      preconditions: [{ type: 'task-not-started', detail: '任务确认时必须仍未开始（queued/assigned/blocked）' }],
    });
  }
}

function shiftAppointmentsOfVoyage(voyage: Voyage, shift: number, changes: PlannedChange[]) {
  if (shift === 0) return;
  for (const apt of voyageAppointments(voyage.id)) {
    if (apt.status === 'completed' || apt.status === 'cancelled') continue;
    changes.push({
      id: newId('CHG'), type: 'appointment-shift', entity: 'appointment', entityId: apt.id, voyageId: voyage.id,
      before: { windowStart: apt.windowStart, windowEnd: apt.windowEnd, status: apt.status },
      after: { windowStart: shiftIso(apt.windowStart, shift), windowEnd: shiftIso(apt.windowEnd, shift) },
      risk: apt.status === 'checked-in' ? 'critical' : apt.status === 'booked' ? 'warning' : 'none',
      frozen: apt.status === 'checked-in',
      frozenReason: apt.status === 'checked-in' ? '集卡已进场签到，预约时隙不能回改，需现场协调提还箱顺序' : undefined,
      reason: reasonOf(shift, shift > 0 ? `航次推迟 ${shift} 分钟，闸口时隙联动推迟` : `航次提前，闸口时隙联动提前`),
    });
  }
}

function addContainerNotes(session: ReplanSession, voyage: Voyage, shift: number, changes: PlannedChange[], overrideText?: string) {
  for (const container of voyageContainers(voyage.id)) {
    if (['released'].includes(container.status)) continue;
    const text = overrideText ?? (shift > 0 ? `泊位重排 ${session.id}：随 ${voyage.id} 推迟 ${shift} 分钟` : `泊位重排 ${session.id}：随 ${voyage.id} 提前 ${Math.abs(shift)} 分钟`);
    changes.push({
      id: newId('CHG'), type: 'container-note', entity: 'container', entityId: container.id, voyageId: voyage.id,
      before: { lastEvent: container.lastEvent }, after: { lastEvent: `${container.lastEvent}｜${text}` },
      risk: 'none', frozen: false, reason: reasonOf(shift, text),
    });
  }
}

function applyCraneLockAdvisories(session: ReplanSession, voyage: Voyage, changes: PlannedChange[], impact: VoyageImpact) {
  for (const crane of quayCranes()) {
    const holder = craneHolder(crane.id);
    if (holder && holder !== voyage.id && crane.location.includes(voyage.berth)) {
      impact.lockedCranes ??= [];
      if (!impact.lockedCranes.some(l => l.craneId === crane.id)) {
        impact.lockedCranes.push({ craneId: crane.id, holderVoyageId: holder, resolution: `桥机保留给 ${holder}，从邻泊调派空闲岸桥` });
      }
      changes.push({
        id: newId('CHG'), type: 'task-equipment', entity: 'equipment', entityId: crane.id, voyageId: voyage.id,
        before: { status: crane.status, location: crane.location }, after: { status: crane.status, location: crane.location },
        risk: 'warning', frozen: true, frozenReason: `${crane.id} 已锁定给航次 ${holder}，重排不能抢占`,
        reason: reasonOf(0, `岸桥 ${crane.id} 被 ${holder} 锁定，本方案不调动该桥`),
      });
    }
  }
}

function freezeChange(task: YardTask, voyageId: string, why: string): PlannedChange {
  return {
    id: newId('CHG'), type: 'freeze-task', entity: 'task', entityId: task.id, voyageId,
    before: { scheduledAt: task.scheduledAt, status: task.status, equipmentId: task.equipmentId ?? null },
    after: { scheduledAt: task.scheduledAt, status: task.status, equipmentId: task.equipmentId ?? null },
    risk: 'warning', frozen: true, frozenReason: why,
    reason: reasonOf(0, why),
  };
}

const KNOWN_BERTHS = ['B02', 'B04', 'B07', 'B10'];

function findFreeBerth(start: string, end: string) {
  for (const berth of KNOWN_BERTHS) {
    const occupied = activeVoyages().some(v => v.berth === berth && overlap(t(start), t(end), t(v.eta), t(v.etd)));
    if (occupied) continue;
    const crane = quayCranes().find(c => c.status === 'available' && (c.location.includes(berth) || !/B\d\d/.test(c.location)));
    if (crane) return { berth, crane };
  }
  return undefined;
}

function computeMetrics(impacts: VoyageImpact[], changes: PlannedChange[]): ReplanMetrics & { cascadeVoyageCount: number } {
  const active = changes.filter(c => !c.frozen);
  return {
    affectedVoyages: impacts.length,
    delayedVoyages: impacts.filter(i => i.shiftMinutes > 0).length,
    advancedVoyages: impacts.filter(i => i.shiftMinutes < 0).length,
    movedTasks: active.filter(c => c.type === 'task-shift').length,
    frozenTasks: changes.filter(c => c.frozen && c.entity === 'task').length,
    craneReassignments: active.filter(c => c.type === 'task-equipment' && c.before.equipmentId !== c.after.equipmentId).length,
    shiftedAppointments: active.filter(c => c.type === 'appointment-shift').length,
    containerNotes: active.filter(c => c.type === 'container-note').length,
    warnings: changes.filter(c => c.risk === 'warning').length,
    conflicts: changes.filter(c => c.risk === 'critical').length,
    cascadeVoyageCount: impacts.filter(i => i.role === 'cascade').length,
  };
}

/* ------------------------------------------------------------------ */
/* 确认：两阶段校验 + 快照事务（部分失败回滚）                          */
/* ------------------------------------------------------------------ */

export interface ConfirmInput {
  actor?: string;
  /** 演示/联调：指定变更 id 在写入阶段失败，验证逐项回滚 */
  injectFailChangeIds?: string[];
}

export function confirmReplan(sessionId: string, input: ConfirmInput = {}): ReplanSession {
  const session = mustGet(sessionId);
  assertOpen(session);
  const option = session.options.find(o => o.id === session.selectedOptionId);
  if (!option) throw new ReplanError('INVALID_STATE', '请先选择一套重排方案');

  // 阶段一：基于当前数据重新校验全部前置条件
  const validationErrors = validateAgainstLiveState(session, option);
  if (validationErrors.length) {
    session.status = 'stale';
    session.validationErrors = validationErrors;
    session.updatedAt = isoNow();
    throw new ReplanError('STALE', `重排依据已变化（${validationErrors.length} 项前置条件不满足），请基于最新状态重新生成方案`, validationErrors);
  }

  // 阶段二：逐项写入，保留每项写入前快照；任一项失败则逆序回滚
  const rollback: (() => void)[] = [];
  const results: ApplyItemResult[] = [];
  try {
    for (const change of option.changes) {
      if (change.frozen) {
        results.push({ changeId: change.id, type: change.type, entityId: change.entityId, applied: false, skippedFrozen: true, message: change.frozenReason });
        continue;
      }
      if (input.injectFailChangeIds?.includes(change.id)) {
        throw new Error(`模拟写入失败：${change.type} ${change.entityId}（设备控制总线超时）`);
      }
      applyChange(change, session, rollback, results);
    }
  } catch (error) {
    for (const undo of rollback.reverse()) { try { undo(); } catch { /* 回滚尽力而为 */ } }
    session.status = 'failed';
    session.failureReason = error instanceof Error ? error.message : '批量更新中途失败';
    session.applyResults = results;
    session.updatedAt = isoNow();
    recordAudit('REPLAN_FAILED', 'replan-session', session.id, `方案 ${option.id} 部分更新失败，已回滚 ${rollback.length} 项：${session.failureReason}`);
    throw new ReplanError('CONFIRM_FAILED', `部分更新失败，已全部回滚：${session.failureReason}`, { applied: results.length, rolledBack: rollback.length });
  }

  session.status = 'confirmed';
  session.confirmedAt = isoNow();
  session.applyResults = results;
  session.updatedAt = isoNow();
  bumpStateVersion();
  recordAudit('REPLAN_CONFIRM', 'replan-session', session.id,
    `确认方案 ${option.id}：更新 ${results.filter(r => r.applied).length} 项，冻结 ${results.filter(r => r.skippedFrozen).length} 项；原因：${session.reason}`);
  return session;
}

function validateAgainstLiveState(session: ReplanSession, option: ReplanOption) {
  const errors: NonNullable<ReplanSession['validationErrors']> = [];
  // 方案应用后的航次窗口（以 live 数据为底，叠加本方案窗口变更）
  const plannedWindows = new Map<string, { eta: string; etd: string; berth: string }>();
  for (const change of option.changes.filter(c => c.type === 'voyage-window' && !c.frozen)) {
    plannedWindows.set(change.entityId, {
      eta: String(change.after.eta ?? change.before.eta),
      etd: String(change.after.etd ?? change.before.etd),
      berth: String(change.after.berth ?? change.before.berth),
    });
  }
  for (const change of option.changes) {
    if (change.frozen) continue;
    for (const pre of change.preconditions ?? []) {
      if (pre.type === 'task-not-started') {
        const task = tasks.find(item => item.id === change.entityId);
        if (!task) { errors.push({ changeId: change.id, code: 'TASK_GONE', message: `任务 ${change.entityId} 已不存在` }); continue; }
        if (isStarted(task.status)) errors.push({ changeId: change.id, code: 'TASK_STARTED', message: `任务 ${change.entityId} 已进入 ${task.status}，已开始作业不可回滚` });
      }
      if (pre.type === 'berth-free') {
        const after = plannedWindows.get(change.entityId);
        if (!after) continue;
        // 同泊位其他航次：优先用方案后的窗口，没有则用 live 窗口
        for (const other of activeVoyages().filter(v => v.id !== change.entityId)) {
          const planned = plannedWindows.get(other.id);
          const oStart = planned ? t(planned.eta) : t(other.eta);
          const oEnd = planned ? t(planned.etd) : t(other.etd);
          const oBerth = planned?.berth ?? other.berth;
          if (oBerth === after.berth && overlap(t(after.eta), t(after.etd), oStart, oEnd)) {
            errors.push({ changeId: change.id, code: 'BERTH_TAKEN', message: `${after.berth} 在该时段仍被 ${other.id}（${other.vessel}）占用` });
          }
        }
      }
      if (pre.type === 'equipment-usable') {
        const wantedId = String(change.after.equipmentId ?? '');
        const machine = equipment.find(e => e.id === wantedId);
        if (!machine) errors.push({ changeId: change.id, code: 'EQUIPMENT_GONE', message: `设备 ${wantedId} 不存在` });
        else if (machine.status === 'offline' || machine.status === 'maintenance') errors.push({ changeId: change.id, code: 'EQUIPMENT_DOWN', message: `${machine.name} 当前 ${machine.status}` });
        else {
          const holder = craneHolder(machine.id);
          if (holder && holder !== change.voyageId) errors.push({ changeId: change.id, code: 'EQUIPMENT_LOCKED', message: `${machine.name} 已锁定给 ${holder}` });
        }
      }
    }
  }
  return errors;
}

function applyChange(change: PlannedChange, session: ReplanSession, rollback: (() => void)[], results: ApplyItemResult[]) {
  if (change.type === 'voyage-window') {
    const voyage = mustVoyage(change.entityId);
    const snapshot = { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth, reportedEta: voyage.reportedEta, windowHistory: voyage.windowHistory };
    rollback.push(() => { voyage.eta = snapshot.eta; voyage.etd = snapshot.etd; voyage.berth = snapshot.berth; voyage.reportedEta = snapshot.reportedEta; voyage.windowHistory = snapshot.windowHistory; });
    if ('eta' in change.after) voyage.eta = String(change.after.eta);
    if ('etd' in change.after) voyage.etd = String(change.after.etd);
    if ('berth' in change.after) voyage.berth = String(change.after.berth);
    if ('reportedEta' in change.after) voyage.reportedEta = change.after.reportedEta ? String(change.after.reportedEta) : undefined;
    voyage.windowHistory = [...(voyage.windowHistory ?? []), {
      at: isoNow(), sessionId: session.id,
      from: { eta: String(change.before.eta ?? snapshot.eta), etd: String(change.before.etd ?? snapshot.etd), berth: String(change.before.berth ?? snapshot.berth) },
      to: { eta: voyage.eta, etd: voyage.etd, berth: voyage.berth },
      reason: change.reason.text,
    }];
  } else if (change.type === 'task-shift') {
    const task = mustTask(change.entityId);
    const scheduledAt = task.scheduledAt;
    rollback.push(() => { task.scheduledAt = scheduledAt; task.rescheduleNote = undefined; });
    task.scheduledAt = String(change.after.scheduledAt);
    task.rescheduleNote = change.reason.text;
  } else if (change.type === 'task-equipment') {
    const task = tasks.find(item => item.id === change.entityId);
    if (task) {
      const prev = { equipmentId: task.equipmentId, to: task.to, rescheduleNote: task.rescheduleNote };
      rollback.push(() => { task.equipmentId = prev.equipmentId; task.to = prev.to; task.rescheduleNote = prev.rescheduleNote; });
      if ('equipmentId' in change.after) {
        const wanted = change.after.equipmentId;
        task.equipmentId = wanted ? String(wanted) : undefined;
        if (task.status === 'queued') task.status = 'assigned';
      }
      if ('to' in change.after) task.to = String(change.after.to);
      task.rescheduleNote = change.reason.text;
    } else {
      // 设备级占位变更（锁定提示）——只做审计，不改设备池
      const machine = equipment.find(e => e.id === change.entityId);
      const prev = machine ? { status: machine.status, location: machine.location } : undefined;
      rollback.push(() => { if (machine && prev) { machine.status = prev.status as typeof machine.status; machine.location = prev.location; } });
    }
  } else if (change.type === 'appointment-shift') {
    const apt = mustAppointment(change.entityId);
    const prev = { windowStart: apt.windowStart, windowEnd: apt.windowEnd, exception: apt.exception };
    rollback.push(() => { apt.windowStart = prev.windowStart; apt.windowEnd = prev.windowEnd; apt.exception = prev.exception; });
    apt.windowStart = String(change.after.windowStart);
    apt.windowEnd = String(change.after.windowEnd);
    apt.exception = change.reason.text;
  } else if (change.type === 'container-note') {
    const container = containers.find(c => c.id === change.entityId);
    if (!container) throw new Error(`箱 ${change.entityId} 不存在`);
    const prev = container.lastEvent;
    rollback.push(() => { container.lastEvent = prev; });
    container.lastEvent = String(change.after.lastEvent);
  } else if (change.type === 'freeze-task') {
    results.push({ changeId: change.id, type: change.type, entityId: change.entityId, applied: false, skippedFrozen: true, message: change.frozenReason });
    return;
  }
  results.push({ changeId: change.id, type: change.type, entityId: change.entityId, applied: true });
}

/* ------------------------------------------------------------------ */
/* 取消：按会话基线恢复                                                 */
/* ------------------------------------------------------------------ */

export function cancelReplan(sessionId: string, reason?: string): ReplanSession {
  const session = mustGet(sessionId);
  if (session.status === 'confirmed') throw new ReplanError('CONFLICT', '方案已确认生效，不能取消；如需撤销请发起反向重排');
  if (session.status === 'cancelled') return session;

  let restored = 0;
  if (session.status === 'failed') {
    // failed 已经在写入阶段回滚，这里仍按基线兜底恢复，避免回滚遗漏
    restored = restoreBaseline(session);
  } else {
    // draft/stale：方案从未生效，恢复建会话时短暂被改过的字段（如 reportedEta）
    restored = restoreBaseline(session);
  }
  session.status = 'cancelled';
  session.cancelledAt = isoNow();
  session.restoredChanges = restored;
  session.failureReason = reason ?? session.failureReason;
  session.updatedAt = isoNow();
  bumpStateVersion();
  recordAudit('REPLAN_CANCEL', 'replan-session', session.id, `取消重排并恢复 ${restored} 项关联对象：${reason ?? '调度员放弃本次重排'}`);
  return session;
}

function restoreBaseline(session: ReplanSession): number {
  const base = session.baseline;
  let count = 0;
  for (const [id, snap] of Object.entries(base.voyages)) {
    const current = voyages.find(v => v.id === id);
    if (current && (current.eta !== snap.eta || current.etd !== snap.etd || current.berth !== snap.berth || current.reportedEta !== snap.reportedEta)) {
      current.eta = snap.eta; current.etd = snap.etd; current.berth = snap.berth; current.reportedEta = snap.reportedEta; current.windowHistory = snap.windowHistory?.map(h => ({ ...h }));
      count += 1;
    }
  }
  for (const [id, snap] of Object.entries(base.tasks)) {
    const current = tasks.find(item => item.id === id);
    if (current && (current.scheduledAt !== snap.scheduledAt || current.equipmentId !== snap.equipmentId || current.to !== snap.to || current.rescheduleNote)) {
      current.scheduledAt = snap.scheduledAt; current.equipmentId = snap.equipmentId; current.to = snap.to;
      current.status = snap.status; current.rescheduleNote = undefined;
      count += 1;
    }
  }
  for (const [id, snap] of Object.entries(base.appointments)) {
    const current = appointments.find(a => a.id === id);
    if (current && (current.windowStart !== snap.windowStart || current.windowEnd !== snap.windowEnd)) {
      current.windowStart = snap.windowStart; current.windowEnd = snap.windowEnd; current.exception = snap.exception;
      count += 1;
    }
  }
  for (const [id, lastEvent] of Object.entries(base.containers)) {
    const current = containers.find(c => c.id === id);
    if (current && current.lastEvent !== lastEvent && current.lastEvent.includes(session.id)) {
      current.lastEvent = lastEvent; count += 1;
    }
  }
  return count;
}

/* ---------- 小工具 ---------- */

function mustGet(id: string): ReplanSession {
  const session = sessions.get(id);
  if (!session) throw new ReplanError('NOT_FOUND', `重排会话 ${id} 不存在`);
  return session;
}
function mustVoyage(id: string): Voyage {
  const voyage = voyages.find(v => v.id === id);
  if (!voyage) throw new ReplanError('NOT_FOUND', `航次 ${id} 不存在`);
  return voyage;
}
function mustTask(id: string): YardTask {
  const task = tasks.find(item => item.id === id);
  if (!task) throw new ReplanError('NOT_FOUND', `任务 ${id} 不存在`);
  return task;
}
function mustAppointment(id: string): GateAppointment {
  const apt = appointments.find(a => a.id === id);
  if (!apt) throw new ReplanError('NOT_FOUND', `预约 ${id} 不存在`);
  return apt;
}
function assertOpen(session: ReplanSession) {
  if (session.status === 'confirmed') throw new ReplanError('CONFLICT', '重排会话已确认，不允许重复操作');
  if (session.status === 'cancelled') throw new ReplanError('CONFLICT', '重排会话已取消');
}

// 避免未使用告警（cloneSnapshot 预留给后续持久化/导出）
void cloneSnapshot;
export type { Snapshot };
export { auditEvents };
