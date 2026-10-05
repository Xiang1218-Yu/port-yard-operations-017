import { appointments, auditEvents, containers, equipment, tasks, voyages } from './domain.js';
import type { Equipment, GateAppointment, Voyage, YardTask } from './domain.js';

// 泊位窗口重排模块
// 一次重排的生命周期：startReplan(draft) -> confirmReplan(confirmed/failed) / cancelReplan(cancelled)
// 重排进行中若外部再推送 ETA，会话变为 stale，需要用新基线重新开方案。

export type ReplanMode = 'shift-window' | 'compress-turnaround' | 'swap-berth';
export type ShiftDirection = 'earlier' | 'later' | 'unchanged';
export type ReplanTrigger = 'delay' | 'advance' | 'etd-adjust' | 'manual';
export type SessionStatus = 'draft' | 'confirmed' | 'failed' | 'stale' | 'cancelled';
export type ErrorCode =
  | 'SESSION_NOT_FOUND' | 'SESSION_STALE' | 'SESSION_INVALID' | 'OPTION_NOT_AVAILABLE'
  | 'VOYAGE_NOT_PLANNABLE' | 'INVALID_WINDOW' | 'PARTIAL_UPDATE_FAILED';

export class ReplanError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}

const MINUTE = 60000;
const at = (iso: string) => new Date(iso).getTime();
const shiftIso = (iso: string, minutes: number) => new Date(at(iso) + minutes * MINUTE).toISOString();
const overlap = (aStart: string, aEnd: string, bStart: string, bEnd: string) =>
  at(aStart) < at(bEnd) && at(bStart) < at(aEnd);
const clampScore = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dirOf = (delta: number): ShiftDirection => (delta < 0 ? 'earlier' : delta > 0 ? 'later' : 'unchanged');
const dirLabel = (delta: number) => (delta < 0 ? `提前 ${-delta} 分钟` : delta > 0 ? `推迟 ${delta} 分钟` : '不变');

export const BERTHS = ['B01', 'B04', 'B07', 'B10'];
const MIN_COMPRESS_RATIO = 0.5;
const WARN_COMPRESS_RATIO = 0.8;
const SESSION_TTL_MS = 30 * 60 * MINUTE;

let sessionSeq = 0;

// ---------- 对外类型 ----------

export interface TimeChange { from: string; to: string; deltaMinutes: number; direction: ShiftDirection }
export interface BerthChange { from: string; to: string; changed: boolean }
export interface VoyageChange {
  voyageId: string; vessel: string; mode: ReplanMode; berth: BerthChange;
  eta: TimeChange; etd: TimeChange; lateRisk: { from: Voyage['lateRisk']; to: Voyage['lateRisk'] };
  etaVersionBefore: number; etaVersionAfter: number; reason: string;
}
export type TaskDecision = 'shift' | 'hold' | 'unassign' | 'keep';
export interface TaskImpact {
  taskId: string; kind: YardTask['kind']; containerId: string; description: string;
  status: YardTask['status']; scheduledFrom: string; scheduledTo: string;
  deltaMinutes: number; decision: TaskDecision; equipmentId?: string; equipmentName?: string;
  reasons: string[];
}
export type AppointmentDecision = 'shift' | 'hold' | 'keep';
export interface AppointmentImpact {
  appointmentId: string; containerId: string; truckNo: string; status: GateAppointment['status'];
  windowFrom: { start: string; end: string }; windowTo: { start: string; end: string };
  deltaMinutes: number; decision: AppointmentDecision; reasons: string[];
}
export interface EquipmentLock {
  equipmentId: string; equipmentName: string; kind: Equipment['kind'];
  ownerVoyageId: string; ownerVessel: string; ownerTaskId: string;
  windowStart: string; windowEnd: string; reason: string;
}
export interface ContainerImpact { containerId: string; voyageId: string; status: string; priority: string; yardSlot: string; note: string }
export interface ScorePart { label: string; points: number }

export interface ReplanOption {
  id: string; mode: ReplanMode; targetBerth: string; label: string; summary: string;
  feasibility: 'feasible' | 'warning' | 'blocked'; blockers: string[]; warnings: string[];
  voyageChange: VoyageChange;
  taskImpacts: TaskImpact[]; appointmentImpacts: AppointmentImpact[];
  equipmentLocks: EquipmentLock[];
  craneCapacity: { requiredMovesPerHour: number; availableMovesPerHour: number; quayCranes: string[] };
  score: number; scoreBreakdown: ScorePart[];
}

export interface ReplanInput {
  voyageId: string;
  targetEta?: string;
  targetEtd?: string;
  reason?: string;
  actor?: string;
}

interface Snapshot {
  voyages: Voyage[];
  tasks: YardTask[];
  appointments: GateAppointment[];
  containers: { id: string; lastEvent: string }[];
}

export interface AppliedChanges {
  voyage: Voyage;
  tasks: { taskId: string; scheduledAt: string; status: YardTask['status']; equipmentId?: string; shiftReason?: string }[];
  appointments: { appointmentId: string; windowStart: string; windowEnd: string; shiftReason?: string }[];
  containers: { containerId: string; lastEvent: string }[];
  summary: { shiftedTasks: number; heldTasks: number; unassignedTasks: number; shiftedAppointments: number };
}

export interface ReplanSession {
  id: string;
  status: SessionStatus;
  voyageId: string;
  trigger: ReplanTrigger;
  reason: string;
  actor: string;
  baseEtaVersion: number;
  currentEtaVersion: number;
  preferredOptionId: string;
  options: ReplanOption[];
  equipmentLocks: EquipmentLock[];
  unfinishedContainers: ContainerImpact[];
  createdAt: string;
  expiresAt: string;
  note?: string;
  confirmedOptionId?: string;
  appliedAt?: string;
  appliedChanges?: AppliedChanges;
  failure?: { atStep: string; message: string };
  recoverySnapshot?: Snapshot;
}

// 测试用故障注入：模拟批量更新到某一步骤时部分失败
let faultAtStep: string | null = null;
export function __setFaultStep(step: string | null) { faultAtStep = step; }

// ---------- 快照与恢复 ----------

function takeSnapshot(): Snapshot {
  return {
    voyages: voyages.map(v => ({ ...v })),
    tasks: tasks.map(t => ({ ...t, blockingReasons: [...t.blockingReasons] })),
    appointments: appointments.map(a => ({ ...a })),
    containers: containers.map(c => ({ id: c.id, lastEvent: c.lastEvent })),
  };
}
function restoreSnapshot(snapshot: Snapshot) {
  voyages.splice(0, voyages.length, ...snapshot.voyages.map(v => ({ ...v })));
  tasks.splice(0, tasks.length, ...snapshot.tasks.map(t => ({ ...t, blockingReasons: [...t.blockingReasons] })));
  appointments.splice(0, appointments.length, ...snapshot.appointments.map(a => ({ ...a })));
  for (const entry of snapshot.containers) {
    const live = containers.find(c => c.id === entry.id);
    if (live) live.lastEvent = entry.lastEvent;
  }
}

function recordAudit(action: string, entityId: string, details: string, actor = '中控调度员', entity = 'replan') {
  auditEvents.unshift({ id: `AUD-${Date.now()}-${sessionSeq++}`, actor, action, entity, entityId, at: new Date().toISOString(), details });
}

// ---------- 设备锁定 ----------

function taskWindow(task: YardTask) {
  return { start: task.scheduledAt, end: shiftIso(task.scheduledAt, task.estimatedMinutes) };
}

function vesselOfContainer(containerId: string) {
  const container = containers.find(c => c.id === containerId);
  return container ? voyages.find(v => v.id === container.voyageId) : undefined;
}

/** 查找设备在指定时间窗内被其他航次锁定的情况（assigned/executing 的任务视为占用）。 */
export function findEquipmentLock(equipmentId: string, ownerVoyageId: string, start: string, end: number | string): EquipmentLock | undefined {
  const endIso = typeof end === 'number' ? shiftIso(start, end) : end;
  const machine = equipment.find(item => item.id === equipmentId);
  if (!machine) return undefined;
  for (const other of tasks) {
    if (other.equipmentId !== equipmentId || other.status === 'queued' || other.status === 'done' || other.status === 'blocked') continue;
    const ownerVoyage = vesselOfContainer(other.containerId);
    if (!ownerVoyage || ownerVoyage.id === ownerVoyageId) continue;
    const win = taskWindow(other);
    if (!overlap(start, endIso, win.start, win.end)) continue;
    return {
      equipmentId, equipmentName: machine.name, kind: machine.kind,
      ownerVoyageId: ownerVoyage.id, ownerVessel: ownerVoyage.vessel, ownerTaskId: other.id,
      windowStart: win.start, windowEnd: win.end,
      reason: `${machine.name} 在 ${fmtTime(win.start)}–${fmtTime(win.end)} 已被 ${ownerVoyage.vessel}（${ownerVoyage.id} / ${other.id}）占用`,
    };
  }
  return undefined;
}

function locksForVoyage(voyageId: string): EquipmentLock[] {
  const result: EquipmentLock[] = [];
  for (const task of voyageTasks(voyageId)) {
    if (!task.equipmentId || task.status === 'done' || task.status === 'queued' || task.status === 'blocked') continue;
    const win = taskWindow(task);
    const lock = findEquipmentLock(task.equipmentId, voyageId, win.start, win.end);
    if (lock && !result.some(item => item.equipmentId === lock.equipmentId && item.ownerTaskId === lock.ownerTaskId)) result.push(lock);
  }
  return result;
}

function voyageTasks(voyageId: string): YardTask[] {
  const ids = new Set(containers.filter(c => c.voyageId === voyageId).map(c => c.id));
  return tasks.filter(t => ids.has(t.containerId) && t.status !== 'done');
}

// ---------- 方案构建 ----------

function riskAfter(deltaMinutes: number, current: Voyage['lateRisk']): Voyage['lateRisk'] {
  if (deltaMinutes >= 60) return 'high';
  if (deltaMinutes >= 15) return 'medium';
  if (deltaMinutes < 0) return 'low';
  return current;
}

function buildTaskImpacts(voyage: Voyage, etaDelta: number, targetBerth: string, hardOnLock: boolean) {
  const impacts: TaskImpact[] = [];
  const locks: EquipmentLock[] = [];
  for (const task of voyageTasks(voyage.id)) {
    const reasons: string[] = [];
    const scheduledTo = etaDelta ? shiftIso(task.scheduledAt, etaDelta) : task.scheduledAt;
    let decision: TaskDecision = etaDelta ? 'shift' : 'keep';
    let equipmentId = task.equipmentId;
    let equipmentName: string | undefined;

    if (task.status === 'executing') {
      decision = 'hold';
      reasons.push(`作业已于 ${fmtTime(task.scheduledAt)} 开始（executing），已开始作业不可回滚，保持原计划时刻`);
    } else if (task.equipmentId) {
      const machine = equipment.find(item => item.id === task.equipmentId);
      equipmentName = machine?.name;
      const lock = findEquipmentLock(task.equipmentId, voyage.id, scheduledTo, task.estimatedMinutes);
      if (lock) {
        locks.push(lock);
        reasons.push(lock.reason);
        if (hardOnLock && machine?.kind === 'quay-crane') {
          reasons.push(`岸桥随泊位绑定，换到 ${targetBerth} 仍无法使用该设备`);
        } else {
          decision = 'unassign';
          equipmentId = undefined;
          reasons.push('新时段设备被其他航次锁定，方案将解除指派并把任务退回队列，待重新分配设备');
        }
      }
    }
    impacts.push({
      taskId: task.id, kind: task.kind, containerId: task.containerId,
      description: `${task.kind} · ${task.from} → ${task.to}`,
      status: task.status, scheduledFrom: task.scheduledAt, scheduledTo,
      deltaMinutes: decision === 'hold' ? 0 : etaDelta, decision,
      equipmentId, equipmentName, reasons,
    });
  }
  return { impacts, locks };
}

function buildAppointmentImpacts(voyageId: string, etaDelta: number) {
  const ids = new Set(containers.filter(c => c.voyageId === voyageId).map(c => c.id));
  const result: AppointmentImpact[] = [];
  for (const appointment of appointments) {
    if (!ids.has(appointment.containerId)) continue;
    if (appointment.status === 'cancelled' || appointment.status === 'completed') continue;
    const reasons: string[] = [];
    let decision: AppointmentDecision = etaDelta ? 'shift' : 'keep';
    if (appointment.status === 'checked-in' || appointment.status === 'exception') {
      decision = etaDelta ? 'hold' : 'keep';
      reasons.push(appointment.status === 'checked-in'
        ? '车辆已签到进场，闸口窗口不能随航次回退，需现场另行协调'
        : '预约存在异常未闭环，不随窗口自动平移');
    }
    result.push({
      appointmentId: appointment.id, containerId: appointment.containerId, truckNo: appointment.truckNo,
      status: appointment.status,
      windowFrom: { start: appointment.windowStart, end: appointment.windowEnd },
      windowTo: decision === 'shift'
        ? { start: shiftIso(appointment.windowStart, etaDelta), end: shiftIso(appointment.windowEnd, etaDelta) }
        : { start: appointment.windowStart, end: appointment.windowEnd },
      deltaMinutes: decision === 'shift' ? etaDelta : 0, decision, reasons,
    });
  }
  return result;
}

function craneCapacity(voyage: Voyage, etaTo: string, etdTo: string, berth: string) {
  const quayCranes = equipment.filter(item => item.kind === 'quay-crane' && item.status !== 'offline' && item.status !== 'maintenance');
  const availableMovesPerHour = quayCranes.reduce((sum, crane) => {
    const lockedElsewhere = (berth === voyage.berth)
      ? tasks.some(t => t.equipmentId === crane.id && (t.status === 'assigned' || t.status === 'executing') && vesselOfContainer(t.containerId)?.id !== voyage.id)
      : !crane.location.includes(berth);
    return sum + (lockedElsewhere ? 0 : crane.movesPerHour * 0.9);
  }, 0);
  const dwellHours = Math.max(0.5, (at(etdTo) - at(etaTo)) / 3600000);
  const requiredMovesPerHour = Math.max(0, voyage.movesPlanned - voyage.movesDone) / dwellHours;
  return { requiredMovesPerHour: Math.round(requiredMovesPerHour * 10) / 10, availableMovesPerHour: Math.round(availableMovesPerHour * 10) / 10, quayCranes: quayCranes.map(c => c.id) };
}

function scoreOption(params: {
  voyageChange: VoyageChange; blockers: string[]; warnings: string[];
  taskImpacts: TaskImpact[]; appointmentImpacts: AppointmentImpact[];
  crane: { requiredMovesPerHour: number; availableMovesPerHour: number };
  compressRatio?: number; mode: ReplanMode;
}): { score: number; breakdown: ScorePart[] } {
  const breakdown: ScorePart[] = [];
  const deduct = (label: string, points: number) => { if (points > 0) breakdown.push({ label, points }); };
  const { voyageChange, blockers, warnings, taskImpacts, appointmentImpacts, crane, compressRatio, mode } = params;

  deduct(`航期${voyageChange.eta.direction === 'earlier' ? '提前' : voyageChange.eta.direction === 'later' ? '推迟' : '调整'}扰动`, Math.min(20, Math.abs(voyageChange.eta.deltaMinutes) / 30 * 2));
  const held = taskImpacts.filter(t => t.decision === 'hold').length;
  deduct('已开始作业保持原位（不可回滚）', held * 6);
  const unassigned = taskImpacts.filter(t => t.decision === 'unassign').length;
  deduct('设备被其他航次锁定需重新指派', unassigned * 8);
  const heldAppointments = appointmentImpacts.filter(a => a.decision === 'hold').length;
  const shiftedAppointments = appointmentImpacts.filter(a => a.decision === 'shift').length;
  deduct('已签到预约需现场协调', heldAppointments * 3);
  deduct('闸口预约窗口批量平移', Math.min(10, shiftedAppointments));
  if (crane.requiredMovesPerHour > crane.availableMovesPerHour) {
    const over = crane.requiredMovesPerHour - crane.availableMovesPerHour;
    deduct(`岸桥能力缺口 ${over.toFixed(1)} moves/h`, over > crane.availableMovesPerHour * 0.25 ? 30 : 18);
  }
  if (mode === 'swap-berth') deduct('更换泊位产生移泊与岸线协调成本', 6);
  if (mode === 'compress-turnaround') {
    deduct('压缩靠泊时长、作业密度上升', 10);
    if (compressRatio !== undefined && compressRatio < WARN_COMPRESS_RATIO) deduct('靠泊时长压缩超过 20%', 12);
  }
  if (warnings.length) deduct(`${warnings.length} 项作业预警`, Math.min(8, warnings.length * 3));
  if (blockers.length) deduct(`${blockers.length} 项硬性冲突`, blockers.length * 20);

  const score = clampScore(100 - breakdown.reduce((sum, part) => sum + part.points, 0));
  return { score: blockers.length ? Math.min(score, 20) : score, breakdown };
}

function buildOption(voyage: Voyage, mode: ReplanMode, targetBerth: string, etaTo: string, etdTo: string,
  sessionReason: string, baseVersion: number): ReplanOption {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const etaDelta = Math.round((at(etaTo) - at(voyage.eta)) / MINUTE);
  const etdDelta = Math.round((at(etdTo) - at(voyage.etd)) / MINUTE);
  const hardOnLock = mode === 'swap-berth';

  // 1) 泊位窗口冲突：同一泊位与其他在港航次窗口重叠
  if (mode === 'swap-berth') {
    for (const other of voyages) {
      if (other.id === voyage.id || other.status === 'departed' || other.berth !== targetBerth) continue;
      if (overlap(etaTo, etdTo, other.eta, other.etd)) {
        blockers.push(`与 ${other.vessel}（${other.id}）在 ${targetBerth} 的窗口 ${fmtTime(other.eta)}–${fmtTime(other.etd)} 冲突，两个航次窗口无法重叠靠泊`);
      }
    }
  }

  // 2) 已靠泊且已开工的航次，ETA 不允许向前回滚
  if (etaDelta < 0 && voyage.movesDone > 0) {
    blockers.push(`该航次已靠泊并完成 ${voyage.movesDone} moves，已开始作业不可回滚，ETA 不能提前到 ${fmtTime(etaTo)}`);
  }
  if (etaTo < new Date().toISOString() && voyage.status === 'approaching') {
    warnings.push('新 ETA 已早于当前时间，需立即联系港调确认是否直接安排靠泊');
  }

  // 3) 任务影响与设备锁定
  const { impacts, locks } = buildTaskImpacts(voyage, etaDelta, targetBerth, hardOnLock);
  for (const lock of locks) {
    if (hardOnLock && equipment.find(item => item.id === lock.equipmentId)?.kind === 'quay-crane') blockers.push(lock.reason);
  }
  const appointmentImpacts = buildAppointmentImpacts(voyage.id, etaDelta);
  if (appointmentImpacts.some(a => a.decision === 'hold')) warnings.push('存在已签到的闸口预约，无法随窗口平移');

  // 4) 压缩周转校验
  let compressRatio: number | undefined;
  if (mode === 'compress-turnaround') {
    compressRatio = (at(etdTo) - at(etaTo)) / (at(voyage.etd) - at(voyage.eta));
    if (compressRatio < MIN_COMPRESS_RATIO) blockers.push(`靠泊时长被压缩到原计划的 ${Math.round(compressRatio * 100)}%，低于安全下限 ${MIN_COMPRESS_RATIO * 100}%`);
    else if (compressRatio < WARN_COMPRESS_RATIO) warnings.push(`靠泊时长压缩到原计划的 ${Math.round(compressRatio * 100)}%，岸桥与人力密度需加强`);
  }

  // 5) 岸桥能力
  const crane = craneCapacity(voyage, etaTo, etdTo, targetBerth);
  if (crane.requiredMovesPerHour > crane.availableMovesPerHour) {
    const msg = `岸桥能力不足：需要 ${crane.requiredMovesPerHour} moves/h，当前泊位可用约 ${crane.availableMovesPerHour} moves/h`;
    if (mode === 'compress-turnaround' && crane.requiredMovesPerHour > crane.availableMovesPerHour * 1.25) blockers.push(msg);
    else warnings.push(msg);
  }

  const directionPhrase = etaDelta === 0
    ? `ETD${dirLabel(etdDelta)}`
    : `靠泊窗口${dirLabel(etaDelta)}${etdDelta ? `，离泊${dirLabel(etdDelta)}` : ''}`;
  const reason = sessionReason ? `${directionPhrase}：${sessionReason}` : `船期更新，${directionPhrase}`;
  const voyageChange: VoyageChange = {
    voyageId: voyage.id, vessel: voyage.vessel, mode,
    berth: { from: voyage.berth, to: targetBerth, changed: voyage.berth !== targetBerth },
    eta: { from: voyage.eta, to: etaTo, deltaMinutes: etaDelta, direction: dirOf(etaDelta) },
    etd: { from: voyage.etd, to: etdTo, deltaMinutes: etdDelta, direction: dirOf(etdDelta) },
    lateRisk: { from: voyage.lateRisk, to: riskAfter(etaDelta, voyage.lateRisk) },
    etaVersionBefore: baseVersion, etaVersionAfter: baseVersion + 1, reason,
  };

  const { score, breakdown } = scoreOption({ voyageChange, blockers, warnings, taskImpacts: impacts, appointmentImpacts, crane, compressRatio, mode });
  const shifted = impacts.filter(t => t.decision === 'shift').length;
  const held = impacts.filter(t => t.decision === 'hold').length;
  const unassigned = impacts.filter(t => t.decision === 'unassign').length;
  const label = mode === 'shift-window' ? '平移窗口' : mode === 'compress-turnaround' ? '压缩周转' : `更换泊位 → ${targetBerth}`;
  const summary = `ETA ${dirLabel(etaDelta)}，ETD ${dirLabel(etdDelta)}；平移 ${shifted} 个任务、${held} 个已开工任务不动、${unassigned} 个任务需重新指派设备`;

  return {
    id: `${mode}${mode === 'swap-berth' ? `-${targetBerth}` : ''}`,
    mode, targetBerth, label, summary,
    feasibility: blockers.length ? 'blocked' : warnings.length || unassigned ? 'warning' : 'feasible',
    blockers, warnings, voyageChange, taskImpacts: impacts, appointmentImpacts,
    equipmentLocks: locks, craneCapacity: crane, score, scoreBreakdown: breakdown,
  };
}

// ---------- 会话 ----------

const sessions = new Map<string, ReplanSession>();

export function listSessions(voyageId?: string) {
  const list = [...sessions.values()].filter(s => !voyageId || s.voyageId === voyageId);
  return list.sort((a, b) => at(b.createdAt) - at(a.createdAt));
}
export function getSession(id: string) {
  const session = sessions.get(id);
  if (!session) throw new ReplanError('SESSION_NOT_FOUND', `重排会话 ${id} 不存在`);
  return session;
}

export function startReplan(input: ReplanInput): ReplanSession {
  const voyage = voyages.find(v => v.id === input.voyageId);
  if (!voyage || voyage.status === 'departed') throw new ReplanError('VOYAGE_NOT_PLANNABLE', '航次不存在或已离港，不能重排泊位窗口');

  const targetEta = input.targetEta ?? voyage.eta;
  if (isNaN(at(targetEta))) throw new ReplanError('INVALID_WINDOW', '目标 ETA 时间格式无效');
  const etaDelta = Math.round((at(targetEta) - at(voyage.eta)) / MINUTE);
  // 未指定目标 ETD 时，保持现有靠泊时长，窗口整体平移；避免相对旧 ETD 平移造成 ETD 早于新 ETA
  const targetEtd = input.targetEtd ?? new Date(at(targetEta) + (at(voyage.etd) - at(voyage.eta))).toISOString();
  if (isNaN(at(targetEtd)) || at(targetEtd) <= at(targetEta)) throw new ReplanError('INVALID_WINDOW', '目标 ETD 必须晚于目标 ETA');

  const options: ReplanOption[] = [];
  options.push(buildOption(voyage, 'shift-window', voyage.berth, targetEta, targetEtd, input.reason ?? '', voyage.etaVersion));
  // 压缩周转：仅在给定明确 ETD 时按该 ETD，否则压缩 15%
  const compressedEtd = input.targetEtd ?? new Date(at(targetEta) + (at(voyage.etd) - at(voyage.eta)) * 0.85).toISOString();
  if (compressedEtd !== targetEtd) {
    options.push(buildOption(voyage, 'compress-turnaround', voyage.berth, targetEta, compressedEtd, input.reason ?? '', voyage.etaVersion));
  }
  for (const berth of BERTHS.filter(b => b !== voyage.berth)) {
    options.push(buildOption(voyage, 'swap-berth', berth, targetEta, targetEtd, input.reason ?? '', voyage.etaVersion));
  }

  const trigger: ReplanTrigger = etaDelta <= -15 ? 'advance' : etaDelta >= 15 ? 'delay' : (input.targetEtd ? 'etd-adjust' : 'manual');
  const feasible = options.filter(o => o.feasibility !== 'blocked').sort((a, b) => b.score - a.score);
  const reason = input.reason || (etaDelta === 0 ? '调度员手动发起窗口重排' : `船方报 ETA${dirLabel(etaDelta)}，触发窗口联动重排`);

  const now = Date.now();
  const session: ReplanSession = {
    id: `RP-${now.toString(36)}-${++sessionSeq}`,
    status: 'draft',
    voyageId: voyage.id,
    trigger, reason, actor: input.actor ?? '中控调度员',
    baseEtaVersion: voyage.etaVersion, currentEtaVersion: voyage.etaVersion,
    preferredOptionId: (feasible[0] ?? options[0]).id,
    options: options.sort((a, b) => b.score - a.score),
    equipmentLocks: locksForVoyage(voyage.id),
    unfinishedContainers: containers
      .filter(c => c.voyageId === voyage.id && c.status !== 'released')
      .map(c => ({ containerId: c.id, voyageId: c.voyageId, status: c.status, priority: c.priority, yardSlot: c.yardSlot, note: c.lastEvent })),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  sessions.set(session.id, session);
  recordAudit('REPLAN_START', session.id, `航次 ${voyage.id}（${voyage.vessel}）发起泊位窗口重排：${reason}，生成 ${options.length} 套可比方案`, session.actor);
  return session;
}

function assertUsable(session: ReplanSession) {
  if (session.status === 'confirmed') throw new ReplanError('SESSION_INVALID', '该方案已确认并应用，不能重复提交');
  if (session.status === 'cancelled') throw new ReplanError('SESSION_INVALID', '该重排已取消，原始窗口保持不变（或已恢复）');
  if (session.status === 'failed') throw new ReplanError('SESSION_INVALID', '该重排批量更新失败，可先恢复回滚后再重新发起');
  if (session.expiresAt < new Date().toISOString()) throw new ReplanError('SESSION_STALE', '重排会话已过期，请基于最新船期重新生成方案');
  const voyage = voyages.find(v => v.id === session.voyageId);
  if (!voyage) throw new ReplanError('VOYAGE_NOT_PLANNABLE', '关联航次已不存在');
  if (voyage.etaVersion !== session.baseEtaVersion) {
    session.status = 'stale';
    session.currentEtaVersion = voyage.etaVersion;
    session.note = `重排进行中航次 ETA 已更新（版本 ${session.baseEtaVersion} → ${voyage.etaVersion}），请基于新方案重新确认`;
    throw new ReplanError('SESSION_STALE', session.note);
  }
}

// ---------- 确认：事务式批量更新 ----------

export function confirmReplan(sessionId: string, optionId: string, actor = '中控调度员'): { session: ReplanSession; changes: AppliedChanges } {
  const session = getSession(sessionId);
  assertUsable(session);
  const option = session.options.find(o => o.id === optionId);
  if (!option) throw new ReplanError('OPTION_NOT_AVAILABLE', `方案 ${optionId} 不属于该重排会话`);
  if (option.feasibility === 'blocked') {
    throw new ReplanError('OPTION_NOT_AVAILABLE', `方案仍存在 ${option.blockers.length} 项硬性冲突，不能执行：${option.blockers[0]}`);
  }

  const snapshot = takeSnapshot();
  const change = option.voyageChange;
  const shiftedContainers = new Set<string>();
  const appliedTasks: AppliedChanges['tasks'] = [];
  const appliedAppointments: AppliedChanges['appointments'] = [];

  try {
    // 步骤 1：航次窗口
    if (faultAtStep === 'voyage') throw new Error('TOS 航次服务写入超时');
    const voyage = voyages.find(v => v.id === session.voyageId)!;
    voyage.eta = change.eta.to;
    voyage.etd = change.etd.to;
    voyage.berth = change.berth.to;
    voyage.lateRisk = change.lateRisk.to;
    voyage.etaVersion += 1;
    voyage.shiftReason = change.reason;
    session.currentEtaVersion = voyage.etaVersion;

    // 步骤 2：任务计划
    for (const impact of option.taskImpacts) {
      const task = tasks.find(t => t.id === impact.taskId);
      if (!task) continue;
      if (impact.decision === 'hold' || impact.decision === 'keep') continue;
      if (faultAtStep === 'tasks') throw new Error(`任务 ${task.id} 写入设备排程时连接中断`);
      task.scheduledAt = impact.scheduledTo;
      task.shiftReason = `${change.eta.direction === 'unchanged' ? 'ETD 调整' : impact.deltaMinutes < 0 ? '随航次提前' : '随航次推迟'} ${Math.abs(impact.deltaMinutes)} 分钟：${change.reason}`;
      if (impact.decision === 'unassign') {
        task.equipmentId = undefined;
        task.status = 'queued';
        task.blockingReasons = [...task.blockingReasons, ...impact.reasons];
      }
      shiftedContainers.add(task.containerId);
      appliedTasks.push({ taskId: task.id, scheduledAt: task.scheduledAt, status: task.status, equipmentId: task.equipmentId, shiftReason: task.shiftReason });
    }

    // 步骤 3：闸口预约窗口
    for (const impact of option.appointmentImpacts) {
      if (impact.decision !== 'shift') continue;
      const appointment = appointments.find(a => a.id === impact.appointmentId);
      if (!appointment) continue;
      if (faultAtStep === 'appointments') throw new Error(`预约 ${appointment.id} 时隙更新失败`);
      appointment.windowStart = impact.windowTo.start;
      appointment.windowEnd = impact.windowTo.end;
      appointment.shiftReason = `随 ${session.voyageId} 窗口${impact.deltaMinutes < 0 ? '提前' : '推迟'} ${Math.abs(impact.deltaMinutes)} 分钟：${change.reason}`;
      appliedAppointments.push({ appointmentId: appointment.id, windowStart: appointment.windowStart, windowEnd: appointment.windowEnd, shiftReason: appointment.shiftReason });
    }

    // 步骤 4：未完成箱务留痕
    for (const containerId of shiftedContainers) {
      const container = containers.find(c => c.id === containerId);
      if (!container) continue;
      if (faultAtStep === 'containers') throw new Error(`箱务 ${containerId} 事件流写入失败`);
      container.lastEvent = `窗口重排随航次${change.eta.direction === 'earlier' ? '提前' : change.eta.direction === 'later' ? '推迟' : '调整'}：${change.reason}（${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}）`;
    }
  } catch (error) {
    // 部分更新失败：回滚本方案已经写入的全部对象，会话留痕可恢复
    restoreSnapshot(snapshot);
    session.status = 'failed';
    session.failure = { atStep: faultAtStep ?? 'unknown', message: error instanceof Error ? error.message : '批量更新失败' };
    session.recoverySnapshot = snapshot;
    recordAudit('REPLAN_PARTIAL_FAIL', session.id, `方案 ${option.id} 批量更新在 ${session.failure.atStep} 步骤失败：${session.failure.message}；航次/任务/预约/箱务已全部回滚`, actor);
    throw new ReplanError('PARTIAL_UPDATE_FAILED', `批量更新部分失败（步骤：${session.failure.atStep}），已回滚全部改动：${session.failure.message}`);
  }

  const voyageAfter = voyages.find(v => v.id === session.voyageId)!;
  const changes: AppliedChanges = {
    voyage: { ...voyageAfter },
    tasks: appliedTasks,
    appointments: appliedAppointments,
    containers: [...shiftedContainers].map(id => {
      const container = containers.find(c => c.id === id)!;
      return { containerId: id, lastEvent: container.lastEvent };
    }),
    summary: {
      shiftedTasks: appliedTasks.length,
      heldTasks: option.taskImpacts.filter(t => t.decision === 'hold').length,
      unassignedTasks: option.taskImpacts.filter(t => t.decision === 'unassign').length,
      shiftedAppointments: appliedAppointments.length,
    },
  };
  session.status = 'confirmed';
  session.confirmedOptionId = option.id;
  session.appliedAt = new Date().toISOString();
  session.appliedChanges = changes;
  session.recoverySnapshot = undefined;
  recordAudit('REPLAN_APPLIED', session.id, `确认方案 ${option.label}：${option.summary}；任务平移 ${changes.summary.shiftedTasks}、保持 ${changes.summary.heldTasks}、解除指派 ${changes.summary.unassignedTasks}、预约平移 ${changes.summary.shiftedAppointments}`, actor);
  return { session, changes };
}

// ---------- 取消与失败恢复 ----------

export function cancelReplan(sessionId: string, actor = '中控调度员'): ReplanSession {
  const session = getSession(sessionId);
  if (session.status === 'confirmed') throw new ReplanError('SESSION_INVALID', '方案已确认应用，取消请走新一轮重排恢复');
  if (session.status === 'cancelled') throw new ReplanError('SESSION_INVALID', '该重排已经取消');

  if (session.status === 'failed') {
    if (session.recoverySnapshot) restoreSnapshot(session.recoverySnapshot);
    session.status = 'cancelled';
    session.recoverySnapshot = undefined;
    session.note = '批量更新失败后执行恢复，航次窗口、任务、预约与箱务已还原到重排前快照';
    recordAudit('REPLAN_ROLLBACK', session.id, session.note, actor);
    return session;
  }

  session.status = 'cancelled';
  session.note = '调度员取消重排，未写入任何窗口/任务变更，保持原计划';
  recordAudit('REPLAN_CANCEL', session.id, session.note, actor);
  return session;
}

// ---------- 重排进行中收到新 ETA ----------

export interface IngestEtaInput { eta?: string; etd?: string; reason: string; actor?: string }

export function ingestVoyageEta(voyageId: string, input: IngestEtaInput): { voyage: Voyage; superseded: string[]; session: ReplanSession } {
  const voyage = voyages.find(v => v.id === voyageId);
  if (!voyage || voyage.status === 'departed') throw new ReplanError('VOYAGE_NOT_PLANNABLE', '航次不存在或已离港');
  if ((input.eta && isNaN(at(input.eta))) || (input.etd && isNaN(at(input.etd)))) throw new ReplanError('INVALID_WINDOW', 'ETA/ETD 时间格式无效');
  if (input.eta && input.etd && at(input.etd) <= at(input.eta)) throw new ReplanError('INVALID_WINDOW', 'ETD 必须晚于 ETA');

  voyage.eta = input.eta ?? voyage.eta;
  voyage.etd = input.etd ?? voyage.etd;
  voyage.etaVersion += 1;
  recordAudit('VOY_ETA_UPDATE', voyage.id, `外部船期更新：${input.reason}；ETA 版本升至 ${voyage.etaVersion}`, input.actor ?? '船期接口', 'voyage');

  // 打开中的重排会话全部过期（options 基线已变），失败/已确认/已取消的不动；
  // 只处理基于更新前那一版 ETA 的会话，更早遗留的草稿本就已脱离当前基线
  const superseded: string[] = [];
  for (const session of sessions.values()) {
    if (session.voyageId !== voyageId || session.status !== 'draft') continue;
    if (session.baseEtaVersion !== voyage.etaVersion - 1) continue;
    session.status = 'stale';
    session.currentEtaVersion = voyage.etaVersion;
    session.note = `重排进行中收到新 ETA（${input.reason}），比较方案基于旧窗口，已作废`;
    superseded.push(session.id);
    recordAudit('REPLAN_STALE', session.id, session.note, input.actor ?? '船期接口');
  }

  const session = startReplan({ voyageId, targetEta: voyage.eta, targetEtd: voyage.etd, reason: input.reason, actor: input.actor ?? '船期接口' });
  return { voyage: { ...voyage }, superseded, session };
}
